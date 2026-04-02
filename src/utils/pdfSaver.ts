import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, translate, scale, PDFName, PDFHexString, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import * as pdfjsLib from 'pdfjs-dist';

let cachedFontBytes: ArrayBuffer | null = null;

async function buildPdfDocument(originalPdfBytes: Uint8Array, documentState: PecoDocument): Promise<PDFDocument> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes.slice());
  
  pdfDoc.registerFontkit(fontkit);

  if (!cachedFontBytes) {
    try {
      const res = await fetch('/fonts/IPAexGothic.ttf');
      if (res.ok) cachedFontBytes = await res.arrayBuffer();
    } catch(e) {
      console.warn('Failed to load font bytes', e);
    }
  }

  const customFont = cachedFontBytes 
    ? await pdfDoc.embedFont(cachedFontBytes, { subset: true }) 
    : await pdfDoc.embedFont(StandardFonts.Helvetica);

  let infoDict = (pdfDoc as any).getInfoDict();
  let existingBBoxMeta: Record<string, any> = {};

  if (infoDict) {
    try {
      const value = infoDict.get(PDFName.of('PecoToolBBoxes'));
      if (value instanceof PDFHexString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
      } else if (value instanceof PDFString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
      }
    } catch(e) {
      console.warn('Failed to parse existing PecoToolBBoxes in savePDF', e);
    }
  }

  const bboxMeta: Record<string, any> = { ...existingBBoxMeta };

  for (const [pageIndex, pageData] of documentState.pages.entries()) {
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    bboxMeta[String(pageIndex)] = sortedBlocks.map(b => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text
    }));

    if (!pageData.isDirty) continue;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        if (block.writingMode === 'vertical') {
          const fontSize = 1;
          let textWidth = block.text.length;
          let textHeight = 1.448;
          try {
            textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
            textHeight = customFont.heightAtSize(fontSize) || textHeight;
          } catch(e) {}
          
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;
          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;
          
          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, {
            x: 0,
            y: 0,
            size: fontSize,
            font: customFont,
            rotate: degrees(-90),
            opacity: 0,
          });
          page.pushOperators(popGraphicsState());
        } else {
          const fontSize = 1;
          let textWidth = block.text.length;
          let textHeight = 1.448;
          try {
            textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
            textHeight = customFont.heightAtSize(fontSize) || textHeight;
          } catch(e) {}
          
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          const baselineY = height - block.bbox.y - textHeight * sy * 0.8;
          
          page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
          page.drawText(block.text, {
            x: 0,
            y: 0,
            size: fontSize,
            font: customFont,
            opacity: 0,
          });
          page.pushOperators(popGraphicsState());
        }
      } catch (err) {
        console.warn("Skipping block due to render error:", err);
      }
    }
  }

  if (!infoDict) {
    pdfDoc.setTitle(documentState.metadata?.title || 'OCR Document');
    infoDict = (pdfDoc as any).getInfoDict();
  }
  if (infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  return pdfDoc;
}

import pdfWorkerUrl from './pdf.worker?worker&url';

export async function savePDF(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  compression: 'none' | 'compressed' | 'rasterized' = 'none',
  rasterizeQuality: number = 0.6,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  if (compression === 'rasterized') {
    return await buildRasterizedPdfDocument(originalPdfBytes, documentState, rasterizeQuality, fontBytes);
  }

  // Use Worker for standard saving to keep UI responsive
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
    
    worker.onmessage = (e) => {
      const { type, data, message } = e.data;
      if (type === 'SAVE_PDF_SUCCESS') {
        resolve(data);
        worker.terminate();
      } else if (type === 'ERROR') {
        reject(new Error(message));
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };

    // Serialize documentState (Map to Object)
    const serializedPages: Record<number, any> = {};
    for (const [idx, page] of documentState.pages.entries()) {
      serializedPages[idx] = page;
    }

    const startSave = async () => {
      worker.postMessage({
        type: 'SAVE_PDF',
        data: {
          originalPdfBytes,
          documentState: { ...documentState, pages: serializedPages },
          compression,
          rasterizeQuality,
          fontBytes
        }
      }, [originalPdfBytes.buffer, fontBytes].filter(Boolean) as any);
    };

    startSave();
  });
}

async function buildRasterizedPdfDocument(originalPdfBytes: Uint8Array, documentState: PecoDocument, quality: number = 0.6, fontBytes?: ArrayBuffer): Promise<Uint8Array> {
  const newPdf = await PDFDocument.create();
  newPdf.registerFontkit(fontkit);

  const customFont = fontBytes 
    ? await newPdf.embedFont(fontBytes, { subset: true }) 
    : await newPdf.embedFont(StandardFonts.Helvetica);

  const pdfJsDoc = await pdfjsLib.getDocument({ data: originalPdfBytes.slice() }).promise;
  const totalPages = pdfJsDoc.numPages;
  const bboxMeta: Record<string, any> = {};

  for (let i = 0; i < totalPages; i++) {
    const pageIndex = i;
    const pageData = documentState.pages.get(pageIndex);
    
    // Rasterize page to JPEG (Scale 1.5, Quality 0.6)
    const jsPage = await pdfJsDoc.getPage(i + 1);
    const viewport = jsPage.getViewport({ scale: 1.5 });
    const canvas = window.document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext('2d');
    if (context) {
      await jsPage.render({ canvasContext: context, viewport, canvas }).promise;
    }
    const jpegBase64 = canvas.toDataURL('image/jpeg', quality);
    
    const jpgImage = await newPdf.embedJpg(jpegBase64);
    
    // Create new PDF page with standard aspect ratio (scale 1.0 equivalent)
    const page = newPdf.addPage([viewport.width / 1.5, viewport.height / 1.5]);
    const { width, height } = page.getSize();
    
    page.drawImage(jpgImage, {
      x: 0,
      y: 0,
      width: width,
      height: height,
    });

    if (pageData) {
      const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);
      bboxMeta[String(pageIndex)] = sortedBlocks.map(b => ({
        bbox: b.bbox,
        writingMode: b.writingMode,
        order: b.order,
        text: b.text
      }));

      for (const block of sortedBlocks) {
        if (!block.text) continue;
        try {
          if (block.writingMode === 'vertical') {
            const fontSize = 1;
            let textWidth = block.text.length;
            let textHeight = 1.448;
            try {
              textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
              textHeight = customFont.heightAtSize(fontSize) || textHeight;
            } catch(e) {}
            
            const sx = block.bbox.width / textHeight;
            const sy = block.bbox.height / textWidth;
            const baselineX = block.bbox.x + textHeight * sx * 0.2;
            const baselineY = height - block.bbox.y;
            
            page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
            page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
            page.pushOperators(popGraphicsState());
          } else {
            const fontSize = 1;
            let textWidth = block.text.length;
            let textHeight = 1.448;
            try {
              textWidth = customFont.widthOfTextAtSize(block.text, fontSize) || textWidth;
              textHeight = customFont.heightAtSize(fontSize) || textHeight;
            } catch(e) {}
            
            const sx = block.bbox.width / textWidth;
            const sy = block.bbox.height / textHeight;
            const baselineY = height - block.bbox.y - textHeight * sy * 0.8;
            
            page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
            page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, opacity: 0 });
            page.pushOperators(popGraphicsState());
          }
        } catch(e) {}
      }
    }
  }

  newPdf.setTitle(documentState.metadata?.title || 'OCR Document');
  newPdf.setCreator('PecoTool V2');
  
  let infoDict = (newPdf as any).getInfoDict();
  if (!infoDict) {
    infoDict = (newPdf as any).getInfoDict();
  }
  if (infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  return await newPdf.save({ useObjectStreams: true, addDefaultPage: false });
}

export async function estimateSizes(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument
): Promise<{ uncompressed: number; compressed: number }> {
  const pdfDoc = await buildPdfDocument(originalPdfBytes, documentState);
  const [uncompressedBytes, compressedBytes] = await Promise.all([
    pdfDoc.save({ useObjectStreams: false, addDefaultPage: false }),
    pdfDoc.save({ useObjectStreams: true, addDefaultPage: false })
  ]);

  return {
    uncompressed: uncompressedBytes.length,
    compressed: compressedBytes.length
  };
}
