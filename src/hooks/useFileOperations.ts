import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { loadPDF, getAllTemporaryPageData, clearTemporaryChanges } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../utils/format';
import { loadFontLazy } from './useFontLoader';
import { PecoDocument, PageData } from '../types';

/** originalBytes が設定されるまで最大 timeoutMs 待機する（subscribe ベース） */
function waitForOriginalBytes(timeoutMs = 10000): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const current = usePecoStore.getState().originalBytes;
    if (current) { resolve(current); return; }

    const timer = setTimeout(() => { unsubscribe(); resolve(null); }, timeoutMs);
    const unsubscribe = usePecoStore.subscribe((state) => {
      if (state.originalBytes) {
        clearTimeout(timer);
        unsubscribe();
        resolve(state.originalBytes);
      }
    });
  });
}

export function useFileOperations(
  showToast: (msg: string, isError?: boolean) => void,
  setIsSaving?: (v: boolean) => void,
  setIsLoadingFile?: (v: boolean) => void,
  onOpenComplete?: (doc: import('../types').PecoDocument) => void,
) {
  const { setDocument, setDocumentFilePath, resetDirty } = usePecoStore();

  const addToRecent = (path: string) => {
    const saved = localStorage.getItem('peco-recent-files');
    let recent: string[] = saved ? JSON.parse(saved) : [];
    recent = [path, ...recent.filter(p => p !== path)].slice(0, 10);
    localStorage.setItem('peco-recent-files', JSON.stringify(recent));
  };

  const handleOpen = async (explicitPath?: string): Promise<boolean> => {
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

        // readFile（保存用バイナリ）はバックグラウンドで開始。表示には不要なので待たない。
        const readFilePromise = readFile(selected);

        try {
          // loadPDF が完了した時点で即座に表示開始
          const doc = await loadPDF(selected);
          setDocument(doc); // bytes なしで表示 → UIが即座に反応する
          addToRecent(selected);
          onOpenComplete?.(doc);
        } finally {
          setIsLoadingFile?.(false);
        }

        // readFile はバックグラウンドで継続し、完了後に originalBytes を更新
        // capturedPath で「このファイルが今も表示中か」を確認してから書き込む（競合防止）
        const capturedPath = selected;
        readFilePromise
          .then(content => {
            const state = usePecoStore.getState();
            if (state.document?.filePath === capturedPath) {
              state.setOriginalBytes(new Uint8Array(content));
            }
          })
          .catch(err => {
            console.error('[handleOpen] readFile failed:', err);
            showToast('ファイルバイナリの読み込みに失敗しました。保存できない場合があります。', true);
          });

        loadFontLazy();
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
      showToast("ファイルを準備中です。しばらくお待ちください...");
      originalBytes = await waitForOriginalBytes();
      if (!originalBytes) {
        showToast("ファイルの読み込みが完了していません。再度お試しください。", true);
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
