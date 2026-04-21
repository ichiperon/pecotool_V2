import { open, save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { loadPDF, getAllTemporaryPageData, clearTemporaryChanges } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../utils/format';
import { loadFontLazy } from './useFontLoader';
import { PecoDocument, PageData } from '../types';
import { perf } from '../utils/perfLogger';

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
   * 保存の共通処理。originalBytes の待機 → IDB マージ → PDF 生成 → ファイル書き込みを行う。
   * @param targetPath 書き込み先パス。省略時は document.filePath に上書き保存。
   * @returns 書き込んだバイト数。失敗時は null。
   */
  const _executeSave = async (targetPath?: string): Promise<number | null> => {
    const { document } = usePecoStore.getState();
    if (!document) return null;

    let originalBytes = usePecoStore.getState().originalBytes;
    if (!originalBytes) {
      // bytes 直接渡し経路を廃止したため、保存時に asset protocol 経由で lazy fetch する。
      // 初回は 100MB 級ファイルの場合 1〜3 分かかる可能性があるため toast で通知。
      showToast("保存用にファイルを読み込み中...");
      try {
        let url = convertFileSrc(document.filePath);
        if (url.startsWith('asset.localhost')) {
          url = 'http://' + url;
        }
        const res = await fetch(url);
        if (!res.ok) {
          showToast("ファイルの読み込みに失敗しました。再度お試しください。", true);
          return null;
        }
        const buf = await res.arrayBuffer();
        originalBytes = new Uint8Array(buf);
        usePecoStore.getState().setOriginalBytes(originalBytes);
      } catch (e) {
        console.error('[_executeSave] originalBytes lazy fetch failed:', e);
        showToast("ファイルの読み込みに失敗しました。再度お試しください。", true);
        return null;
      }
    }

    const fontBytes = await loadFontLazy();
    if (!fontBytes) {
      showToast("日本語フォントの読み込みに失敗しました。再度お試しください。", true);
      return null;
    }

    // LRU退避のIDB書き込みが全て完了してからIDBを読み込む（競合状態回避）
    await waitForPendingIdbSaves();

    // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
    const tempDirtyPages = await getAllTemporaryPageData(document.filePath);

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
    const savedBytes = await savePDF(originalBytes, mergedDoc, fontBytes);
    const writePath = targetPath ?? document.filePath;

    await writeFile(writePath, savedBytes);
    // originalBytes を更新し、次回保存時もこの累積変更をベースにするようにする
    usePecoStore.getState().setOriginalBytes(savedBytes);
    // LRU退避ページの IDB エントリも保存完了済みとしてクリア
    await clearTemporaryChanges(document.filePath);
    return savedBytes.length;
  };

  const handleSave = async () => {
    const { document } = usePecoStore.getState();
    if (!document) return;

    setIsSaving?.(true);
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
      showToast("保存に失敗しました。", true);
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
