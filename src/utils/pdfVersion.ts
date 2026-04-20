/**
 * PDF header version helpers shared by the main-thread save path (pdfSaver.ts)
 * and the Web Worker path (pdf.worker.ts).
 *
 * Acrobat 7.0 など古いビューアは PDF 1.6 までしかサポートしないため、
 * @cantoo/pdf-lib が書き換え時に埋め込む `%PDF-1.7` を元 version に戻す必要がある。
 */

export function extractPdfVersion(bytes: Uint8Array): string | null {
  const header = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  const m = header.match(/%PDF-(\d+\.\d+)/);
  return m ? m[1] : null;
}

export function restorePdfVersion(savedBytes: Uint8Array, version: string): void {
  const target = `%PDF-${version}`;
  const current = new TextDecoder('latin1').decode(savedBytes.slice(0, 16));
  const m = current.match(/%PDF-\d+\.\d+/);
  if (!m || current.startsWith(target)) return;
  const patch = new TextEncoder().encode(target);
  for (let i = 0; i < patch.length && i < m[0].length; i++) {
    savedBytes[m.index! + i] = patch[i];
  }
}
