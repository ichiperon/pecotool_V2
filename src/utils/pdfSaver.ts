import { PDFDocument, PDFName, PDFString, degrees, pushGraphicsState, popGraphicsState, translate, scale } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjsLib from 'pdfjs-dist';
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

  // We use pdfjsLib to rasterize the original pages so we can completely wipe original OCR text
  const pdfjsDoc = await pdfjsLib.getDocument({ data: originalPdfBytes.slice() }).promise;

  for (const [pageIndex, pageData] of documentState.pages.entries()) {
    if (!pageData.isDirty) continue;

    const pdfjsPage = await pdfjsDoc.getPage(pageIndex + 1);
    const viewport1x = pdfjsPage.getViewport({ scale: 1.0 });
    const viewport2x = pdfjsPage.getViewport({ scale: 2.0 }); // 2x scale for better print quality

    // Render the page to a canvas (this ignores invisible text like opacity=0 OCR data)
    const canvas = document.createElement('canvas');
    canvas.width = viewport2x.width;
    canvas.height = viewport2x.height;
    const context = canvas.getContext('2d')!;

    // Fill white background for JPEG
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await pdfjsPage.render({ canvasContext: context, viewport: viewport2x, canvas: canvas }).promise;

    // Convert to JPEG blob for much smaller file size compared to PNG
    const jpgBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!jpgBlob) continue;
    
    const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
    const embeddedImage = await pdfDoc.embedJpg(jpgBytes);

    // Completely replace the old page (with the old OCR text) with a fresh new page
    pdfDoc.removePage(pageIndex);
    const newPage = pdfDoc.insertPage(pageIndex, [viewport1x.width, viewport1x.height]);

    // Draw the rasterized background
    newPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: viewport1x.width,
      height: viewport1x.height,
    });

    // Sort blocks by logical order to ensure copy-paste order is correct
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    // Overlay ONLY the newly edited text as selectable transparent text
    for (const block of sortedBlocks) {
      if (block.writingMode === 'vertical') {
        const textLen = block.text.length;
        const textWidth = customFont ? customFont.widthOfTextAtSize(block.text, 1) : textLen;
        
        const sx = block.bbox.width / 1.448;
        const sy = block.bbox.height / textWidth;
        const baselineX = block.bbox.x + 0.288 * sx;
        const baselineY = viewport1x.height - block.bbox.y;
        
        newPage.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
        const drawOptions: any = { x: 0, y: 0, size: 1, rotate: degrees(-90), opacity: 0 };
        if (customFont) drawOptions.font = customFont;
        try {
          newPage.drawText(block.text, drawOptions);
        } catch (err) {
          console.warn("Skipping text block due to encoding error:", block.text, err);
        }
        newPage.pushOperators(popGraphicsState());
      } else {
        const textLen = block.text.length;
        const textWidth = customFont ? customFont.widthOfTextAtSize(block.text, 1) : textLen;
        
        const sx = block.bbox.width / textWidth;
        const sy = block.bbox.height / 1.448;
        const baselineY = viewport1x.height - block.bbox.y - 1.16 * sy;
        
        newPage.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
        const drawOptions: any = { x: 0, y: 0, size: 1, opacity: 0 };
        if (customFont) drawOptions.font = customFont;
        try {
          newPage.drawText(block.text, drawOptions);
        } catch (err) {
          console.warn("Skipping text block due to encoding error:", block.text, err);
        }
        newPage.pushOperators(popGraphicsState());
      }
    }
  }

  // Embed BBox metadata into PDF Info dict for lossless round-trip on re-open
  // Stores ALL pages' bbox data so re-loading recovers exact sizes without relying on font metrics
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

    // Write custom key into the PDF Info dictionary via pdf-lib low-level API
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
