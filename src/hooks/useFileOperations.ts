import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { usePecoStore } from '../store/pecoStore';
import { loadPDF, getAllTemporaryPageData } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../utils/format';
import { PecoDocument, PageData } from '../types';

export function useFileOperations(
  showToast: (msg: string, isError?: boolean) => void,
  setIsSaving?: (v: boolean) => void,
  setIsLoadingFile?: (v: boolean) => void,
  onOpenComplete?: (doc: import('../types').PecoDocument) => void,
) {
  const { setDocument, resetDirty } = usePecoStore();

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
          // loadPDF でUIを即座に表示。readFile は独立したバックグラウンド処理で並行実行。
          // setDocument は originalBytes をリセットするため、readFile の完了後に setOriginalBytes を呼ぶ。
          const readFilePromise = readFile(selected);
          const doc = await loadPDF(selected);
          setDocument(doc);
          addToRecent(selected);
          onOpenComplete?.(doc);
          // readFile がすでに完了している場合も未完了の場合も、then で確実にセット
          readFilePromise.then((content) => {
            usePecoStore.getState().setOriginalBytes(new Uint8Array(content));
          }).catch((err) => {
            console.error("Failed to read file bytes:", err);
          });
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

  const handleSave = async () => {
    const { document, fontBytes, isFontLoaded } = usePecoStore.getState();
    if (!document) return;

    // originalBytes がバックグラウンド読込中の場合、最大10秒待機
    let { originalBytes } = usePecoStore.getState();
    if (!originalBytes) {
      showToast("ファイルを準備中です。しばらくお待ちください...");
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 100));
        originalBytes = usePecoStore.getState().originalBytes;
        if (originalBytes) break;
      }
      if (!originalBytes) {
        showToast("ファイルの読み込みが完了していません。再度お試しください。", true);
        return;
      }
    }

    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
    }

    setIsSaving?.(true);
    try {
      // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
      const tempDirtyPages = await getAllTemporaryPageData(document.filePath);
      
      // 保存用にドキュメント状態を統合（メモリ上の Map + IDB の Map）
      const mergedPages = new Map<number, PageData>(document.pages);
      for (const [idx, data] of tempDirtyPages.entries()) {
        const existing = mergedPages.get(idx);
        mergedPages.set(idx, existing ? { ...existing, ...data } : (data as PageData));
      }

      const mergedDoc: PecoDocument = { ...document, pages: mergedPages };
      const savedBytes = await savePDF(originalBytes, mergedDoc, fontBytes || undefined);

      await writeFile(document.filePath, savedBytes);
      resetDirty();
      showToast(`保存しました。(${formatFileSize(savedBytes.length)})`);
    } catch (err) {
      console.error("Failed to save:", err);
      showToast("保存に失敗しました。", true);
    } finally {
      setIsSaving?.(false);
    }
  };

  const executeSaveAs = async () => {
    const { document, fontBytes, isFontLoaded } = usePecoStore.getState();
    if (!document) return;

    let { originalBytes } = usePecoStore.getState();
    if (!originalBytes) {
      showToast("ファイルを準備中です。しばらくお待ちください...");
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 100));
        originalBytes = usePecoStore.getState().originalBytes;
        if (originalBytes) break;
      }
      if (!originalBytes) {
        showToast("ファイルの読み込みが完了していません。再度お試しください。", true);
        return;
      }
    }

    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
    }

    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path && typeof path === 'string') {
        setIsSaving?.(true);

        try {
          // 1000ページ対応: メモリにない（IDBに退避された）Dirtyデータも全て回収する
          const tempDirtyPages = await getAllTemporaryPageData(document.filePath);
          
          const mergedPages = new Map<number, PageData>(document.pages);
          for (const [idx, data] of tempDirtyPages.entries()) {
            const existing = mergedPages.get(idx);
            mergedPages.set(idx, existing ? { ...existing, ...data } : (data as PageData));
          }

          const mergedDoc: PecoDocument = { ...document, pages: mergedPages };
          const savedBytes = await savePDF(originalBytes, mergedDoc, fontBytes || undefined);

          await writeFile(path, savedBytes);
          document.filePath = path;
          resetDirty();
          showToast(`名前を付けて保存しました。(${formatFileSize(savedBytes.length)})`);
          addToRecent(path);
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
