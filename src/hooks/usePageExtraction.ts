import { useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { usePecoStore } from '../store/pecoStore';
import { extractPagesToNewPdf } from '../utils/pdfPageExtractor';
import { writeFileAtomically } from '../utils/tauriFileIO';

/**
 * Returns a stable callback that extracts the given display-order page indices
 * into a new PDF chosen via Tauri save dialog.
 *
 * displayIndices must correspond to the current pageOrder of the document
 * (i.e. the same index space used by ThumbnailPanel).
 *
 * issue #209: extractPagesToFile is wrapped in useCallback for stable reference.
 * pageOrder is read from store at call time (getState()) to always reflect
 * the latest delete/reorder state.
 */
export function usePageExtraction(
  showToast: (msg: string, isError?: boolean) => void,
) {
  const extractPagesToFile = useCallback(async (displayIndices: number[]): Promise<void> => {
    if (displayIndices.length === 0) {
      showToast('抽出するページが選択されていません。', true);
      return;
    }

    const { document: doc, pageOrder } = usePecoStore.getState();
    if (!doc) {
      showToast('PDFが開かれていません。', true);
      return;
    }

    // issue #209: use store.pageOrder (canonical) instead of doc.pageOrder (removed).
    // Resolve display indices to original (source) page indices via store pageOrder.
    const sourceIndices = pageOrder.length > 0
      ? displayIndices.map((di) => pageOrder[di])
      : displayIndices;

    // Prompt user for output path.
    const defaultName = doc.fileName.replace(/\.pdf$/i, '_extracted.pdf');
    const outputPath = await save({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultPath: defaultName,
    });
    if (!outputPath || typeof outputPath !== 'string') return;

    try {
      showToast('ページを抽出中...');
      const originalBytes = await readFile(doc.filePath);
      const newPdfBytes = await extractPagesToNewPdf(originalBytes, sourceIndices);
      await writeFileAtomically(outputPath, newPdfBytes);
      showToast(`${displayIndices.length} ページを書き出しました。`);
    } catch (err) {
      console.error('[usePageExtraction] extractPagesToFile failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`ページの書き出しに失敗しました: ${msg}`, true);
    }
  }, [showToast]);

  return { extractPagesToFile };
}
