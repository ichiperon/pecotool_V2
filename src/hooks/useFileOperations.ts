import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { usePecoStore } from '../store/pecoStore';
import { loadPDF, getAllTemporaryPageData } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../utils/format';
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

  const handleOpen = async (explicitPath?: string) => {
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
          // Promise.all で構造 (loadPDF) とバイナリ (readFile) の両方を待機し、
          // レースコンディション（バイナリ読み込み完了前に setDocument で null にリセットされる問題）を防ぐ。
          const [content, doc] = await Promise.all([
            readFile(selected),
            loadPDF(selected)
          ]);

          setDocument(doc, new Uint8Array(content));
          addToRecent(selected);
          onOpenComplete?.(doc);
        } finally {
          setIsLoadingFile?.(false);
        }
      }
    } catch (err) {
      console.error("Failed to open file:", err);
      showToast("ファイルの読み込みに失敗しました。", true);
      setIsLoadingFile?.(false);
    }
  };

  /**
   * 保存の共通処理。originalBytes の待機 → IDB マージ → PDF 生成 → ファイル書き込みを行う。
   * @param targetPath 書き込み先パス。省略時は document.filePath に上書き保存。
   * @returns 書き込んだバイト数。失敗時は null。
   */
  const _executeSave = async (targetPath?: string): Promise<number | null> => {
    const { document, fontBytes, isFontLoaded } = usePecoStore.getState();
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

    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
    }

    // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
    const tempDirtyPages = await getAllTemporaryPageData(document.filePath);

    const mergedPages = new Map<number, PageData>(document.pages);
    for (const [idx, data] of tempDirtyPages.entries()) {
      const existing = mergedPages.get(idx);
      mergedPages.set(idx, existing ? { ...existing, ...data } : (data as PageData));
    }

    const mergedDoc: PecoDocument = { ...document, pages: mergedPages };
    const savedBytes = await savePDF(originalBytes, mergedDoc, fontBytes || undefined);
    const writePath = targetPath ?? document.filePath;

    await writeFile(writePath, savedBytes);
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
            setDocumentFilePath(path);
            resetDirty();
            showToast(`名前を付けて保存しました。(${formatFileSize(size)})`);
            addToRecent(path);
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
