import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale, PDFName, PDFHexString, PDFString, PDFRawStream
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import { inflate } from 'pako';

/**
 * Decompress a PDFRawStream's contents.
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
/**
 * Returns decompressed stream contents, or null if decoding failed / unsupported filter.
 * Callers must skip stream modification when null is returned.
 */
function decodeStreamContents(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();
  if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
    try {
      return inflate(raw);
    } catch {
      return null;
    }
  }
  if (!filter) {
    // No compression — raw bytes are already plain text operators
    return raw;
  }
  // Unsupported filter (LZW, ASCII85, etc.) — skip modification
  return null;
}

/**
 * Strips all text blocks (BT...ET) from a decoded (uncompressed) content stream.
 * BT and ET must appear as standalone tokens (surrounded by whitespace or line boundaries)
 * to avoid accidentally matching binary data that happens to contain those byte sequences.
 * The input MUST be already decoded bytes — do NOT pass raw/compressed stream contents.
 * We use 'latin1' so each byte maps 1:1 to a character, avoiding UTF-8 corruption.
 */
function stripTextBlocks(decodedContent: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('latin1');
  const text = decoder.decode(decodedContent);
  // BT and ET must be standalone PDF operators (preceded/followed by whitespace or line end).
  // This prevents matching binary content that coincidentally contains 0x42 0x54 or 0x45 0x54.
  const stripped = text.replace(/(^|[\r\n\s])BT[\s\S]*?ET([\r\n\s]|$)/g, '$1$2');
  const result = new Uint8Array(stripped.length);
  for (let i = 0; i < stripped.length; i++) {
    result[i] = stripped.charCodeAt(i) & 0xFF;
  }
  return result;
}

/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
 * Powered by @cantoo/pdf-lib.
 */

export async function buildPdfDocument(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
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
  let metaChanged = false;

  for (const [pageIndexStr, pageData] of documentState.pages.entries()) {
    const pageIndex = typeof pageIndexStr === 'string' ? parseInt(pageIndexStr, 10) : pageIndexStr;
    
    // Only update metadata and draw if the page was touched
    if (!pageData.isDirty) continue;

    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);
    bboxMeta[String(pageIndex)] = sortedBlocks.map(b => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text
    }));
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    // --- Surgical Text Stripping ---
    const contentStreams = (page.node as any).Contents();
    if (contentStreams) {
      const streams = Array.isArray(contentStreams) ? contentStreams : [contentStreams];
      const newStreams = [];
      for (const streamRef of streams) {
        const stream = pdfDoc.context.lookup(streamRef);
        if (stream instanceof PDFRawStream) {
          const decoded = decodeStreamContents(stream);
          if (decoded !== null) {
            const cleaned = stripTextBlocks(decoded);
            const newStream = pdfDoc.context.flateStream(cleaned);
            newStreams.push(pdfDoc.context.register(newStream));
          } else {
            newStreams.push(streamRef);
          }
        } else {
          newStreams.push(streamRef);
        }
      }
      page.node.set(PDFName.of('Contents'), pdfDoc.context.obj(newStreams));
    }

    // Now draw the NEW text blocks onto the cleaned page
    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = 1;
        const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
        const textHeight = customFont.heightAtSize(fontSize);
        
        if (textWidth === 0 || textHeight === 0) continue;

        if (block.writingMode === 'vertical') {
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;
          
          if (!isFinite(sx) || !isFinite(sy)) continue;

          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;

          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
          page.pushOperators(popGraphicsState());
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          
          if (!isFinite(sx) || !isFinite(sy)) continue;

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

  if (metaChanged && infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  // rewrite: false (default) = incremental update: original PDF bytes are preserved at the
  // front of the output, so the original PDF version and structure are retained as-is.
  // This ensures compatibility with older viewers such as Acrobat 7 (supports up to PDF 1.6).
  const savedBytes = await pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });
  return savedBytes;
}


export async function savePDF(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  // Use direct call if Worker is not available (e.g. in JSDOM tests)
  if (typeof Worker === 'undefined' || (typeof process !== 'undefined' && process.env.NODE_ENV === 'test')) {
    return await buildPdfDocument(originalPdfBytes, documentState, fontBytes);
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

      // Transfer the buffer directly if possible to avoid copying large files
      // Note: We slice() here because pdf-lib's load() might be affected if we transfer the underlying buffer
      // But actually originalPdfBytes is a Uint8Array, so originalPdfBytes.buffer is the ArrayBuffer.
      // To keep it in main thread, we MUST copy.
      const bytesClone = originalPdfBytes.slice();
      const transferables: Transferable[] = [bytesClone.buffer];
      const fontBytesClone = fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined;
      if (fontBytesClone) transferables.push(fontBytesClone);

      worker.postMessage({
        type: 'SAVE_PDF',
        data: {
          originalPdfBytes: bytesClone,
          documentState: { ...documentState, pages: serializedPages },
          fontBytes: fontBytesClone,
        }
      }, transferables);
    } catch (err) {
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(originalPdfBytes, documentState, fontBytes).then(resolve).catch(reject);
    }
  });
}

