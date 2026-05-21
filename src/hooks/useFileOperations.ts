import { useRef } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

/**
 * Rust 側 `write_pdf_chunk` コマンドを使って bytes を分割書き込みする。
 *
 * Tauri v2 の IPC binary 転送が 100MB 一発だと hang する事象を回避するため、
 * 4MB 単位でチャンクして invoke する。Rust 側は raw body (tauri::ipc::Request) を
 * 受けるため JSON シリアライズは発生しない。
 *
 * ベンチマーク結果 (純粋 fs::write): 99MB を ~500ms で書ける環境。
 * 本実装はチャンク毎の IPC ラウンドトリップ + 実 I/O で数秒で完了する想定。
 */
async function writeFileChunked(path: string, bytes: Uint8Array): Promise<void> {
  const CHUNK = 4 * 1024 * 1024; // 4MB
  const headerPath = encodeURIComponent(path);
  // bytes.byteLength === 0 の場合でも offset==0 で 1 回だけ呼び、
  // Rust 側 (offset==0 で create+truncate) に空ファイル生成を任せる。
  // for ループは bytes.byteLength === 0 だと一度も入らず、結果として
  // tempPath が作られないまま replace_pdf_file が呼ばれて無音失敗するため、
  // 空配列専用の単発 invoke で open/create を保証する。
  if (bytes.byteLength === 0) {
    await invoke('write_pdf_chunk', new ArrayBuffer(0), {
      headers: {
        'x-path': headerPath,
        'x-offset': '0',
      },
    });
    return;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.byteLength);
    // subarray はビューを返すだけ (copy しない)
    const chunk = bytes.subarray(offset, end);
    // subarray の buffer は元 bytes の buffer を指すため、byteOffset/byteLength を
    // 考慮した slice を取ってから .buffer を渡す (native IPC は ArrayBuffer を期待)。
    const body = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk.buffer
      : chunk.slice().buffer;
    await invoke('write_pdf_chunk', body, {
      headers: {
        'x-path': headerPath,
        'x-offset': String(offset),
      },
    });
  }
}

async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${path}.pecotool-${Date.now()}-${crypto.randomUUID()}.tmp`;
  await writeFileChunked(tempPath, bytes);
  await invoke('replace_pdf_file', { tempPath, targetPath: path });
}

/**
 * Rust 側エラーメッセージから「上書き不可」系の障害を検出する。
 * Windows では他プロセス (Acrobat 等) がファイルを掴んでいると EACCES/EBUSY/
 * ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) が返るため、
 * これらを「別名で保存」フォールバックの引き金にする。
 *
 * Rust 側は std::io::Error の英文メッセージや `os error 32` 番号を含む文字列を
 * 返してくる。コード番号 (os error 32) や英語フレーズの両方で検出できるように
 * 緩めの正規表現でマッチする。
 */
export function isWriteAccessError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('eacces') ||
    lower.includes('ebusy') ||
    lower.includes('access is denied') ||
    lower.includes('permission denied') ||
    lower.includes('being used by another process') ||
    lower.includes('sharing violation') ||
    lower.includes('lock violation') ||
    /os error (32|33)\b/.test(lower)
  );
}
/**
 * issue #115: 保存スナップショット前にフォーカス中の編集要素を blur する。
 *
 * OcrCard のテキスト編集は contentEditable の onBlur でのみ store にコミットされる
 * (毎打鍵 store write による再レンダリングを避けるための意図的な blur-commit 設計)。
 * Ctrl+S → handleSave がそのまま store をスナップショットすると、フォーカス中の
 * OcrCard の未コミット編集が store に無く、古いテキストで保存されてしまう。
 *
 * 保存処理の最初 (store 読み出し前) にこの関数を呼び、編集要素にフォーカスがあれば
 * .blur() する。React の onBlur は .blur() の同期実行中に走るため、OcrCard の
 * blur-commit (updatePageData = 同期 set()) はこの関数の return 前に store へ反映される。
 */
function blurActiveEditableElement(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  const tag = active.tagName;
  // contentEditable は IDL プロパティ isContentEditable と contenteditable 属性の
  // 両方で判定する。isContentEditable は祖先からの継承も拾えるが一部環境 (jsdom 等)
  // で未実装のため、属性値 ('' / 'true' / 'plaintext-only') も併せて確認する。
  const ceAttr = active.getAttribute('contenteditable');
  const isContentEditable =
    active.isContentEditable ||
    ceAttr === '' || ceAttr === 'true' || ceAttr === 'plaintext-only';
  const isEditable =
    isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA';
  if (isEditable) {
    active.blur();
  }
}

import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import {
  loadPDF,
  getAllTemporaryPageData,
  clearTemporaryChanges,
  getSharedPdfProxy,
  loadPage,
  loadPecoToolBBoxMeta,
} from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import type { SavePdfSource, SkippedPdfTextChar } from '../utils/pdfWorkerTypes';
import { formatFileSize } from '../utils/format';
import {
  disableSystemFontForSession,
  getPrimaryFontKind,
  loadBundledIpAmjFontLazy,
  loadFallbackFontsLazy,
  loadFontLazy,
} from './useFontLoader';
import { PecoDocument, PageData } from '../types';
import { perf } from '../utils/perfLogger';

/**
 * 1 ページ目 render 後 (アイドル時) に background で PDF 全体 bytes を取得して
 * モジュールレベルキャッシュ (originalBytesCache) に格納する。Ctrl+S 時は
 * 既にメモリ上にあるため pdf-lib 処理のみで保存完了できる (~1-3 秒)。
 *
 * 以前は pdfjs.getData() や asset.localhost URL への fetch 経由で bytes を取得して
 * いたが、いずれも WebView2 の Range キューを pdfjs / サムネ / OCR と奪い合い、
 * 画像や OCR の読込中に Ctrl+S すると getData() / fetch が永久停止する事象が
 * 発生していた。
 *
 * 本実装では Tauri の plugin-fs `readFile` を使って Rust 経由で直接ファイルを
 * 読み込む。asset.localhost 帯域とは完全に独立した IPC チャネルで転送されるため、
 * pdfjs 側の処理中でも干渉しない。
 *
 * issue #29: 100MB 級 PDF の bytes を zustand store に格納すると、
 * subscriber が増えるたびに structural compare の対象となり GC 圧と
 * メモリフラグメンテーションが問題化する。bytes は単なる I/O キャッシュで
 * UI から購読する必要がないため、モジュールレベル Map<filePath, Uint8Array> に
 * 切り出して store からは外す。
 *
 * 同時に複数の prefetch が走らないよう、ファイルパスをキーに in-flight Promise を
 * モジュールレベルで共有する。保存時 (_executeSave) も同じ Promise を await する
 * ことで、二重読み込みを防ぐ。
 */
const inflightPrefetches = new Map<string, Promise<Uint8Array | null>>();

// 100MB 級の bytes を保持する。直近 1 ファイル分だけ持つことでメモリを抑える
// (複数ファイル同時編集の UI は無く、ファイル切替時は前ファイルの bytes を
//  即座に破棄してよい)。
const originalBytesCache = new Map<string, Uint8Array>();
const MAX_CACHED_ORIGINAL_FILES = 1;

/**
 * 指定 filePath の originalBytes キャッシュをセットする。
 * 同時に MAX_CACHED_ORIGINAL_FILES を超えた古いエントリを破棄する。
 */
function setOriginalBytesCache(filePath: string, bytes: Uint8Array): void {
  // 既にあれば一旦消して LRU 順を更新 (Map の挿入順を活用)
  originalBytesCache.delete(filePath);
  originalBytesCache.set(filePath, bytes);
  while (originalBytesCache.size > MAX_CACHED_ORIGINAL_FILES) {
    const oldestKey = originalBytesCache.keys().next().value;
    if (oldestKey === undefined) break;
    originalBytesCache.delete(oldestKey);
  }
}

/**
 * テスト/デバッグ用にキャッシュへアクセスするヘルパ。
 * 本番コードからは呼ばないこと。
 */
export const __originalBytesCacheForTest = {
  get(filePath: string): Uint8Array | undefined {
    return originalBytesCache.get(filePath);
  },
  set(filePath: string, bytes: Uint8Array): void {
    setOriginalBytesCache(filePath, bytes);
  },
  clear(): void {
    originalBytesCache.clear();
  },
  size(): number {
    return originalBytesCache.size;
  },
};

function ensurePrefetchOriginalBytes(filePath: string): Promise<Uint8Array | null> {
  const existing = inflightPrefetches.get(filePath);
  if (existing) return existing;

  const cached = originalBytesCache.get(filePath);
  if (cached) {
    return Promise.resolve(cached);
  }

  const run = async (): Promise<Uint8Array | null> => {
    try {
      // Tauri plugin-fs は v2 で raw binary IPC を使用する。100MB 級でも
      // base64 エンコードのオーバーヘッドは掛からず、HTTP/asset 経路とも無干渉。
      const bytes = await readFile(filePath);
      // 古いエントリは setOriginalBytesCache 内で自動的に追い出される。
      setOriginalBytesCache(filePath, bytes);
      return bytes;
    } catch (e) {
      console.warn('[prefetchOriginalBytes] readFile failed:', e);
      return null;
    }
  };

  const task = run();
  inflightPrefetches.set(filePath, task);
  // run の外側で cleanup を掛けることで自己参照 (let task; task = ...) を回避
  task.finally(() => {
    if (inflightPrefetches.get(filePath) === task) {
      inflightPrefetches.delete(filePath);
    }
  });
  return task;
}

interface SaveResult {
  size: number;
  skippedChars: SkippedPdfTextChar[];
  /**
   * issue #115: 今回の保存スナップショットに含まれたページ index の集合。
   * 保存後の resetDirty にこれを渡すことで、保存中に編集された別ページの
   * isDirty フラグを巻き込んでクリアしないようにする。
   */
  savedPageIndices: Set<number>;
}

function formatSkippedCharWarning(skippedChars: SkippedPdfTextChar[]): string {
  // issue #115: どの文字が何回除外されたかを具体的に示す。
  // 印字可能文字は実体を、制御文字など不可視のものはコードポイントのみを表示し、
  // それぞれ除外回数 (count) を括弧で添える。
  const distinct = skippedChars.length;
  const totalCount = skippedChars.reduce((sum, item) => sum + item.count, 0);
  const sample = skippedChars.slice(0, 8).map((item) => {
    const isVisible = item.char >= ' ' && item.char.codePointAt(0) !== 0x7f;
    const label = isVisible ? `「${item.char}」(${item.codePoint})` : item.codePoint;
    return `${label}×${item.count}`;
  }).join('、');
  const suffix = distinct > 8 ? ` ほか${distinct - 8}種` : '';
  return `PDFテキスト層に埋め込めない文字を計${totalCount}個除外しました: ${sample}${suffix}`;
}

function formatSaveToast(prefix: string, size: number, skippedChars: SkippedPdfTextChar[]): string {
  const base = `${prefix}。(${formatFileSize(size)})`;
  if (skippedChars.length === 0) return base;
  return `${base} ${formatSkippedCharWarning(skippedChars)}`;
}

export function useFileOperations(
  showToast: (msg: string, isError?: boolean, action?: { label: string; onClick: () => void }) => void,
  setIsSaving?: (v: boolean) => void,
  setIsLoadingFile?: (v: boolean) => void,
  onOpenComplete?: (doc: import('../types').PecoDocument) => void,
  /**
   * issue #102: OCR 実行中の handleOpen ガード用。
   * App 側で useOcrEngine の isOcrRunning を ref 化して渡す。
   * folder OCR ループは内部で handleOpen を呼ぶため、bypassOcrGuard option で除外する。
   */
  isOcrRunningRef?: React.RefObject<boolean>,
) {
  const setDocument = usePecoStore((s) => s.setDocument);
  const setDocumentFilePath = usePecoStore((s) => s.setDocumentFilePath);
  const resetDirty = usePecoStore((s) => s.resetDirty);
  const isSavingRef = useRef(false);
  // executeSaveAs は下で定義されるため、_executeSave / handleSave から参照できるよう
  // ref で間接化する。issue #53: writeFileAtomically が EACCES/EBUSY で失敗したときに
  // showToast の action ボタンから「別名で保存」へフォールバックさせるのに使う。
  const executeSaveAsRef = useRef<(() => Promise<void>) | null>(null);

  // localStorage 上の peco-recent-files を string[] として読み出す。
  // 改ざん・型不整合・壊れた JSON は全て空配列にフォールバックする。
  // issue #37: 以前は sessionStorage に保存していたが、アプリ再起動で
  // 必ず空になり「最近開いたファイル」機能が事実上機能していなかった。
  // localStorage に切り替えて永続化する。
  const readRecent = (): string[] => {
    const saved = localStorage.getItem('peco-recent-files');
    if (!saved) return [];
    try {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return parsed;
      }
    } catch {
      // 不正 JSON は無視
    }
    return [];
  };

  // issue #21: localStorage.setItem は quota / プライベートモードで QuotaExceededError を投げる。
  // 開いている PDF とは無関係のエラーなのでユーザー向けにはサイレント、ログだけ残す。
  const safeWriteRecent = (next: string[]) => {
    try {
      localStorage.setItem('peco-recent-files', JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('peco-recent-files-updated'));
    } catch (e) {
      console.warn('[useFileOperations] recent-files storage write failed:', e);
    }
  };

  const addToRecent = (path: string) => {
    // issue #37: アプリ再起動後も履歴を残すため localStorage に保存する。
    // ファイルフルパスは機密性があるため、最大件数を 10 件に抑える。
    const recent = [path, ...readRecent().filter((p) => p !== path)].slice(0, 10);
    safeWriteRecent(recent);
  };

  // Recent Files から指定パスを除去する。読み込み失敗時の自動クリーンアップで使用。
  // useRecentFiles 側は peco-recent-files-updated を listen しているため即座に UI 反映される。
  const removeFromRecent = (path: string) => {
    const current = readRecent();
    const next = current.filter((p) => p !== path);
    if (next.length === current.length) return; // 変化なしなら storage 書き込みもイベントも発火しない
    safeWriteRecent(next);
  };

  const handleOpen = async (
    explicitPath?: string,
    opts?: { bypassOcrGuard?: boolean },
  ): Promise<boolean> => {
    perf.mark('open.start', { explicit: !!explicitPath });
    try {
      if (isSavingRef.current) {
        showToast("保存中はPDFを開けません。");
        return false;
      }
      // issue #102: OCR 実行中の Open は古い doc 参照で新ドキュメントへの汚染を起こす。
      // folder OCR ループは bypassOcrGuard で素通しさせる (内部から再入するため)。
      if (isOcrRunningRef?.current && !opts?.bypassOcrGuard) {
        showToast('OCR実行中はPDFを開けません。');
        return false;
      }

      const current = usePecoStore.getState();
      const hasDirtyPages = Array.from(current.document?.pages.values() || []).some((p) => p.isDirty);
      if (current.document && (current.isDirty || hasDirtyPages)) {
        const confirmed = await ask('未保存の変更があります。別のPDFを開きますか？', {
          title: '開く確認',
          kind: 'warning',
        });
        if (!confirmed) return false;
      }

      let selected = explicitPath;
      if (!selected) {
        selected = await open({
          multiple: false,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }) as string;
      }

      if (selected && typeof selected === 'string') {
        setIsLoadingFile?.(true);

        try {
          // URL (asset protocol) で直接 pdfjs に開かせる。初回ページは Range fetch で
          // 数 MB だけ取ってくるので瞬時に表示される。prefetch 廃止済みのため
          // WebView2 の Range 6 本キューイング問題も発生しない。
          // Tauri v2 の IPC 経由で 100MB 級のバイナリを転送すると ~700KB/s しか出ない
          // ため、bytes 直接渡し経路は廃止した (fastReadFile も含む)。
          perf.mark('open.loadPdfStart');
          const doc = await loadPDF(selected);
          perf.mark('open.loadPdfDone', { totalPages: doc.totalPages });
          setDocument(doc);
          perf.mark('open.setDoc');
          addToRecent(selected);
          onOpenComplete?.(doc);
        } finally {
          setIsLoadingFile?.(false);
        }

        // サムネ初回描画との帯域競合を避けるため、アイドル時間に暖機（保存時は await で再利用）
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => { loadFontLazy(); }, { timeout: 3000 });
        } else {
          setTimeout(() => { loadFontLazy(); }, 1000);
        }

        // 1 ページ目 render / サムネ等が落ち着いた頃合い (~2s) に background で
        // PDF bytes を取得して originalBytes にキャッシュする。Ctrl+S 時に
        // pdf-lib 処理だけで完了できるようにするための先読み。
        // Tauri 側のネットワークは競合しないが、サムネ生成と同時発火させると
        // WebView2 の帯域を食い合うため少し遅らせる。
        setTimeout(() => { void ensurePrefetchOriginalBytes(selected!); }, 2000);

        return true;
      }
      return false;
    } catch (err) {
      console.error("Failed to open file:", err);
      // Recent Files (explicitPath あり) 経由で開いた時に読み込みが失敗したら、
      // 削除/移動済みファイルが履歴に残り続けて選択するたびにエラーになる現象を防ぐため
      // sessionStorage から該当パスを除去 + peco-recent-files-updated イベントを発火する。
      if (explicitPath) {
        try {
          removeFromRecent(explicitPath);
        } catch (cleanupErr) {
          console.warn('[handleOpen] removeFromRecent failed (ignored):', cleanupErr);
        }
      }
      showToast("ファイルの読み込みに失敗しました。", true);
      setIsLoadingFile?.(false);
      return false;
    }
  };

  /**
   * 指定 Promise に個別 timeout をかけ、失敗時は label 付きエラーで reject する。
   * 保存経路のどこで停止したかを明確にするためのヘルパ。
   * 成功時は経過時間を console.log で記録する。
   */
  const withStep = async <T,>(label: string, ms: number, op: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    console.log(`[save] ▶ ${label}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[save:${label}] タイムアウト (${ms}ms)`)), ms);
    });
    try {
      const result = await Promise.race([op(), timeoutPromise]);
      console.log(`[save] ✓ ${label} (${Math.round(performance.now() - started)}ms)`);
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  /**
   * 保存の共通処理。originalBytes の待機 → IDB マージ → PDF 生成 → ファイル書き込みを行う。
   * 各 await は個別 timeout で囲み、詰まった段階をトースト/コンソールで特定できるようにする。
   * @param targetPath 書き込み先パス。省略時は document.filePath に上書き保存。
   * @returns 保存結果。失敗時は null。
   */
  const _executeSave = async (targetPath?: string): Promise<SaveResult | null> => {
    const { document } = usePecoStore.getState();
    if (!document) return null;
    const sourceFilePath = document.filePath;

    let cachedBytes = originalBytesCache.get(sourceFilePath);
    if (!cachedBytes) {
      showToast("保存用にファイルを読み込み中...");
      const fetched = await withStep('readFile', 90_000, () => ensurePrefetchOriginalBytes(sourceFilePath));
      if (!fetched) {
        showToast("元 PDF の読み込みに失敗しました。", true);
        return null;
      }
      cachedBytes = fetched;
    }
    const saveSource: SavePdfSource = { bytes: cachedBytes };

    const fontBytes = await withStep('loadFont', 15_000, () => loadFontLazy());
    if (!fontBytes) {
      showToast("日本語フォントの読み込みに失敗しました。再度お試しください。", true);
      return null;
    }
    const fallbackFontBytes = await withStep('loadFallbackFonts', 15_000, () => loadFallbackFontsLazy());
    if (!fallbackFontBytes) {
      showToast("記号フォントの読み込みに失敗しました。再度お試しください。", true);
      return null;
    }

    // LRU退避のIDB書き込みが全て完了してからIDBを読み込む（競合状態回避）
    await withStep('waitIdbSaves', 15_000, () => waitForPendingIdbSaves());

    // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
    const tempDirtyPages = await withStep(
      'readIdbDirty',
      15_000,
      () => getAllTemporaryPageData(sourceFilePath),
    );

    const mergedPages = new Map<number, PageData>(document.pages);
    for (const [idx, data] of tempDirtyPages.entries()) {
      const existing = mergedPages.get(idx);
      mergedPages.set(idx, existing ? { ...existing, ...data } : (data as PageData));
    }

    // Dirty ページのみを Worker に渡すことで postMessage の structured clone コストを
    // 400ページ分 → 変更ページ数分 に削減する（最重要パフォーマンス修正）。
    // Worker 内で既存 BBoxMeta を PDF から読み直して非 dirty ページ分を保持するため、
    // dirty-only フィルタリングをしてもメタデータの欠損は発生しない。
    const dirtyOnlyPages = new Map<number, PageData>(
      [...mergedPages.entries()].filter(([, p]) => p.isDirty)
    );
    if (dirtyOnlyPages.size === 0) {
      await withStep('loadRepairPages', 300_000, async () => {
        const pdf = await getSharedPdfProxy(sourceFilePath);
        const bboxMeta = await loadPecoToolBBoxMeta(pdf).catch(() => null);
        for (let pageIndex = 0; pageIndex < document.totalPages; pageIndex++) {
          const pageData = await loadPage(pdf, pageIndex, sourceFilePath, bboxMeta, document.mtime);
          dirtyOnlyPages.set(pageIndex, { ...pageData, isDirty: true });
        }
      });
    }
    const mergedDoc: PecoDocument = { ...document, pages: dirtyOnlyPages };
    let skippedChars: SkippedPdfTextChar[] = [];
    const runSavePdf = (primaryFontBytes: ArrayBuffer, fallbackFonts: ArrayBuffer[]) =>
      savePDF(saveSource, mergedDoc, primaryFontBytes, fallbackFonts, (chars) => { skippedChars = chars; });
    let savedBytes: Uint8Array;
    try {
      savedBytes = await withStep('savePDF', 150_000, () => runSavePdf(fontBytes, fallbackFontBytes));
    } catch (err) {
      if (getPrimaryFontKind() !== 'meiryo') throw err;

      console.warn('[save] Meiryo save failed; retrying with bundled IPAmjMincho:', err);
      disableSystemFontForSession();
      const retryFontBytes = await withStep('loadBundledFontRetry', 15_000, () => loadBundledIpAmjFontLazy());
      if (!retryFontBytes) throw err;
      const retryFallbackFontBytes = await withStep('loadFallbackFontsRetry', 15_000, () => loadFallbackFontsLazy());
      if (!retryFallbackFontBytes) throw err;

      skippedChars = [];
      savedBytes = await withStep('savePDFRetry', 150_000, () => runSavePdf(retryFontBytes, retryFallbackFontBytes));
    }
    if (skippedChars.length > 0) {
      console.warn('[save] Skipped PDF text-layer chars:', skippedChars);
    }
    const writePath = targetPath ?? document.filePath;

    await withStep('writeFile', 180_000, () => writeFileAtomically(writePath, savedBytes));
    const liveDoc = usePecoStore.getState().document;
    if (!liveDoc || liveDoc.filePath !== sourceFilePath) {
      throw new Error('保存中に別のPDFへ切り替わったため、状態反映を中止しました。');
    }
    // 次回保存時もこの累積変更をベースにするようにキャッシュを更新する。
    // 上書き保存先 (writePath) を最新のオリジナルとみなしてキャッシュへ入れる。
    setOriginalBytesCache(writePath, savedBytes);
    // LRU退避ページの IDB エントリも保存完了済みとしてクリア。失敗しても保存は成功扱い。
    await withStep('clearIdbDirty', 10_000, () => clearTemporaryChanges(sourceFilePath))
      .catch((e) => { console.warn('[save] clearIdbDirty failed (ignored):', e); });
    // issue #115: 今回保存に載ったページ index (dirtyOnlyPages のキー = 通常の dirty
    // フィルタ分 + repair 分岐で追加した全ページ分) を返す。呼び出し側は保存後の
    // resetDirty にこれを渡し、保存中に編集された別ページの dirty を巻き込まない。
    return {
      size: savedBytes.length,
      skippedChars,
      savedPageIndices: new Set(dirtyOnlyPages.keys()),
    };
  };

  /**
   * Ctrl+S 経路と「フォルダ OCR の自動上書き保存」(#48) の共通エントリ。
   * - 成功時: true
   * - 失敗 / アボート (PDF 未オープン、保存中ロック、_executeSave が null、例外) は false
   *
   * フォルダ OCR ループは false を見て即時中止できる。
   */
  const handleSave = async (): Promise<boolean> => {
    // Ctrl+S が届いていることを可視化するため、開始時に必ずトースト表示。
    // リリースビルドでは console.log が見えないため UI で進行状況を確認する。
    console.log('[save] handleSave invoked');
    perf.mark('ui.save');
    // issue #115: store スナップショット前にフォーカス中の編集要素を blur し、
    // OcrCard の未コミット編集 (blur-commit 設計) を store へ確定させる。
    // .blur() 中に React の onBlur → updatePageData (同期 set) が走るため、
    // 直後の getState() / _executeSave のスナップショットに最新編集が載る。
    blurActiveEditableElement();
    const { document } = usePecoStore.getState();
    if (!document) {
      showToast("PDFが開かれていません。", true);
      return false;
    }

    if (isSavingRef.current) {
      showToast("保存処理が進行中です。");
      return false;
    }

    isSavingRef.current = true;
    setIsSaving?.(true);
    showToast("保存処理を開始しました...");
    try {
      const result = await _executeSave();
      if (result !== null) {
        // issue #115: 保存に載ったページだけ dirty を下ろす。保存中に編集された
        // 別ページの isDirty は保持され、次回保存の dirty フィルタに正しく載る。
        resetDirty(result.savedPageIndices);
        showToast(formatSaveToast('保存しました', result.size, result.skippedChars));
        // 正常保存後はバックアップファイルを削除する（fire-and-forget）
        invoke('clear_backup', { filePath: document.filePath }).catch(() => {});
        return true;
      }
      return false;
    } catch (err) {
      console.error("Failed to save:", err);
      const msg = err instanceof Error ? err.message : String(err);
      // issue #53: 他プロセスが PDF を掴んでいる (Acrobat 等) と EACCES/EBUSY/
      // sharing violation で書き込み失敗する。この場合は別名で保存する以外に
      // ユーザーの取れる手段が無いため、フォールバックの導線をトーストに直接出す。
      if (isWriteAccessError(msg)) {
        showToast(
          `保存先のファイルを開けません (別プロセスがロック中の可能性): ${msg}`,
          true,
          {
            label: '別名で保存',
            onClick: () => {
              void executeSaveAsRef.current?.();
            },
          },
        );
      } else {
        showToast(`保存に失敗しました: ${msg}`, true);
      }
      return false;
    } finally {
      isSavingRef.current = false;
      setIsSaving?.(false);
    }
  };

  const executeSaveAs = async () => {
    const { document } = usePecoStore.getState();
    if (!document) return;
    if (isSavingRef.current) {
      showToast("保存処理が進行中です。");
      return;
    }

    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path && typeof path === 'string') {
        isSavingRef.current = true;
        setIsSaving?.(true);
        try {
          // issue #115: _executeSave が store をスナップショットする直前に
          // フォーカス中の編集要素を blur し、未コミット編集を確定させる。
          // (save ダイアログ表示中の編集にも対応するためここで呼ぶ)
          blurActiveEditableElement();
          const result = await _executeSave(path);
          if (result !== null) {
            const currentDoc = usePecoStore.getState().document;
            if (!currentDoc || currentDoc.filePath !== document.filePath) {
              throw new Error('保存中に別のPDFへ切り替わったため、状態反映を中止しました。');
            }
            const prevPath = currentDoc.filePath;
            setDocumentFilePath(path);
            // issue #115: 別名保存でも保存に載ったページだけ dirty を下ろす。
            resetDirty(result.savedPageIndices);
            showToast(formatSaveToast('名前を付けて保存しました', result.size, result.skippedChars));
            addToRecent(path);
            // 元のパスのバックアップも新しいパスのバックアップも削除する
            if (prevPath) invoke('clear_backup', { filePath: prevPath }).catch(() => {});
            invoke('clear_backup', { filePath: path }).catch(() => {});
          }
        } finally {
          isSavingRef.current = false;
          setIsSaving?.(false);
        }
      }
    } catch (err) {
      console.error("Failed to save as:", err);
      showToast("名前を付けて保存に失敗しました。", true);
    }
  };

  // handleSave 内のエラーフォールバックから executeSaveAs を呼び出せるように
  // ref へ最新参照を入れる (関数定義順の循環参照を回避する目的)。
  executeSaveAsRef.current = executeSaveAs;

  return { handleOpen, handleSave, executeSaveAs };
}
