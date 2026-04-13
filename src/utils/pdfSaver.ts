import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale, PDFName, PDFHexString, PDFString, PDFRawStream, PDFArray
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
/**
 * Strips all text blocks (BT...ET) from a decoded (uncompressed) content stream.
 * Optimized to work directly on Uint8Array to avoid expensive string conversions and regex.
 */
function stripTextBlocks(decoded: Uint8Array): Uint8Array {
  const result = new Uint8Array(decoded.length);
  let resultIdx = 0;
  let i = 0;
  const len = decoded.length;

  while (i < len) {
    // Look for "BT" (Begin Text)
    // Must be preceded by delimiter (space, tab, newline, (, [, <, /, %) or start of stream
    // and followed by delimiter.
    if (
      decoded[i] === 0x42 && decoded[i+1] === 0x54 && // 'BT'
      (i === 0 || decoded[i-1] <= 0x20 || decoded[i-1] === 0x28 || decoded[i-1] === 0x5b || decoded[i-1] === 0x3c || decoded[i-1] === 0x2f || decoded[i-1] === 0x25) && 
      (i + 2 === len || decoded[i+2] <= 0x20 || decoded[i+2] === 0x28 || decoded[i+2] === 0x5b || decoded[i+2] === 0x3c || decoded[i+2] === 0x2f || decoded[i+2] === 0x25)
    ) {
      // Found BT, skip until "ET" (End Text)
      i += 2;
      while (i < len) {
        if (
          decoded[i] === 0x45 && decoded[i+1] === 0x54 && // 'ET'
          (i === 0 || decoded[i-1] <= 0x20 || decoded[i-1] === 0x28 || decoded[i-1] === 0x5b || decoded[i-1] === 0x3c || decoded[i-1] === 0x2f || decoded[i-1] === 0x25) &&
          (i + 2 === len || decoded[i+2] <= 0x20 || decoded[i+2] === 0x28 || decoded[i+2] === 0x5b || decoded[i+2] === 0x3c || decoded[i+2] === 0x2f || decoded[i+2] === 0x25)
        ) {
          i += 2;
          break;
        }
        i++;
      }
    } else {
      result[resultIdx++] = decoded[i++];
    }
  }

  return result.slice(0, resultIdx);
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
  // throwOnInvalidObject:false → 不正オブジェクトの回復試行をスキップして高速化
  // updateMetadata:false → 更新日時の自動書き換えを抑制
  const pdfDoc = await PDFDocument.load(originalPdfBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  pdfDoc.registerFontkit(fontkit);

  const dirtyPages = Array.from(documentState.pages.entries()).filter(([, pageData]) => pageData.isDirty);
  
  // Only embed font if we actually have something to draw
  const needsFont = dirtyPages.some(([, pageData]) => 
    pageData.textBlocks.some(b => b.text && b.text.trim() !== '')
  );

  const customFont = needsFont
    ? (fontBytes
        ? await pdfDoc.embedFont(fontBytes, { subset: true })
        : await pdfDoc.embedFont(StandardFonts.Helvetica))
    : null;

  const infoDict = (pdfDoc as any).getInfoDict();
  let existingBBoxMeta: Record<string, any> = {};

  if (infoDict) {
    try {
      const value = infoDict.get(PDFName.of('PecoToolBBoxes'));
      if (value instanceof PDFHexString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
      } else if (value instanceof PDFString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
      }
    } catch { /* ignore parse errors */ }
  }

  const bboxMeta = { ...existingBBoxMeta };
  let metaChanged = false;

  for (const [pageIndexStr, pageData] of dirtyPages) {
    const pageIndex = typeof pageIndexStr === 'string' ? parseInt(pageIndexStr, 10) : pageIndexStr;
    
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
    const contentStreamsRef = (page.node as any).Contents();
    if (contentStreamsRef) {
      const resolved = pdfDoc.context.lookup(contentStreamsRef);
      let streams: any[] = [];
      if (resolved instanceof PDFArray) {
        streams = resolved.asArray();
      } else {
        streams = [contentStreamsRef];
      }
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

    if (!customFont) continue;

    // Now draw the NEW text blocks onto the cleaned page
    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = 1;
        const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
        const textHeight = customFont.heightAtSize(fontSize);
        
        if (textWidth === 0 || textHeight === 0) {
          console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (zero font metrics) text="${block.text.slice(0, 20)}"`);
          continue;
        }

        if (block.writingMode === 'vertical') {
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;

          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;

          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
          page.pushOperators(popGraphicsState());
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          
          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

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

  // update: true = incremental update: original PDF bytes are preserved at the
  // front of the output, so the original PDF version and structure are retained as-is.
  // This ensures compatibility with older viewers such as Acrobat 7 (supports up to PDF 1.6).
  const savedBytes = await pdfDoc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    update: true,
  });
  return savedBytes;
}


let activeSaveWorker: Worker | null = null;

export async function savePDF(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  // Use direct call if Worker is not available (e.g. in JSDOM tests)
  if (typeof Worker === 'undefined' || (typeof process !== 'undefined' && process.env.NODE_ENV === 'test')) {
    return await buildPdfDocument(originalPdfBytes, documentState, fontBytes);
  }

  // 前回の保存が完了していない場合は強制終了して新しい保存を優先する
  if (activeSaveWorker) {
    activeSaveWorker.terminate();
    activeSaveWorker = null;
  }

  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
      activeSaveWorker = worker;

      const cleanup = () => {
        if (activeSaveWorker === worker) activeSaveWorker = null;
        worker.terminate();
      };

      worker.onmessage = (e) => {
        const { type, data, message } = e.data;
        if (type === 'SAVE_PDF_SUCCESS') {
          cleanup();
          resolve(data);
        } else if (type === 'ERROR') {
          cleanup();
          reject(new Error(message));
        }
      };

      worker.onerror = (err) => {
        cleanup();
        reject(err);
      };

      const serializedPages: Record<number, any> = {};
      for (const [idx, page] of documentState.pages.entries()) {
        // thumbnail は Worker 内で不要な blob URL であるため除去する
        // (structured clone でエラーになる可能性があり、転送コスト削減にもなる)
        const { thumbnail: _t, ...pageWithoutThumbnail } = page as any;
        serializedPages[idx] = pageWithoutThumbnail;
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
      activeSaveWorker = null;
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(originalPdfBytes, documentState, fontBytes).then(resolve).catch(reject);
    }
  });
}

