import * as pdfjsLib from 'pdfjs-dist';
import { PecoDocument, PageData, TextBlock, BoundingBox } from '../types';

// Set up worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

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
      title: metadata.info?.Title,
      author: metadata.info?.Author,
    },
    pages: new Map(),
  };

  return doc;
}

export async function loadPage(pdf: pdfjsLib.PDFDocumentProxy, pageIndex: number): Promise<PageData> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();
  
  const textBlocks: TextBlock[] = textContent.items.map((item: any, index) => {
    // Basic heuristics for writing mode based on scale in transform matrix
    const isVertical = Math.abs(item.transform[0]) < Math.abs(item.transform[1]);
    
    const bbox: BoundingBox = {
      x: item.transform[4],
      y: viewport.height - item.transform[5] - item.height, // Convert to top-left origin
      width: item.width,
      height: item.height,
    };

    return {
      id: crypto.randomUUID(),
      text: item.str,
      originalText: item.str,
      bbox: bbox,
      writingMode: isVertical ? 'vertical' : 'horizontal',
      order: index,
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
