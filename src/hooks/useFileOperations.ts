import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { usePecoStore } from '../store/pecoStore';
import { loadPDF } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../utils/format';

export function useFileOperations(showToast: (msg: string, isError?: boolean) => void, setIsSaving?: (v: boolean) => void) {
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
        const content = await readFile(selected);
        const bytes = new Uint8Array(content);
        const doc = await loadPDF(selected);
        setDocument(doc, bytes);
        addToRecent(selected);
      }
    } catch (err) {
      console.error("Failed to open file:", err);
      showToast("ファイルの読み込みに失敗しました。", true);
    }
  };

  const handleSave = async () => {
    const { document, originalBytes, fontBytes, isFontLoaded } = usePecoStore.getState();
    if (!document || !originalBytes) return;

    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
    }

    setIsSaving?.(true);
    try {
      const savedBytes = await savePDF(originalBytes, document, fontBytes || undefined);

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
    const { document, originalBytes, fontBytes, isFontLoaded } = usePecoStore.getState();
    if (!document || !originalBytes) return;

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
          const savedBytes = await savePDF(originalBytes, document, fontBytes || undefined);

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
