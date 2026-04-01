import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PecoDocument, PageData, TextBlock, BoundingBox } from '../types';

// Vite ?url import resolves the correct bundled path in both dev and production
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const CMAP_URL = 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/';
const CMAP_PACKED = true;
const STANDARD_FONT_DATA_URL = 'https://unpkg.com/pdfjs-dist@5.5.207/standard_fonts/';

// Always pass a copy so the original bytes are never transferred to the worker
function safeGetDocument(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ 
    data: bytes.slice(),
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
}

export async function loadPDF(file: File): Promise<PecoDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ 
    data: new Uint8Array(arrayBuffer),
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  const pdf = await loadingTask.promise;
  
  const totalPages = pdf.numPages;
  const metadata = await pdf.getMetadata();
  
  const doc: PecoDocument = {
    filePath: '', // Will be updated if loaded from disk via Tauri
    fileName: file.name,
    totalPages: totalPages,
    metadata: {
      title: (metadata.info as any)?.Title,
      author: (metadata.info as any)?.Author,
    },
    pages: new Map(),
  };

  return doc;
}

export async function openPDF(bytes: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  return safeGetDocument(bytes).promise;
}

export async function generateThumbnail(pdf: pdfjsLib.PDFDocumentProxy, pageIndex: number, scale = 0.3): Promise<string> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  
  // Convert to Blob instead of Base64 to save memory
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(URL.createObjectURL(blob));
      } else {
        resolve("");
      }
    }, 'image/jpeg', 0.7);
  });
}

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
    const raw = (metadata.info as any)?.PecoToolBBoxes;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  return null;
}

export async function loadPage(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  bboxMeta?: Record<string, Array<{
    bbox: BoundingBox;
    writingMode: string;
    order: number;
    text: string;
  }>> | null
): Promise<PageData> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();

  // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
  const allItems = textContent.items;
  const textItems = allItems.filter((item: any) => typeof item.str === 'string');
  const nonEmpty = textItems.filter((item: any) => item.str.trim() !== '');
  console.log(`[loadPage] page ${pageIndex}: total=${allItems.length}, hasStr=${textItems.length}, nonEmpty=${nonEmpty.length}`);
  if (textItems.length > 0) {
    console.log('[loadPage] sample item:', JSON.stringify(textItems[0]));
  }

  // If PecoTool-saved bbox metadata is available for this page, use it directly.
  // This ensures BB sizes don't change after save→re-open cycles.
  const savedMeta = bboxMeta?.[String(pageIndex)];
  if (savedMeta && savedMeta.length > 0) {
    const textByOrder = new Map(
      textItems
        .filter((item: any) => item.str.trim() !== '')
        .map((item: any, idx: number) => [idx, item.str as string])
    );

    const textBlocks: TextBlock[] = savedMeta.map((meta, idx) => ({
      id: crypto.randomUUID(),
      text: textByOrder.get(idx) ?? meta.text,
      originalText: textByOrder.get(idx) ?? meta.text,
      bbox: meta.bbox,
      writingMode: meta.writingMode as 'horizontal' | 'vertical',
      order: meta.order,
      isNew: false,
      isDirty: false,
    }));

    console.log(`[loadPage] page ${pageIndex}: using PecoTool saved bboxes (${textBlocks.length} blocks)`);
    return {
      pageIndex,
      width: viewport.width,
      height: viewport.height,
      textBlocks,
      isDirty: false,
      thumbnail: null,
    };
  }

  // Fallback: compute bboxes from pdfjs transform (original OCR text)

  let order = 0;
  const textBlocks: TextBlock[] = textItems
    .filter((item: any) => item.str.trim() !== '')
    .map((item: any) => {
      const isVertical = Math.abs(item.transform[0]) < Math.abs(item.transform[1]);
      
      let bbox: BoundingBox;
      
      if (isVertical) {
        const thickness = Math.sqrt(item.transform[2] * item.transform[2] + item.transform[3] * item.transform[3]) || 12;
        const runLength = item.width || Math.abs(item.transform[1]) * item.str.length || thickness * item.str.length;
        
        bbox = {
          x: item.transform[4] - thickness * 0.288,
          y: viewport.height - item.transform[5],
          width: thickness,
          height: runLength,
        };
      } else {
        const thickness = item.height > 0 ? item.height : Math.abs(item.transform[3]) || 12;
        const runLength = item.width || thickness * item.str.length * 0.6;
        
        bbox = {
          x: item.transform[4],
          y: viewport.height - item.transform[5] - thickness * 1.16,
          width: runLength,
          height: thickness,
        };
      }

      return {
        id: crypto.randomUUID(),
        text: item.str,
        originalText: item.str,
        bbox,
        writingMode: isVertical ? 'vertical' : 'horizontal',
        order: order++,
        isNew: false,
        isDirty: false,
      };
    });

  return {
    pageIndex,
    width: viewport.width,
    height: viewport.height,
    textBlocks,
    isDirty: false,
    thumbnail: null,
  };
}
