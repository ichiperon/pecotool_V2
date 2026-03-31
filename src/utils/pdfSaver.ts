import { PDFDocument } from 'pdf-lib';
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
      const y_bottom_left = viewport1x.height - block.bbox.y - block.bbox.height;

      const drawOptions: any = {
        x: block.bbox.x,
        y: y_bottom_left,
        size: block.bbox.height,
        opacity: 0,
      };

      if (customFont) {
        drawOptions.font = customFont;
      }

      try {
        newPage.drawText(block.text, drawOptions);
      } catch (err) {
        console.warn("Skipping text block due to encoding error:", block.text, err);
      }
    }
  }

  return await pdfDoc.save();
}
