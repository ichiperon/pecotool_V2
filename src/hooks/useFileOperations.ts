import { open, save } from '@tauri-apps/plugin-dialog';
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
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { loadPDF, getAllTemporaryPageData, clearTemporaryChanges } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import type { SavePdfSource } from '../utils/pdfWorkerTypes';
import { formatFileSize } from '../utils/format';
import { loadFontLazy } from './useFontLoader';
import { PecoDocument, PageData } from '../types';
import { perf } from '../utils/perfLogger';

/**
 * 1 ページ目 render 後 (アイドル時) に background で PDF 全体 bytes を取得して
 * pecoStore.originalBytes にキャッシュする。Ctrl+S 時は既にメモリ上にあるため
 * pdf-lib 処理のみで保存完了できる (~1-3 秒)。
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
 * 同時に複数の prefetch が走らないよう、ファイルパスをキーに in-flight Promise を
 * モジュールレベルで共有する。保存時 (_executeSave) も同じ Promise を await する
 * ことで、二重読み込みを防ぐ。
 */
const inflightPrefetches = new Map<string, Promise<Uint8Array | null>>();

function ensurePrefetchOriginalBytes(filePath: string): Promise<Uint8Array | null> {
  const existing = inflightPrefetches.get(filePath);
  if (existing) return existing;

  const state = usePecoStore.getState();
  if (state.originalBytes && state.document?.filePath === filePath) {
    return Promise.resolve(state.originalBytes);
  }

  const run = async (): Promise<Uint8Array | null> => {
    try {
      // Tauri plugin-fs は v2 で raw binary IPC を使用する。100MB 級でも
      // base64 エンコードのオーバーヘッドは掛からず、HTTP/asset 経路とも無干渉。
      const bytes = await readFile(filePath);
      const now = usePecoStore.getState();
      if (now.document?.filePath === filePath && !now.originalBytes) {
        now.setOriginalBytes(bytes);
      }
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

export function useFileOperations(
  showToast: (msg: string, isError?: boolean) => void,
  setIsSaving?: (v: boolean) => void,
  setIsLoadingFile?: (v: boolean) => void,
  onOpenComplete?: (doc: import('../types').PecoDocument) => void,
) {
  const { setDocument, setDocumentFilePath, resetDirty } = usePecoStore();

  const addToRecent = (path: string) => {
    // ファイルフルパスは機密情報のため sessionStorage に保存（ブラウザ/アプリを閉じると消去）
    const saved = sessionStorage.getItem('peco-recent-files');
    let recent: string[] = [];
    if (saved) {
      try {
        const parsed: unknown = JSON.parse(saved);
        // 改ざん・型不整合に備え string[] を narrow。失敗時は空配列で続行。
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          recent = parsed;
        }
      } catch {
        // 不正 JSON は無視して空配列にフォールバック
      }
    }
    recent = [path, ...recent.filter((p) => p !== path)].slice(0, 10);
    sessionStorage.setItem('peco-recent-files', JSON.stringify(recent));
  };

  const handleOpen = async (explicitPath?: string): Promise<boolean> => {
    perf.mark('open.start', { explicit: !!explicitPath });
    try {
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
   * @returns 書き込んだバイト数。失敗時は null。
   */
  const _executeSave = async (targetPath?: string): Promise<number | null> => {
    const { document } = usePecoStore.getState();
    if (!document) return null;

    let cachedBytes = usePecoStore.getState().originalBytes;
    if (!cachedBytes) {
      showToast("保存用にファイルを読み込み中...");
      const fetched = await withStep('readFile', 90_000, () => ensurePrefetchOriginalBytes(document.filePath));
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

    // LRU退避のIDB書き込みが全て完了してからIDBを読み込む（競合状態回避）
    await withStep('waitIdbSaves', 15_000, () => waitForPendingIdbSaves());

    // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
    const tempDirtyPages = await withStep(
      'readIdbDirty',
      15_000,
      () => getAllTemporaryPageData(document.filePath),
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
    const mergedDoc: PecoDocument = { ...document, pages: dirtyOnlyPages };
    const savedBytes = await withStep('savePDF', 150_000, () => savePDF(saveSource, mergedDoc, fontBytes));
    const writePath = targetPath ?? document.filePath;

    await withStep('writeFile', 180_000, () => writeFileChunked(writePath, savedBytes));
    // originalBytes を更新し、次回保存時もこの累積変更をベースにするようにする
    usePecoStore.getState().setOriginalBytes(savedBytes);
    // LRU退避ページの IDB エントリも保存完了済みとしてクリア。失敗しても保存は成功扱い。
    await withStep('clearIdbDirty', 10_000, () => clearTemporaryChanges(document.filePath))
      .catch((e) => { console.warn('[save] clearIdbDirty failed (ignored):', e); });
    return savedBytes.length;
  };

  const handleSave = async () => {
    // Ctrl+S が届いていることを可視化するため、開始時に必ずトースト表示。
    // リリースビルドでは console.log が見えないため UI で進行状況を確認する。
    console.log('[save] handleSave invoked');
    perf.mark('ui.save');
    const { document } = usePecoStore.getState();
    if (!document) {
      showToast("PDFが開かれていません。", true);
      return;
    }

    setIsSaving?.(true);
    showToast("保存処理を開始しました...");
    try {
      const size = await _executeSave();
      if (size !== null) {
        resetDirty();
        showToast(`保存しました。(${formatFileSize(size)})`);
        // 正常保存後はバックアップファイルを削除する（fire-and-forget）
        invoke('clear_backup', { filePath: document.filePath }).catch(() => {});
      }
    } catch (err) {
      console.error("Failed to save:", err);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`保存に失敗しました: ${msg}`, true);
    } finally {
      setIsSaving?.(false);
    }
  };

  const executeSaveAs = async () => {
    const { document } = usePecoStore.getState();
    if (!document) return;

    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path && typeof path === 'string') {
        setIsSaving?.(true);
        try {
          const size = await _executeSave(path);
          if (size !== null) {
            const prevPath = usePecoStore.getState().document?.filePath;
            setDocumentFilePath(path);
            resetDirty();
            showToast(`名前を付けて保存しました。(${formatFileSize(size)})`);
            addToRecent(path);
            // 元のパスのバックアップも新しいパスのバックアップも削除する
            if (prevPath) invoke('clear_backup', { filePath: prevPath }).catch(() => {});
            invoke('clear_backup', { filePath: path }).catch(() => {});
          }
        } finally {
          setIsSaving?.(false);
        }
      }
    } catch (err) {
      console.error("Failed to save as:", err);
      showToast("名前を付けて保存に失敗しました。", true);
    }
  };

  return { handleOpen, handleSave, executeSaveAs };
}
