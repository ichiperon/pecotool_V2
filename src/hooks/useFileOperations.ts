import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { usePecoStore } from '../store/pecoStore';
import { loadPDF } from '../utils/pdfLoader';
import { savePDF } from '../utils/pdfSaver';
import { formatFileSize } from '../components/SaveDialog';

export function useFileOperations(showToast: (msg: string, isError?: boolean) => void, setIsSaving?: (v: boolean) => void) {
  const {
    document, setDocument, resetDirty,
    fontBytes, isFontLoaded
  } = usePecoStore();

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
        const doc = await loadPDF(selected);
        setDocument(doc, undefined);
        addToRecent(selected);
        // page 0 の読み込みは App.tsx の useEffect (loadCurrentPage) に任せる
      }
    } catch (err) {
      console.error("Failed to open file:", err);
      showToast("ファイルの読み込みに失敗しました。", true);
    }
  };

  const handleSave = async () => {
    if (!document) return;
    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
      // Even if font is missing, we proceed, but the user is warned.
      // Ideally, we might want to block saving if it's a hard requirement.
    }

    setIsSaving?.(true);
    try {
      const content = await readFile(document.filePath);
      const bytesToSave = new Uint8Array(content);
      const compressionPref = (localStorage.getItem('peco-save-compression') as 'none' | 'compressed' | 'rasterized') || 'none';
      const storedQuality = localStorage.getItem('peco-rasterize-quality');
      const qNum = storedQuality ? parseInt(storedQuality, 10) / 100 : 0.6;

      const savedBytes = await savePDF(bytesToSave, document, compressionPref, qNum, fontBytes || undefined);

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

  const executeSaveAs = async (compression: 'none' | 'compressed' | 'rasterized', quality?: number) => {
    if (!document) return;
    if (!isFontLoaded || !fontBytes) {
      showToast("日本語フォントの準備ができていません。保存すると文字化けする可能性があります。", true);
    }

    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path && typeof path === 'string') {
        localStorage.setItem('peco-save-compression', compression);
        if (compression === 'rasterized' && typeof quality === 'number') {
          localStorage.setItem('peco-rasterize-quality', quality.toString());
        }

        const content = await readFile(document.filePath);
        const bytesToSave = new Uint8Array(content);

        setIsSaving?.(true);
        if (compression === 'rasterized') {
          showToast(`高圧縮処理中です(画質${quality}%)...しばらくお待ち下さい`, false);
        }

        try {
          const savedBytes = await savePDF(bytesToSave, document, compression, quality ? quality / 100 : 0.6, fontBytes || undefined);

          await writeFile(path, savedBytes);
          document.filePath = path;
          resetDirty();
          showToast(`名前を付けて保存しました。(${formatFileSize(savedBytes.length)}・${compression === 'rasterized' ? '高圧縮' : compression === 'compressed' ? '標準圧縮' : '非圧縮'})`);
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
