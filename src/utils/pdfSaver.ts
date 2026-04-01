import { PDFDocument, PDFName, PDFString, degrees, pushGraphicsState, popGraphicsState, translate, scale, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';

export async function savePDF(originalPdfBytes: Uint8Array, documentState: PecoDocument): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  pdfDoc.registerFontkit(fontkit);
  
  // Load Japanese font
  let customFont = undefined;
  try {
    const fontBytes = await fetch('/fonts/NotoSansJP-Regular.otf').then(res => res.arrayBuffer());
    customFont = await pdfDoc.embedFont(fontBytes);
  } catch (err) {
    console.error("Failed to load custom Japanese font:", err);
  }

  for (const [pageIndex, pageData] of documentState.pages.entries()) {
    if (!pageData.isDirty) continue;

    const page = pdfDoc.getPage(pageIndex);

    // 1. Strip the old OCR text directly from the PDF's content streams (Lossless image preservation)
    const { Contents } = page.node.normalizedEntries();
    if (Contents) {
      // PDF handles Contents as either a single stream or an array of streams
      const refs = typeof Contents.asArray === 'function' ? Contents.asArray() : [Contents];
      for (const ref of refs) {
        const stream = pdfDoc.context.lookup(ref);
        if (stream && stream.constructor.name === 'PDFRawStream') {
          try {
            // Decode the raw stream into bytes
            const decoded = decodePDFRawStream(stream as any).decode();
            // Convert to string (latin1 preserves bytes safely for PDF operators)
            const str = Array.from(decoded).map(b => String.fromCharCode(b)).join('');
            
            // Purge all Text Objects (BT ... ET)
            // This safely removes the old invisible OCR text without touching image XObjects
            const stripped = str.replace(/(?:^|[\s])BT[\s\S]*?ET(?:[\s]|$)/g, '\n');
            
            // Re-encode and overwrite the stream
            const newBytes = new Uint8Array(stripped.length);
            for (let i = 0; i < stripped.length; i++) {
              newBytes[i] = stripped.charCodeAt(i);
            }
            const newStream = pdfDoc.context.flateStream(newBytes);
            pdfDoc.context.assign(ref, newStream);
          } catch (err) {
            console.warn(`Failed to strip text from stream on page ${pageIndex}:`, err);
          }
        }
      }
    }

    // 2. Draw the new edited text blocks
    const viewport1x = { width: page.getWidth(), height: page.getHeight() };
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    for (const block of sortedBlocks) {
      if (block.writingMode === 'vertical') {
        const textLen = block.text.length;
        const textWidth = customFont ? customFont.widthOfTextAtSize(block.text, 1) : textLen;
        
        const sx = block.bbox.width / 1.448;
        const sy = block.bbox.height / textWidth;
        const baselineX = block.bbox.x + 0.288 * sx;
        const baselineY = viewport1x.height - block.bbox.y;
        
        page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
        const drawOptions: any = { x: 0, y: 0, size: 1, rotate: degrees(-90), opacity: 0 };
        if (customFont) drawOptions.font = customFont;
        try {
          page.drawText(block.text, drawOptions);
        } catch (err) {
          console.warn("Skipping text block due to encoding error:", block.text, err);
        }
        page.pushOperators(popGraphicsState());
      } else {
        const textLen = block.text.length;
        const textWidth = customFont ? customFont.widthOfTextAtSize(block.text, 1) : textLen;
        
        const sx = block.bbox.width / textWidth;
        const sy = block.bbox.height / 1.448;
        const baselineY = viewport1x.height - block.bbox.y - 1.16 * sy;
        
        page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
        const drawOptions: any = { x: 0, y: 0, size: 1, opacity: 0 };
        if (customFont) drawOptions.font = customFont;
        try {
          page.drawText(block.text, drawOptions);
        } catch (err) {
          console.warn("Skipping text block due to encoding error:", block.text, err);
        }
        page.pushOperators(popGraphicsState());
      }
    }
  }

  // Embed BBox metadata into PDF Info dict for lossless round-trip on re-open
  try {
    const bboxMeta: Record<string, Array<{
      bbox: { x: number; y: number; width: number; height: number };
      writingMode: string;
      order: number;
      text: string;
    }>> = {};

    for (const [pageIndex, pageData] of documentState.pages.entries()) {
      bboxMeta[String(pageIndex)] = pageData.textBlocks
        .sort((a, b) => a.order - b.order)
        .map(b => ({
          bbox: { x: b.bbox.x, y: b.bbox.y, width: b.bbox.width, height: b.bbox.height },
          writingMode: b.writingMode,
          order: b.order,
          text: b.text,
        }));
    }

    const ctx = (pdfDoc as any).context;
    const infoRef = ctx.trailerInfo?.Info;
    if (infoRef) {
      const infoDict = ctx.lookup(infoRef);
      if (infoDict) {
        infoDict.set(PDFName.of('PecoToolBBoxes'), PDFString.of(JSON.stringify(bboxMeta)));
      }
    }
  } catch (err) {
    console.warn("Failed to embed bbox metadata:", err);
  }

  return await pdfDoc.save();
}
