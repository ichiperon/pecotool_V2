import { useRef } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { writeFileAtomically, isWriteAccessError } from '../utils/tauriFileIO';

export { isWriteAccessError };

import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { resolveDisplayIndex, resolvePageId } from '../utils/pageOrder';
import {
  loadPDF,
  getAllTemporaryPageData,
  clearTemporaryChanges,
  clearTemporaryChangesForPages,
  clearCachedPages,
  destroySharedPdfProxy,
} from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import type { SavePdfSource, SkippedPdfTextChar } from '../utils/pdfWorkerTypes';
import { formatFileSize } from '../utils/format';
import { invalidateBBoxMetaCache } from '../utils/pdfMetadataLoader';
import {
  disableSystemFontForSession,
  getPrimaryFontKind,
  loadBundledIpAmjFontLazy,
  loadFallbackFontsLazy,
  loadFontLazy,
} from './useFontLoader';
import { PecoDocument, PageData } from '../types';
import { perf } from '../utils/perfLogger';
import { commitActiveOcrCardEdit } from '../utils/ocrCardCommit';
import { computeSaveDiff } from '../utils/saveDiffSummary';
import type { SaveDiffSummary } from '../utils/saveDiffSummary';

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
type OriginalBytesFingerprint = {
  mtimeMs?: number;
  size?: number;
};

type OriginalBytesCacheEntry = {
  bytes: Uint8Array;
  fingerprint?: OriginalBytesFingerprint;
};

const originalBytesCache = new Map<string, OriginalBytesCacheEntry>();
const MAX_CACHED_ORIGINAL_FILES = 1;

function normalizeStatNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeStatMtime(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return normalizeStatNumber(value);
}

async function readOriginalBytesFingerprint(filePath: string): Promise<OriginalBytesFingerprint | undefined> {
  try {
    const fileStat = await stat(filePath);
    const statLike = fileStat as { mtime?: unknown; size?: unknown };
    const fingerprint: OriginalBytesFingerprint = {
      mtimeMs: normalizeStatMtime(statLike.mtime),
      size: normalizeStatNumber(statLike.size),
    };
    return fingerprint.mtimeMs === undefined && fingerprint.size === undefined
      ? undefined
      : fingerprint;
  } catch (e) {
    console.warn('[originalBytesCache] stat failed:', e);
    return undefined;
  }
}

function fingerprintMatches(
  cached: OriginalBytesFingerprint | undefined,
  current: OriginalBytesFingerprint | undefined,
): boolean {
  if (cached && !current) return false;
  if (!cached || !current) return true;
  if (cached.mtimeMs !== undefined && current.mtimeMs !== undefined && cached.mtimeMs !== current.mtimeMs) {
    return false;
  }
  if (cached.size !== undefined && current.size !== undefined && cached.size !== current.size) {
    return false;
  }
  return true;
}

/**
 * 指定 filePath の originalBytes キャッシュをセットする。
 * 同時に MAX_CACHED_ORIGINAL_FILES を超えた古いエントリを破棄する。
 */
function setOriginalBytesCache(
  filePath: string,
  bytes: Uint8Array,
  fingerprint?: OriginalBytesFingerprint,
): void {
  // 既にあれば一旦消して LRU 順を更新 (Map の挿入順を活用)
  originalBytesCache.delete(filePath);
  originalBytesCache.set(filePath, { bytes, fingerprint });
  while (originalBytesCache.size > MAX_CACHED_ORIGINAL_FILES) {
    const oldestKey = originalBytesCache.keys().next().value;
    if (oldestKey === undefined) break;
    originalBytesCache.delete(oldestKey);
  }
}

async function getFreshOriginalBytesCache(filePath: string): Promise<Uint8Array | undefined> {
  const entry = originalBytesCache.get(filePath);
  if (!entry) return undefined;

  const currentFingerprint = await readOriginalBytesFingerprint(filePath);
  if (fingerprintMatches(entry.fingerprint, currentFingerprint)) return entry.bytes;

  originalBytesCache.delete(filePath);
  return undefined;
}

/**
 * テスト/デバッグ用にキャッシュへアクセスするヘルパ。
 * 本番コードからは呼ばないこと。
 */
export const __originalBytesCacheForTest = {
  get(filePath: string): Uint8Array | undefined {
    return originalBytesCache.get(filePath)?.bytes;
  },
  set(filePath: string, bytes: Uint8Array, fingerprint?: OriginalBytesFingerprint): void {
    setOriginalBytesCache(filePath, bytes, fingerprint);
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

  const run = async (): Promise<Uint8Array | null> => {
    const cached = await getFreshOriginalBytesCache(filePath);
    if (cached) return cached;

    try {
      // Tauri plugin-fs は v2 で raw binary IPC を使用する。100MB 級でも
      // base64 エンコードのオーバーヘッドは掛からず、HTTP/asset 経路とも無干渉。
      const bytes = await readFile(filePath);
      // 古いエントリは setOriginalBytesCache 内で自動的に追い出される。
      setOriginalBytesCache(filePath, bytes, await readOriginalBytesFingerprint(filePath));
      return bytes;
    } catch (e) {
      console.warn('[prefetchOriginalBytes] readFile failed:', e);
      return null;
    }
  };

  const task = run();
  inflightPrefetches.set(filePath, task);
  // run の外側で cleanup を掛けることで自己参照 (let task; task = ...) を回避
  void task.finally(() => {
    if (inflightPrefetches.get(filePath) === task) {
      inflightPrefetches.delete(filePath);
    }
  }).catch(() => {});
  return task;
}

interface SaveResult {
  size: number;
  skippedChars: SkippedPdfTextChar[];
  savedActionIndex: number;
  hasPostSnapshotChanges: boolean;
  /**
   * issue #115 / #119: 今回の保存スナップショットに含まれたページの
   * pageIndex → PageData オブジェクト参照の Map。保存後の resetDirty に渡すと、
   * 保存中に編集された (= オブジェクト参照が変わった) ページの isDirty を
   * 巻き込んでクリアしないようにできる。
   */
  savedPageSnapshots: Map<number, PageData>;
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

/** issue #164: 保存ロック画面に現在進行中のステップを表示するためのフェーズ識別子。 */
export type SaveStep = 'changes' | 'pdf-gen' | 'safe-replace' | null;

/**
 * issue #197: 別名で保存ダイアログで選択した圧縮オプション。
 * SaveDialog.tsx の onConfirm と一致するシグネチャ。
 * actual compression/rasterization は別 issue で実装予定 (現状は無視される)。
 */
export interface SaveDialogOptions {
  compression: 'none' | 'compressed' | 'rasterized';
  rasterizeQuality?: number;
}

type SaveInvocationOptions = {
  bypassOcrGuard?: boolean;
};

type ExecuteSaveOptions = {
  normalizePageOrderForCurrentDocument?: boolean;
};

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
  /**
   * issue #164: 保存中ロック画面に現在ステップを表示するためのコールバック。
   * _executeSave のフェーズ遷移ごとに呼ばれる。null は「保存していない / 終了」を意味する。
   */
  setSaveStep?: (step: SaveStep) => void,
  /**
   * issue #197: EACCES 系エラー時の「別名で保存」トーストから SaveDialog を開くコールバック。
   * undefined のときは従来通り executeSaveAs を直接呼ぶ (後方互換)。
   */
  onRequestSaveDialog?: () => void,
  /**
   * issue #201: 保存前 diff プレビューを表示するコールバック。
   * summary を受け取り、ユーザーが「保存する」を選んだ場合 resolve(true)、
   * 「キャンセル」を選んだ場合 resolve(false) を返す Promise を返す。
   * undefined の場合はプレビューをスキップして直接保存する (後方互換)。
   */
  onRequestDiffPreview?: (summary: SaveDiffSummary) => Promise<boolean>,
) {
  const setDocument = usePecoStore((s) => s.setDocument);
  const setDocumentFilePath = usePecoStore((s) => s.setDocumentFilePath);
  const resetDirty = usePecoStore((s) => s.resetDirty);
  const setLastSavedActionIndex = usePecoStore((s) => s.setLastSavedActionIndex);
  const isSavingRef = useRef(false);
  // PCT-074: handleOpen のファイル読込中フラグ。App 側の isLoadingFile state は
  // setIsLoadingFile callback で更新するだけでこの hook からは読めないため、
  // handleSave の「読込中は保存拒否」ガード用に ref でも保持する。
  const isLoadingFileRef = useRef(false);
  // executeSaveAs は下で定義されるため、_executeSave / handleSave から参照できるよう
  // ref で間接化する。issue #53: writeFileAtomically が EACCES/EBUSY で失敗したときに
  // showToast の action ボタンから「別名で保存」へフォールバックさせるのに使う。
  // issue #197: SaveDialogOptions を受け取れるよう型拡張 (呼び出し元は undefined でも可)。
  const executeSaveAsRef = useRef<((options?: SaveDialogOptions) => Promise<void>) | null>(null);

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
    opts?: {
      bypassOcrGuard?: boolean;
      /**
       * PCT-076: true のとき、読み込み完了後の onOpenComplete (App 側で
       * checkAndPromptOcrZero に配線) を呼ばない。バッチジョブの機械的な
       * オープンで OCR ゼロ検出ダイアログが出ると、バッチ OCR 実行中に
       * テキスト層取り込みが同一ページ群へ並行書き込みして混在保存になるため。
       */
      suppressOcrZeroPrompt?: boolean;
    },
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
      let discardTemporaryChangesFilePath: string | null = null;
      const hasDirtyPages = Array.from(current.document?.pages.values() || []).some((p) => p.isDirty);
      if (current.document && (current.isDirty || hasDirtyPages)) {
        const confirmed = await ask('未保存の変更があります。別のPDFを開きますか？', {
          title: '開く確認',
          kind: 'warning',
        });
        if (!confirmed) return false;
        discardTemporaryChangesFilePath = current.document.filePath || null;
        if (isSavingRef.current) {
          showToast("保存中はPDFを開けません。");
          return false;
        }
      }

      let selected = explicitPath;
      if (!selected) {
        selected = await open({
          multiple: false,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }) as string;
      }

      if (selected && typeof selected === 'string') {
        if (isSavingRef.current) {
          showToast("保存中はPDFを開けません。");
          return false;
        }
        isLoadingFileRef.current = true;
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
          // PCT-074: loadPDF の await 中 (大型 PDF では数秒〜数十秒) に保存が開始
          // されていたら読み込みを中止する。このまま続行すると、直後の
          // clearTemporaryChanges / setDocument が保存処理の IDB 回収 (readIdbDirty)
          // や状態反映と交差し、退避 dirty ページが欠落したまま上書き保存される。
          // 保存完了を待つ手段 (保存完了 Promise の追跡) は無いため安全側で中断する。
          // 中断後も store の document は旧ファイルのままなので表示は壊れない
          // (共有 pdfjs proxy は次の描画要求時に旧ファイルで再取得される。
          //  これは直下の「未保存変更を破棄できませんでした」失敗経路と同じ扱い)。
          if (isSavingRef.current) {
            showToast('保存中のため読み込みを中止しました。保存完了後に再度開いてください。');
            return false;
          }
          if (discardTemporaryChangesFilePath) {
            try {
              await waitForPendingIdbSaves();
              await clearTemporaryChanges(discardTemporaryChangesFilePath);
            } catch (e) {
              console.warn('[handleOpen] discard temporary changes failed:', e);
              showToast('未保存の変更を破棄できませんでした。', true);
              return false;
            }
          }
          await clearCachedPages(selected);
          setDocument(doc);
          perf.mark('open.setDoc');
          addToRecent(selected);
          // PCT-076: バッチジョブ等の機械的なオープンでは OCR ゼロ検出プロンプト
          // (onOpenComplete 経由の checkAndPromptOcrZero) を発火させない。
          if (!opts?.suppressOcrZeroPrompt) {
            onOpenComplete?.(doc);
          }
        } finally {
          isLoadingFileRef.current = false;
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
      isLoadingFileRef.current = false;
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
   * @param saveOptions 圧縮プリセット等の保存オプション。省略時はデフォルト挙動。
   * @param executeOptions 保存完了後に現在のセッションへ反映する状態更新オプション。
   * @returns 保存結果。失敗時は null。
   */
  const _executeSave = async (
    targetPath?: string,
    saveOptions?: SaveDialogOptions,
    executeOptions: ExecuteSaveOptions = {},
  ): Promise<SaveResult | null> => {
    const saveSnapshot = usePecoStore.getState();
    const { document } = saveSnapshot;
    if (!document) return null;
    const savePageOrder = [...saveSnapshot.pageOrder];
    const savedActionIndex = saveSnapshot.undoStack.length;
    const sourceFilePath = document.filePath;

    // issue #164: 保存ロック画面の進捗ステップ通知。
    setSaveStep?.('changes');
    let cachedBytes = await withStep('statOriginalBytes', 10_000, () => getFreshOriginalBytesCache(sourceFilePath));
    if (!cachedBytes) {
      showToast("保存用にファイルを読み込み中...");
      const fetched = await withStep('readFile', 90_000, () => ensurePrefetchOriginalBytes(sourceFilePath));
      if (!fetched) {
        // R04D-3: 原因の仮説と次アクションを案内する。
        showToast("元のPDFファイルが移動または削除された可能性があります。ファイルを再度開き直してください。", true);
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

    // PCT-068: メモリ在ページは IDB エントリで上書きしない (メモリ優先)。
    // loadPage は LRU 退避ページを復元しても IDB エントリを消さないため、
    // 「退避 → 復元 → 再編集 → 保存」で古い IDB エントリが新しい編集を
    // 巻き戻す事故が起きていた。IDB へ書く全経路 (LRU 退避 / undo・redo
    // write-through / clearOcrAllPages) は「メモリと同値」か「メモリから
    // 消えたページのみ」を書くため、メモリ在ページは常にメモリが最新。
    //
    // PCT-104 (A-lite 段階2): tempDirtyPages は Map<pageId, Partial<PageData>> を返す。
    // S-02 不変条件: resolveDisplayIndex で displayIndex に変換してから mergedPages に積む。
    const mergedPages = new Map<number, PageData>(document.pages);
    {
      const pageOrder = usePecoStore.getState().pageOrder;
      for (const [pageId, data] of tempDirtyPages.entries()) {
        const display = resolveDisplayIndex(pageOrder, pageId);
        if (display < 0) continue;
        if (!mergedPages.has(display)) {
          mergedPages.set(display, data as PageData);
        }
      }
    }

    // Dirty ページのみを Worker に渡すことで postMessage の structured clone コストを
    // 400ページ分 → 変更ページ数分 に削減する（最重要パフォーマンス修正）。
    // Worker 内で既存 BBoxMeta を PDF から読み直して非 dirty ページ分を保持するため、
    // dirty-only フィルタリングをしてもメタデータの欠損は発生しない。
    const dirtyOnlyPages = new Map<number, PageData>(
      [...mergedPages.entries()].filter(([, p]) => p.isDirty)
    );
    const savedPageSnapshots = new Map<number, PageData>();
    for (const [idx] of dirtyOnlyPages.entries()) {
      const snapshotPage = document.pages.get(idx);
      if (snapshotPage) savedPageSnapshots.set(idx, snapshotPage);
    }
    const mergedDoc: PecoDocument = { ...document, pages: dirtyOnlyPages };
    let skippedChars: SkippedPdfTextChar[] = [];
    const runSavePdf = (primaryFontBytes: ArrayBuffer, fallbackFonts: ArrayBuffer[]) =>
      savePDF(saveSource, mergedDoc, primaryFontBytes, fallbackFonts, (chars) => { skippedChars = chars; }, savePageOrder, saveOptions);
    let savedBytes: Uint8Array;
    // issue #164: PDF生成フェーズに遷移
    setSaveStep?.('pdf-gen');
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

    // issue #164: 安全置換フェーズに遷移
    setSaveStep?.('safe-replace');
    await withStep('writeFile', 180_000, () => writeFileAtomically(writePath, savedBytes));
    await withStep('clearPageCache', 10_000, () => clearCachedPages(writePath))
      .catch((e) => { console.warn('[save] clearPageCache failed (ignored):', e); });
    // replace_pdf_file でディスク上の PDF バイト列が差し替わったため、それを開いていた
    // pdfjs の共有 proxy / bitmap キャッシュ / ページ proxy キャッシュは全て stale。
    // destroySharedPdfProxy はこれら 3 つを破棄するが、これだけでは React 層が
    // 再 render しないため、保存前にレンダリング済みのページ画像はそのまま固着し、
    // 以降の zoom 変更で再ラスタライズされない (issue #118)。
    destroySharedPdfProxy();
    // PCT-103 / PCT-101: ディスク上の PDF バイト列が差し替わったため、
    // 保存前メタを返す stale キャッシュを明示破棄する。
    // clearCachedPages / destroySharedPdfProxy と同じ「ディスク差し替え後の stale 破棄」規約に参加。
    invalidateBBoxMetaCache();
    const liveStateBeforeNormalize = usePecoStore.getState();
    const liveDoc = liveStateBeforeNormalize.document;
    if (!liveDoc || liveDoc.filePath !== sourceFilePath) {
      throw new Error('保存中に別のPDFへ切り替わったため、状態反映を中止しました。');
    }
    const pageOrderMatchesSnapshot =
      liveStateBeforeNormalize.pageOrder.length === savePageOrder.length &&
      liveStateBeforeNormalize.pageOrder.every((sourceIndex, displayIndex) => sourceIndex === savePageOrder[displayIndex]);
    const hasPostSnapshotChanges =
      !pageOrderMatchesSnapshot || liveStateBeforeNormalize.undoStack.length > savedActionIndex;
    if (executeOptions.normalizePageOrderForCurrentDocument !== false) {
      liveStateBeforeNormalize.normalizePageOrderAfterSave(savePageOrder);
    }
    // issue #118: documentEpoch を +1 して usePageNavigation / usePdfRendering に
    // 「pdfjs proxy を取り直して現在ページ画像を再 render せよ」と通知する。
    // setDocument と違い textBlocks / BB / dirty / undo・redo / currentPageIndex /
    // zoom は一切変えないため、編集内容・スクロール位置・ズーム倍率は保持される。
    // 別名保存 (writePath が新パス) は呼び出し側で setDocumentFilePath が filePath を
    // 変えることでも reload が走るが、上書き保存は filePath が不変なので epoch bump が
    // 唯一の再 render トリガーになる。
    usePecoStore.getState().bumpDocumentEpoch();
    // 次回保存時もこの累積変更をベースにするようにキャッシュを更新する。
    // 上書き保存先 (writePath) を最新のオリジナルとみなしてキャッシュへ入れる。
    setOriginalBytesCache(writePath, savedBytes, await readOriginalBytesFingerprint(writePath));
    // PCT-050: savePDF の実行中にユーザーが別ページを編集すると、LRU パージで
    // 新たな saveTemporaryPageDataBatch が pendingIdbSaves へ追加される場合がある。
    // IDB クリアの直前に再度待機し、それらの書き込みが完了してからクリアする。
    await withStep('waitIdbSavesBeforeClear', 15_000, () => waitForPendingIdbSaves())
      .catch((e) => { console.warn('[save] waitIdbSavesBeforeClear failed (ignored):', e); });
    // PCT-070: 保存スナップショットで実際に回収したページ (dirtyOnlyPages) の
    // IDB エントリのみクリアする。ファイル単位の全削除 (clearTemporaryChanges) だと、
    // スナップショット後に退避された別ページの未保存編集まで巻き込んで消えるため。
    // 失敗しても保存は成功扱い。
    // PCT-104 (A-lite 段階2): clearTemporaryChangesForPages は string[] (pageId) を受け取る。
    // dirtyOnlyPages キーは displayIndex なので resolvePageId で変換する。
    // 保存時点の pageOrder (savePageOrder) を基準にする（スナップショット時点で一致）。
    const dirtyPageIds = [...dirtyOnlyPages.keys()].map((di) => resolvePageId(savePageOrder, di));
    await withStep('clearIdbDirty', 10_000, () => clearTemporaryChangesForPages(sourceFilePath, dirtyPageIds))
      .catch((e) => { console.warn('[save] clearIdbDirty failed (ignored):', e); });
    // issue #115 / #119: 保存スナップショットに載った各ページの PageData
    // オブジェクト参照 (savedPageSnapshots) を返す。呼び出し側は保存後の
    // resetDirty にこれを渡し、保存中に編集された (= 参照が変わった) ページの
    // dirty を巻き込まないようにする。
    return {
      size: savedBytes.length,
      skippedChars,
      savedPageSnapshots,
      savedActionIndex,
      hasPostSnapshotChanges,
    };
  };

  /**
   * Ctrl+S 経路と「フォルダ OCR の自動上書き保存」(#48) の共通エントリ。
   * - 成功時: true
   * - 失敗 / アボート (PDF 未オープン、保存中ロック、_executeSave が null、例外) は false
   *
   * フォルダ OCR ループは false を見て即時中止できる。
   */
  const handleSave = async (options?: SaveInvocationOptions): Promise<boolean> => {
    // Ctrl+S が届いていることを可視化するため、開始時に必ずトースト表示。
    // リリースビルドでは console.log が見えないため UI で進行状況を確認する。
    console.log('[save] handleSave invoked');
    perf.mark('ui.save');
    const { document } = usePecoStore.getState();
    if (!document) {
      showToast("PDFが開かれていません。", true);
      return false;
    }
    // PCT-074: ファイル読込中の保存は拒否する (handleOpen 側の再チェックと対称の
    // ガード)。読込中オーバーレイはビューア区画のみで Ctrl+S は window リスナーに
    // 素通りするため、ここで止めないと読込完了時の clearTemporaryChanges /
    // setDocument と保存処理が交差して部分保存になる。
    if (isLoadingFileRef.current) {
      showToast('PDFの読み込み中は保存できません。読み込みが完了してから再度お試しください。');
      return false;
    }
    if (isOcrRunningRef?.current && !options?.bypassOcrGuard) {
      showToast('OCR実行中は保存できません。OCRを中止または完了してから保存してください。', true);
      return false;
    }
    // issue #115: store スナップショット前にフォーカス中の OcrCard の未コミット
    // 編集を store へ確定させる。OcrCard のテキスト編集は再レンダリング抑制のため
    // blur-commit 設計になっており、Ctrl+S 時にフォーカス中だと最新編集が store に
    // 無い。flushActiveOcrCardText は focus 中の .ocr-card-content を直接読んで
    // 同期 updatePageData するため、直後の _executeSave スナップショットに載る。
    commitActiveOcrCardEdit();

    if (isSavingRef.current) {
      showToast("保存処理が進行中です。");
      return false;
    }

    // issue #201: diff プレビューが設定されている場合、保存前に変更内容を表示する
    if (onRequestDiffPreview) {
      const { undoStack, lastSavedActionIndex } = usePecoStore.getState();
      const diffSummary = computeSaveDiff(undoStack, lastSavedActionIndex);
      if (diffSummary.entries.length > 0) {
        let confirmed: boolean;
        try {
          confirmed = await onRequestDiffPreview(diffSummary);
        } catch (previewErr) {
          console.error('[handleSave] onRequestDiffPreview rejected:', previewErr);
          const previewMsg = previewErr instanceof Error ? previewErr.message : String(previewErr);
          showToast(`保存プレビューでエラーが発生しました: ${previewMsg}`, true);
          setSaveStep?.(null);
          isSavingRef.current = false;
          setIsSaving?.(false);
          return false;
        }
        if (!confirmed) return false;
        // PCT-075: onRequestDiffPreview の await はユーザーがモーダルを操作する
        // まで無期限に保留される。その間に別経路 (Ctrl+Shift+S の別名保存等) で
        // 保存が開始していたら、続行すると _executeSave が二本並走して
        // clearTemporaryChangesForPages と readIdbDirty が交差するため中断する。
        if (isSavingRef.current) {
          showToast('別の保存処理が進行中です。完了してから再度お試しください。');
          return false;
        }
      }
    }

    isSavingRef.current = true;
    setIsSaving?.(true);
    showToast("保存処理を開始しました...");
    try {
      const result = await _executeSave();
      if (result !== null) {
        // issue #115 / #119: 保存スナップショットと同一参照のページだけ dirty を
        // 下ろす。保存中に編集されたページは参照が変わり一致しないため isDirty が
        // 保持され、次回保存の dirty フィルタに正しく載る。
        resetDirty(result.savedPageSnapshots);
        // issue #201: 保存成功時に lastSavedActionIndex を更新する
        setLastSavedActionIndex(Math.min(result.savedActionIndex, usePecoStore.getState().undoStack.length));
        if (result.hasPostSnapshotChanges) {
          usePecoStore.setState({ isDirty: true });
        }
        showToast(formatSaveToast('保存しました', result.size, result.skippedChars));
        // issue #201: NDJSON 監査ログを出力する (fire-and-forget)
        void _writeAuditLog(document.filePath).catch((e) => {
          console.warn('[save] audit log write failed (ignored):', e);
        });
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
        // R04D-2: OS エラー文字列 (msg) をトーストに生展開しない。
        // デバッグ用の元メッセージは console.error で既にログ済み。
        console.warn('[save] write access error detail:', msg);
        showToast(
          '他のアプリでこの PDF が開かれている可能性があります。閉じてから再度保存してください。',
          true,
          {
            label: '別名で保存',
            onClick: () => {
              // issue #197: SaveDialog が設定されている場合は dialog 経由で保存オプション選択へ。
              // 未設定 (後方互換) の場合は executeSaveAs を直接呼ぶ。
              if (onRequestSaveDialog) {
                onRequestSaveDialog();
                return;
              }
              const fn = executeSaveAsRef.current;
              if (!fn) {
                showToast('別名で保存機能が初期化中です。少し待って再度試してください。', true);
                return;
              }
              void fn();
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
      setSaveStep?.(null);
    }
  };

  /**
   * issue #197 / #206: SaveDialog から選んだ圧縮オプションを受け取り _executeSave に伝搬する。
   * options が undefined のときは従来通りデフォルト挙動 (後方互換)。
   * compressed プリセット: useObjectStreams=true で PDF 保存 (issue #206 実装済み)。
   * rasterized プリセット: TODO (別 issue で対応予定)。現状は warning toast のみ。
   */
  const executeSaveAs = async (options?: SaveDialogOptions) => {
    // issue #206: rasterized は未実装 — ユーザーに警告して none にフォールバック
    if (options?.compression === 'rasterized') {
      showToast('高圧縮 (ラスタライズ) は現在未実装です。通常形式で保存します。', true);
      options = { ...options, compression: 'none' };
    }
    const { document } = usePecoStore.getState();
    if (!document) return;
    if (isOcrRunningRef?.current) {
      showToast('OCR実行中は保存できません。OCRを中止または完了してから保存してください。', true);
      return;
    }
    commitActiveOcrCardEdit();
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
        // PCT-075: ネイティブ保存ダイアログの await 中 (ユーザーがパスを選ぶまで
        // 無期限) に別の保存処理が開始していたら中断する。冒頭の isSavingRef
        // チェックはダイアログ表示前の値しか見ていない。
        if (isSavingRef.current) {
          showToast('別の保存処理が進行中です。完了してから再度お試しください。');
          return;
        }
        isSavingRef.current = true;
        setIsSaving?.(true);
        try {
          const result = await _executeSave(path, options);
          if (result !== null) {
            const currentDoc = usePecoStore.getState().document;
            if (!currentDoc || currentDoc.filePath !== document.filePath) {
              throw new Error('保存中に別のPDFへ切り替わったため、状態反映を中止しました。');
            }
            const prevPath = currentDoc.filePath;
            setDocumentFilePath(path);
            // issue #115 / #119: 別名保存でも保存スナップショットと同一参照の
            // ページだけ dirty を下ろす。
            resetDirty(result.savedPageSnapshots);
            // issue #201: 保存成功時に lastSavedActionIndex を更新する
            setLastSavedActionIndex(Math.min(result.savedActionIndex, usePecoStore.getState().undoStack.length));
            if (result.hasPostSnapshotChanges) {
              usePecoStore.setState({ isDirty: true });
            }
            showToast(formatSaveToast('名前を付けて保存しました', result.size, result.skippedChars));
            // issue #201: NDJSON 監査ログを出力する (fire-and-forget)
            void _writeAuditLog(path).catch((e) => {
              console.warn('[save-as] audit log write failed (ignored):', e);
            });
            addToRecent(path);
            // 元のパスのバックアップも新しいパスのバックアップも削除する
            if (prevPath) invoke('clear_backup', { filePath: prevPath }).catch(() => {});
            invoke('clear_backup', { filePath: path }).catch(() => {});
          }
        } finally {
          isSavingRef.current = false;
          setIsSaving?.(false);
          setSaveStep?.(null);
        }
      }
    } catch (err) {
      console.error("Failed to save as:", err);
      showToast("名前を付けて保存に失敗しました。", true);
    }
  };

  /**
   * issue #201: 保存成功後に NDJSON 監査ログを appData/pecotool/audit/<YYYY-MM-DD>.ndjson に追記する。
   * undoStack の直近変更エントリを集約して 1 行の JSON として書き出す。
   */
  const _writeAuditLog = async (filePath: string): Promise<void> => {
    const { undoStack, lastSavedActionIndex } = usePecoStore.getState();
    const diff = computeSaveDiff(undoStack, lastSavedActionIndex);
    if (diff.entries.length === 0) return;
    const record = {
      timestamp: new Date().toISOString(),
      filePath,
      entries: diff.entries.map((e) => ({
        pageIndex: e.pageIndex,
        blockId: e.blockId,
        before: e.before,
        after: e.after,
        changeType: e.changeType,
      })),
    };
    await invoke('write_audit_log', { body: JSON.stringify(record) });
  };

  // handleSave 内のエラーフォールバックから executeSaveAs を呼び出せるように
  // ref へ最新参照を入れる (関数定義順の循環参照を回避する目的)。
  executeSaveAsRef.current = executeSaveAs;

  /**
   * issue #243: バッチジョブの sidecar 保存経路向け。
   * UI ダイアログを開かず、指定パスへ現在の document を保存する。
   * OCR 結果 (textBlocks) を含む完全な PDF を書き出すため、
   * _executeSave を直接呼ぶ (saveSidecar のように pdfjs から raw bytes を
   * 取り出す実装とは異なり、OCR レイヤが保持される)。
   * 成功時 true / 失敗時 false を返す。
   */
  const handleSaveTo = async (targetPath: string, options?: SaveInvocationOptions): Promise<boolean> => {
    if (isSavingRef.current) {
      showToast('保存処理が進行中です。');
      return false;
    }
    if (isOcrRunningRef?.current && !options?.bypassOcrGuard) {
      showToast('OCR実行中は保存できません。OCRを中止または完了してから保存してください。', true);
      return false;
    }
    commitActiveOcrCardEdit();
    isSavingRef.current = true;
    setIsSaving?.(true);
    try {
      const result = await _executeSave(targetPath, undefined, {
        normalizePageOrderForCurrentDocument: false,
      });
      if (result !== null) {
        resetDirty(result.savedPageSnapshots);
        setLastSavedActionIndex(Math.min(result.savedActionIndex, usePecoStore.getState().undoStack.length));
        if (result.hasPostSnapshotChanges) {
          usePecoStore.setState({ isDirty: true });
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error('[handleSaveTo] failed:', err);
      showToast(`保存に失敗しました: ${err}`, true);
      return false;
    } finally {
      isSavingRef.current = false;
      setIsSaving?.(false);
      setSaveStep?.(null);
    }
  };

  // issue #137: useAutoBackup から保存中ガードに使う共有 ref。
  // 旧実装は useAutoBackup 内で独自の isSavingRef を持っていたため、
  // useFileOperations の保存中に autoBackup の performBackup が並走しうる
  // (Rust 側の writeFileAtomically と save_backup が同一ファイルを取り合う) 状態だった。
  return { handleOpen, handleSave, executeSaveAs, handleSaveTo, isSavingRef };
}
