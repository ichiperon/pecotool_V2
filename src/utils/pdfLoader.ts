import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PecoDocument, PageData, TextBlock, BoundingBox } from '../types';

// Vite ?url import resolves the correct bundled path in both dev and production
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

// Always pass a copy so the original bytes are never transferred to the worker
function safeGetDocument(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ data: bytes.slice() });
}

export async function loadPDF(file: File): Promise<PecoDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
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
  const textItems = textContent.items.filter((item: any) => typeof item.str === 'string');

  let order = 0;
  const textBlocks: TextBlock[] = textItems
    .filter((item: any) => item.str.trim() !== '')
    .map((item: any) => {
      const isVertical = Math.abs(item.transform[0]) < Math.abs(item.transform[1]);
      const height = item.height > 0 ? item.height : Math.abs(item.transform[3]) || 12;
      
      // Y座標の計算を微調整 (PDFのYは下から上、CanvasのYは上から下)
      // 下方向へのズレを補正するため、より多くオフセットを引く（フォントによるが概ね height * 0.95 〜 1.0 が標準的）
      const bbox: BoundingBox = {
        x: item.transform[4],
        y: viewport.height - item.transform[5] - (height * 1.0),
        width: item.width || height * item.str.length * 0.6,
        height,
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
