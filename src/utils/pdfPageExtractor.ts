import { PDFDocument } from '@cantoo/pdf-lib';

/**
 * Returns true when the PDF header declares encryption.
 * Used by callers to warn users before proceeding (issue #256).
 */
export function isPdfEncrypted(bytes: Uint8Array): boolean {
  // pdf-lib's PDFDocument.isEncrypted() is available after load, but loading with
  // ignoreEncryption:false throws on encrypted files. Detect via trailer /Encrypt key
  // as a lightweight pre-check by scanning the last ~2KB for the Encrypt dictionary.
  const tail = bytes.slice(Math.max(0, bytes.length - 2048));
  const text = new TextDecoder('latin1').decode(tail);
  return /\/Encrypt\s/.test(text);
}

/**
 * Extract specified pages from the original PDF bytes into a new PDF document.
 *
 * V1: Only the raw page content is copied (via pdf-lib copyPages).
 * PecoTool edits (textBlocks, rotation, curve) are NOT applied to the extracted PDF.
 * Applying edits is deferred to a future enhancement.
 *
 * NOTE (issue #256): ignoreEncryption:true is intentional — pdf-lib cannot decrypt
 * owner-password PDFs, but can still copy pages. Callers should warn users when
 * isPdfEncrypted() returns true so they understand content may be incomplete.
 *
 * @param originalPdfBytes - Raw bytes of the source PDF
 * @param pageIndices - 0-based page indices to extract (in order)
 * @returns Bytes of the new PDF containing only the specified pages
 * @throws Error if pageIndices is empty or contains out-of-range indices
 */
export async function extractPagesToNewPdf(
  originalPdfBytes: Uint8Array,
  pageIndices: number[],
): Promise<Uint8Array> {
  if (pageIndices.length === 0) {
    throw new Error('[extractPagesToNewPdf] pageIndices must not be empty');
  }

  const srcDoc = await PDFDocument.load(originalPdfBytes, {
    // issue #256: ignoreEncryption allows page copy from owner-protected PDFs.
    // isPdfEncrypted() lets callers surface a user-visible warning before this call.
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  const srcPageCount = srcDoc.getPageCount();
  for (const idx of pageIndices) {
    if (idx < 0 || idx >= srcPageCount) {
      throw new Error(
        `[extractPagesToNewPdf] page index ${idx} is out of range (0..${srcPageCount - 1})`,
      );
    }
  }

  const dstDoc = await PDFDocument.create();
  const copiedPages = await dstDoc.copyPages(srcDoc, pageIndices);
  for (const page of copiedPages) {
    dstDoc.addPage(page);
  }

  return dstDoc.save({ useObjectStreams: false });
}
