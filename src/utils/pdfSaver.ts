import { PDFDocument } from 'pdf-lib';
import { PecoDocument } from '../types';

export async function savePDF(originalPdfBytes: Uint8Array, documentState: PecoDocument): Promise<Uint8Array> {
  // Load the original document
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const pages = pdfDoc.getPages();

  // Iterate over edited pages and apply changes
  for (const [pageIndex, pageData] of documentState.pages.entries()) {
    if (!pageData.isDirty) continue;

    const page = pages[pageIndex];
    const { height } = page.getSize();

    // Since we can't easily edit the existing content stream flawlessly while preserving images
    // without deep parsing in pure JS, a standard approach for this kind of "OCR fix" is to 
    // clear existing text (or hide it) and draw the new text on top as transparent.
    // However, hiding existing text perfectly without removing images is complex in pdf-lib.
    // Given the constraints and pdf-lib capabilities, we will overlay the new text as transparent
    // text. For a robust professional tool, a lower-level library like mupdf is usually needed to 
    // strip *only* text operators. Here, we add our edited text layer over the page.

    // A simple, reliable approach for pure text replacement:
    // We add transparent text at the exact bounding boxes based on the current state.
    // If the original PDF had transparent text (OCR), it might still be there. 
    // To truly remove old text, we'd need to parse the content stream and filter out text operators (Tj, TJ, etc.).
    // For this prototype, we'll embed the new text which will be selectable.

    // Sort blocks by order to ensure logical reading order in the content stream
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    for (const block of sortedBlocks) {
      // Add text with opacity 0 to make it invisible but selectable
      // pdf-lib uses bottom-left origin. Our bbox.y is top-left origin.
      // So y_bottom_left = page_height - y_top_left - height
      const y_bottom_left = height - block.bbox.y - block.bbox.height;

      page.drawText(block.text, {
        x: block.bbox.x,
        y: y_bottom_left,
        size: block.bbox.height, // Approximate font size by block height
        opacity: 0, 
      });
    }
  }

  // Serialize the PDFDocument to bytes (a Uint8Array)
  return await pdfDoc.save();
}
