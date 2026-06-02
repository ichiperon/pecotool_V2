import { useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore } from '../store/pecoStore';
import { extractPagesToNewPdf } from '../utils/pdfPageExtractor';

/**
 * Writes bytes to a file path via Tauri IPC (chunked to avoid hang on large files).
 * Mirrors the writeFileChunked / writeFileAtomically pattern in useFileOperations.
 */
async function writeFileChunked(path: string, bytes: Uint8Array): Promise<void> {
  const CHUNK = 4 * 1024 * 1024; // 4 MB
  const headerPath = encodeURIComponent(path);
  if (bytes.byteLength === 0) {
    await invoke('write_pdf_chunk', new ArrayBuffer(0), {
      headers: { 'x-path': headerPath, 'x-offset': '0' },
    });
    return;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);
    const body =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer
        : chunk.slice().buffer;
    await invoke('write_pdf_chunk', body, {
      headers: { 'x-path': headerPath, 'x-offset': String(offset) },
    });
  }
}

async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${path}.pecotool-${Date.now()}-${crypto.randomUUID()}.tmp`;
  await writeFileChunked(tempPath, bytes);
  await invoke('replace_pdf_file', { tempPath, targetPath: path });
}

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
