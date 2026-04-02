import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, translate, scale, PDFName, PDFHexString, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import * as pdfjsLib from 'pdfjs-dist';

/**
 * Common PDF building logic used by both Worker and direct calls (tests).
 * Returns the Uint8Array of the saved PDF.
 */
export async function buildPdfDocument(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  compression: 'none' | 'compressed' | 'rasterized' = 'none',
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  pdfDoc.registerFontkit(fontkit);

  const customFont = fontBytes 
    ? await pdfDoc.embedFont(fontBytes, { subset: true }) 
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
    } catch(e) {}
  }

  const bboxMeta = { ...existingBBoxMeta };

  for (const [pageIndexStr, pageData] of documentState.pages.entries()) {
    const pageIndex = typeof pageIndexStr === 'string' ? parseInt(pageIndexStr, 10) : pageIndexStr;
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
          const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
          const textHeight = customFont.heightAtSize(fontSize);
          
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;
          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;
          
          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
          page.pushOperators(popGraphicsState());
        } else {
          const fontSize = 1;
          const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
          const textHeight = customFont.heightAtSize(fontSize);
          
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          const baselineY = height - block.bbox.y - textHeight * sy * 0.8;
          
          page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, opacity: 0 });
          page.pushOperators(popGraphicsState());
        }
      } catch(e) {
        console.warn(`[buildPdfDocument] Page ${pageIndex} block error:`, e);
      }
    }
  }

  if (infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  return await pdfDoc.save({ useObjectStreams: compression === 'compressed', addDefaultPage: false });
}

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

  // Use direct call if Worker is not available (e.g. in JSDOM tests)
  if (typeof Worker === 'undefined' || (typeof process !== 'undefined' && process.env.NODE_ENV === 'test')) {
    return await buildPdfDocument(originalPdfBytes, documentState, compression, fontBytes);
  }

  return new Promise((resolve, reject) => {
    try {
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

      const serializedPages: Record<number, any> = {};
      for (const [idx, page] of documentState.pages.entries()) {
        serializedPages[idx] = page;
      }

      worker.postMessage({
        type: 'SAVE_PDF',
        data: {
          originalPdfBytes,
          documentState: { ...documentState, pages: serializedPages },
          compression,
          rasterizeQuality,
          fontBytes
        }
      }, [originalPdfBytes.buffer, fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined].filter(Boolean) as any);
    } catch (err) {
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(originalPdfBytes, documentState, compression, fontBytes).then(resolve).catch(reject);
    }
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
  
  const infoDict = (newPdf as any).getInfoDict();
  if (infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  return await newPdf.save({ useObjectStreams: true, addDefaultPage: false });
}

export async function estimateSizes(
  originalPdfBytes: Uint8Array,
  _documentState: PecoDocument
): Promise<{ uncompressed: number; compressed: number }> {
  // Use non-compressed save for uncompressed estimate
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const [uncompressedBytes, compressedBytes] = await Promise.all([
    pdfDoc.save({ useObjectStreams: false, addDefaultPage: false }),
    pdfDoc.save({ useObjectStreams: true, addDefaultPage: false })
  ]);

  return {
    uncompressed: uncompressedBytes.length,
    compressed: compressedBytes.length
  };
}
