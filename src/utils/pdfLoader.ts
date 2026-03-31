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
  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function loadPage(pdf: pdfjsLib.PDFDocumentProxy, pageIndex: number): Promise<PageData> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();

  // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
  // Filter to only TextItem (those with a 'str' property).
  const allItems = textContent.items;
  const textItems = allItems.filter((item: any) => typeof item.str === 'string');
  const nonEmpty = textItems.filter((item: any) => item.str.trim() !== '');
  console.log(`[loadPage] page ${pageIndex}: total=${allItems.length}, hasStr=${textItems.length}, nonEmpty=${nonEmpty.length}`);
  if (textItems.length > 0) {
    console.log('[loadPage] sample item:', JSON.stringify(textItems[0]));
  }

  // Use viewport.transform for proper coordinate conversion.
  // This handles page rotation, mirrored coordinate systems, etc.
  const vt = viewport.transform; // [a, b, c, d, e, f]
  const toViewport = (px: number, py: number): [number, number] => [
    px * vt[0] + py * vt[2] + vt[4],
    px * vt[1] + py * vt[3] + vt[5],
  ];

  let order = 0;
  const textBlocks: TextBlock[] = textItems
    .filter((item: any) => item.str.trim() !== '')
    .map((item: any) => {
      const isVertical = Math.abs(item.transform[0]) < Math.abs(item.transform[1]);
      const height = item.height > 0 ? item.height : Math.abs(item.transform[3]) || 12;
      const width = item.width || height * item.str.length * 0.6;

      // Convert two corners from PDF space to viewport (screen) space
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];
      const [x1, y1] = toViewport(pdfX, pdfY);
      const [x2, y2] = toViewport(pdfX + width, pdfY + height);

      const bbox: BoundingBox = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1) || width,
        height: Math.abs(y2 - y1) || height,
      };

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
