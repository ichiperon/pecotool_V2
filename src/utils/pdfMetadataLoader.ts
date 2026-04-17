import type * as pdfjsLib from 'pdfjs-dist';
import { BoundingBox } from '../types';

/**
 * Read PecoTool bbox metadata from the PDF if it was saved by this tool.
 * Returns null if no metadata found.
 */
export async function loadPecoToolBBoxMeta(pdf: pdfjsLib.PDFDocumentProxy): Promise<Record<string, Array<{
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
}>> | null> {
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as Record<string, unknown> | undefined;
    const custom = info?.Custom as Record<string, unknown> | undefined;
    const raw = custom?.PecoToolBBoxes ?? info?.PecoToolBBoxes;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  return null;
}
