import {
  PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, PDFRawStream,
  pushGraphicsState, popGraphicsState, translate, scale, degrees
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflate } from 'pako';

/**
 * Decompress a PDFRawStream's contents.
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
function extractPdfVersion(bytes: Uint8Array): string | null {
  const header = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  const m = header.match(/%PDF-(\d+\.\d+)/);
  return m ? m[1] : null;
}

function restorePdfVersion(savedBytes: Uint8Array, version: string): void {
  const target = `%PDF-${version}`;
  const current = new TextDecoder('latin1').decode(savedBytes.slice(0, 16));
  const m = current.match(/%PDF-\d+\.\d+/);
  if (!m || current.startsWith(target)) return;
  const patch = new TextEncoder().encode(target);
  for (let i = 0; i < patch.length && i < m[0].length; i++) {
    savedBytes[m.index! + i] = patch[i];
  }
}

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
    return raw;
  }
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
  const stripped = text.replace(/(^|[\r\n\s])BT[\s\S]*?ET([\r\n\s]|$)/g, '$1$2');
  const result = new Uint8Array(stripped.length);
  for (let i = 0; i < stripped.length; i++) {
    result[i] = stripped.charCodeAt(i) & 0xFF;
  }
  return result;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'SAVE_PDF') {
    try {
      const { originalPdfBytes, documentState, fontBytes } = data;

      const originalVersion = extractPdfVersion(originalPdfBytes);
      const pdfDoc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
      pdfDoc.registerFontkit(fontkit);

      const customFont = fontBytes
        ? await pdfDoc.embedFont(fontBytes, { subset: true })
        : await pdfDoc.embedFont(StandardFonts.Helvetica);

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
      const pagesArray = Object.entries(documentState.pages);
      let metaChanged = false;

      for (const [pageIndexStr, pageDataAny] of pagesArray) {
        const pageIndex = parseInt(pageIndexStr, 10);
        const pageData = pageDataAny as any;

        if (!pageData.isDirty) continue;

        const sortedBlocks = [...pageData.textBlocks].sort((a: any, b: any) => a.order - b.order);

        bboxMeta[String(pageIndex)] = sortedBlocks.map((b: any) => ({
          bbox: b.bbox,
          writingMode: b.writingMode,
          order: b.order,
          text: b.text,
        }));
        metaChanged = true;

        const page = pdfDoc.getPage(pageIndex);
        const { height } = page.getSize();

        // --- Surgical Text Stripping ---
        // Decode each stream first (decompresses FlateDecode/LZW/etc.), then strip BT..ET,
        // then re-compress. Passing raw (still-compressed) bytes to stripTextBlocks would
        // produce no-op replacements because BT/ET markers are not visible in compressed data.
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
            console.warn(`[pdf.worker] Page ${pageIndex} block error:`, e);
          }
        }
      }

      if (metaChanged && infoDict) {
        infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
      }

      const savedBytes = await pdfDoc.save({
        useObjectStreams: false,
        addDefaultPage: false,
      });
      if (originalVersion) restorePdfVersion(savedBytes, originalVersion);
      self.postMessage({ type: 'SAVE_PDF_SUCCESS', data: savedBytes }, [savedBytes.buffer] as any);
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
  }
};
