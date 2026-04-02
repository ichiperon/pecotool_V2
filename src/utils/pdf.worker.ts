import { PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts, pushGraphicsState, popGraphicsState, translate, scale, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Worker context doesn't have access to the main thread's memory, 
// so we need to pass everything it needs.

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'SAVE_PDF') {
    try {
      const { originalPdfBytes, documentState, compression, fontBytes } = data;
      
      // Note: Rasterization involves Canvas, which is NOT available in standard Web Workers.
      // For now, we handle the non-rasterized buildPdfDocument logic here.
      // If rasterization is needed, we'd need OffscreenCanvas support.
      
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

      // Map serialization is tricky, data should be plain objects
      const pagesArray = Object.entries(documentState.pages);

      for (const [pageIndexStr, pageDataAny] of pagesArray) {
        const pageIndex = parseInt(pageIndexStr, 10);
        const pageData = pageDataAny as any;
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
        }
      }

      if (infoDict) {
        infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
      }

      const savedBytes = await pdfDoc.save({ useObjectStreams: compression === 'compressed', addDefaultPage: false });
      self.postMessage({ type: 'SAVE_PDF_SUCCESS', data: savedBytes }, [savedBytes.buffer] as any);
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
  }
};
