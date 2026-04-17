import {
  PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, PDFRawStream,
  pushGraphicsState, popGraphicsState, translate, scale, degrees, PDFArray,
  PDFDict, PDFRef, PDFObject
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflate } from 'pako';
import type { TextBlock } from '../types';
import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';

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

  // Resolve filter names — Filter can be a single PDFName or a PDFArray of names.
  let filterNames: string[];
  if (filter instanceof PDFName) {
    filterNames = [filter.asString()];
  } else if (filter instanceof PDFArray) {
    // Use .asArray() — PDFArray does NOT expose a .array property
    filterNames = filter.asArray().map((f) => (f as PDFName).asString());
  } else if (!filter) {
    // No filter — bytes are already plain content operators
    return raw;
  } else {
    // Unknown filter type — skip modification to avoid corrupting the stream
    return null;
  }

  if (filterNames.length === 0) return raw;

  // Only handle a single /FlateDecode; multi-filter chains are left untouched.
  if (filterNames.length === 1 && filterNames[0] === '/FlateDecode') {
    try {
      return inflate(raw);
    } catch {
      return null;
    }
  }

  // Unsupported filter (LZW, ASCII85, multi-filter chain, etc.) — skip modification
  return null;
}

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
    // Must be preceded by delimiter (space, tab, newline) or start of stream
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

async function handleSavePdf(
  originalPdfBytes: Uint8Array,
  documentState: { pages: Record<number, SerializedPageData> },
  fontBytes: ArrayBuffer | undefined,
): Promise<Uint8Array> {
  const originalVersion = extractPdfVersion(originalPdfBytes);
  // throwOnInvalidObject:false → 不正オブジェクトの回復試行をスキップして高速化
  // updateMetadata:false → 更新日時の自動書き換えを抑制（不要な書き込み削減）
  const pdfDoc = await PDFDocument.load(originalPdfBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  pdfDoc.registerFontkit(fontkit);

  const pagesArray = Object.entries(documentState.pages) as Array<[string, SerializedPageData]>;
  const dirtyPages = pagesArray.filter(([, pageData]) => pageData.isDirty);

  // Only embed font if we actually have something to draw
  const needsFont = dirtyPages.some(([, pageData]) =>
    pageData.textBlocks.some((b: TextBlock) => b.text && b.text.trim() !== '')
  );

  const customFont = needsFont
    ? (fontBytes
        ? await pdfDoc.embedFont(fontBytes, { subset: true })
        : await pdfDoc.embedFont(StandardFonts.Helvetica))
    : null;

  // getInfoDict() は pdf-lib の public API には無いため、構造型アサーションで呼び出す（pdfSaver.ts と同じ方針）
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  let existingBBoxMeta: Record<string, unknown> = {};

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

  const bboxMeta: Record<string, unknown> = { ...existingBBoxMeta };
  let metaChanged = false;

  for (const [pageIndexStr, pageData] of dirtyPages) {
    const pageIndex = parseInt(pageIndexStr, 10);

    const sortedBlocks: TextBlock[] = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

    bboxMeta[String(pageIndex)] = sortedBlocks.map((b) => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text,
    }));
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    // --- Surgical Text Stripping ---
    // page.node.Contents() は pdf-lib の public API に型定義が無い
    const contentStreamsRef = (page.node as unknown as { Contents(): PDFObject | PDFRef | undefined }).Contents();
    if (contentStreamsRef) {
      const resolved = pdfDoc.context.lookup(contentStreamsRef);
      let streams: PDFObject[] = [];
      if (resolved instanceof PDFArray) {
        streams = resolved.asArray();
      } else {
        streams = [contentStreamsRef];
      }
      const newStreams: PDFObject[] = [];

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
      } catch (e) {
        console.warn(`[pdf.worker] Page ${pageIndex} block error:`, e);
      }
    }
  }

  if (metaChanged && infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  // update:true は @cantoo/pdf-lib の拡張オプション（型定義には無いが実装側で受理される）
  const saveOptions: Parameters<typeof pdfDoc.save>[0] & { update?: boolean } = {
    useObjectStreams: false,
    addDefaultPage: false,
    update: true,
  };
  const savedBytes = await pdfDoc.save(saveOptions);
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);
  return savedBytes;
}

// Worker scope での self 型付け。WebWorker lib を tsconfig で有効化しているため DedicatedWorkerGlobalScope が使える。
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<SavePdfWorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'SAVE_PDF': {
      try {
        const { originalPdfBytes, documentState, fontBytes } = msg.data;
        const savedBytes = await handleSavePdf(originalPdfBytes, documentState, fontBytes);
        const response: SavePdfWorkerResponse = { type: 'SAVE_PDF_SUCCESS', data: savedBytes };
        self.postMessage(response, [savedBytes.buffer]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const response: SavePdfWorkerResponse = { type: 'ERROR', message };
        self.postMessage(response);
      }
      break;
    }
    default: {
      // 網羅性チェック: 新しい request type を追加した時にコンパイルエラーで気づけるようにする。
      const _exhaustive: never = msg.type;
      void _exhaustive;
      break;
    }
  }
};
