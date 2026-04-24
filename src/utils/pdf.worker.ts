import {
  PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, PDFRawStream,
  pushGraphicsState, popGraphicsState, translate, scale, degrees, PDFArray,
  PDFDict
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflate } from 'pako';
import { stripTextBlocks } from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion } from './pdfVersion';
import { safeDecodePdfText } from './pdfLibSafeDecode';
import type { TextBlock } from '../types';
import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';
import type { PDFObject, PDFRef, PDFFont } from '@cantoo/pdf-lib';

/**
 * Decompress a PDFRawStream's contents.
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPecoToolFontKey(key: PDFName): boolean {
  const name = key.toString();
  return (
    name.startsWith('/IPAexGothic-') ||
    name.startsWith('/NotoSans-') ||
    name.startsWith('/NotoSansSymbols-') ||
    name.startsWith('/NotoSansSymbols2-')
  );
}

function isPecoToolGraphicsStateKey(key: PDFName): boolean {
  return /^\/GS-\d+$/.test(key.toString());
}

function isPdfRef(value: unknown): value is PDFRef {
  return typeof value === 'object' && value !== null && value.constructor?.name === 'PDFRef';
}

function pruneStalePecoToolResources(
  pageNode: { Resources?: () => PDFDict | undefined },
): void {
  const resources = pageNode.Resources?.();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);

  if (fontDict) {
    for (const [key] of fontDict.entries()) {
      if (!isPecoToolFontKey(key)) continue;
      fontDict.delete(key);
    }
  }

  const extGStateDict = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  if (extGStateDict) {
    for (const [key] of extGStateDict.entries()) {
      if (!isPecoToolGraphicsStateKey(key)) continue;
      extGStateDict.delete(key);
    }
  }
}

function replacePageTextContentStreams(
  pageNode: {
    get?: (key: PDFName) => PDFObject | undefined;
    Contents?: () => PDFObject | undefined;
    set: (key: PDFName, value: PDFObject) => void;
  },
  context: typeof PDFDocument.prototype.context,
): void {
  const contentsKey = PDFName.of('Contents');
  const rawContents = pageNode.get?.(contentsKey) ?? pageNode.Contents?.();
  if (!rawContents) return;

  const resolved = context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const newStreams: PDFObject[] = [];
  const staleStreamRefs = new Set<PDFRef>();

  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (stream instanceof PDFRawStream) {
      const decoded = decodeStreamContents(stream);
      if (decoded !== null) {
        const cleaned = stripTextBlocks(decoded);
        if (bytesEqual(cleaned, decoded)) {
          newStreams.push(streamRef);
        } else {
          const newStream = context.flateStream(cleaned);
          newStreams.push(context.register(newStream));
          if (isPdfRef(streamRef)) staleStreamRefs.add(streamRef);
        }
      } else {
        newStreams.push(streamRef);
      }
    } else {
      newStreams.push(streamRef);
    }
  }

  pageNode.set(contentsKey, context.obj(newStreams));
  if (isPdfRef(rawContents) && resolved instanceof PDFArray) {
    context.delete(rawContents);
  }
  for (const ref of staleStreamRefs) {
    context.delete(ref);
  }
}

interface FontRun {
  text: string;
  font: PDFFont;
}

function makeFontSupportSet(font: PDFFont): Set<number> | null {
  if (typeof font.getCharacterSet !== 'function') return null;
  return new Set(font.getCharacterSet());
}

function splitTextBySupportedFont(
  text: string,
  primaryFont: PDFFont,
  primarySupport: Set<number> | null,
  fallbackFonts: Array<{ font: PDFFont; support: Set<number> | null }>,
): FontRun[] {
  const runs: FontRun[] = [];
  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0);
    const font = codePoint !== undefined && primarySupport !== null && !primarySupport.has(codePoint)
      ? fallbackFonts.find((fallback) => fallback.support?.has(codePoint))?.font ?? primaryFont
      : primaryFont;
    const last = runs[runs.length - 1];
    if (last?.font === font) {
      last.text += char;
    } else {
      runs.push({ text: char, font });
    }
  }
  return runs;
}

function measureRuns(runs: FontRun[], size: number): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const run of runs) {
    width += run.font.widthOfTextAtSize(run.text, size);
    height = Math.max(height, run.font.heightAtSize(size));
  }
  return { width, height };
}

function setPageFontWithStableKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): void {
  const pageLike = page as {
    font?: PDFFont;
    fontKey?: PDFName;
    node?: { newFontDictionary?: (tag: string, fontRef: PDFRef) => PDFName };
    setFont?: (font: PDFFont) => void;
  };
  let key = fontKeys.get(font);
  if (!key) {
    key = pageLike.node?.newFontDictionary?.(font.name, font.ref);
    if (!key) {
      pageLike.setFont?.(font);
      key = pageLike.fontKey;
    }
    if (key) fontKeys.set(font, key);
  }
  pageLike.font = font;
  if (key) pageLike.fontKey = key;
}

async function handleSavePdf(
  originalPdfBytes: Uint8Array,
  documentState: { pages: Record<number, SerializedPageData> },
  fontBytes: ArrayBuffer | undefined,
  fallbackFontBytes: ArrayBuffer[] = [],
): Promise<Uint8Array> {
  const originalVersion = extractPdfVersion(originalPdfBytes);
  // forIncrementalUpdate + commit() は subset フォントの glyf を破損させるため撤回。
  // 全書き換えは 91ms 程度 (ベンチ実測) で速度差はほぼない。
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

  // フォントは TTF 形式で供給する必要がある。WOFF2 を直接食わせると fontkit が
  // loca/glyf を正しく出力できず、OTS 検証で「フォント抽出不能」になる。
  // ベンチで実 PDF roundtrip 検証済み: TTF + subset:true → warning ゼロ、
  // output size は原本と同じ (subset ~200KB のみ追加)。
  const customFont = needsFont
    ? (fontBytes
        ? await pdfDoc.embedFont(fontBytes, { subset: true })
        : await pdfDoc.embedFont(StandardFonts.Helvetica))
    : null;
  const fallbackFonts = customFont
    ? await Promise.all(fallbackFontBytes.map((bytes) => pdfDoc.embedFont(bytes, { subset: true })))
    : [];
  const primarySupport = customFont ? makeFontSupportSet(customFont) : new Set<number>();
  const fallbackFontSupports = fallbackFonts.map((font) => ({
    font,
    support: makeFontSupportSet(font),
  }));

  // getInfoDict() は pdf-lib の public API には無いため、構造型アサーションで呼び出す（pdfSaver.ts と同じ方針）
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  let existingBBoxMeta: Record<string, unknown> = {};

  if (infoDict) {
    try {
      const value = infoDict.get(PDFName.of('PecoToolBBoxes'));
      // decodeText() は数 MB のメタで stack overflow するため safeDecodePdfText を使う
      if (value instanceof PDFHexString || value instanceof PDFString) {
        existingBBoxMeta = JSON.parse(safeDecodePdfText(value));
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
    pruneStalePecoToolResources(page.node as unknown as { Resources?: () => PDFDict | undefined });
    replacePageTextContentStreams(
      page.node as unknown as {
        get?: (key: PDFName) => PDFObject | undefined;
        Contents?: () => PDFObject | undefined;
        set: (key: PDFName, value: PDFObject) => void;
      },
      pdfDoc.context,
    );

    if (!customFont) continue;
    const pageFontKeys = new Map<PDFFont, PDFName>();
    setPageFontWithStableKey(page, customFont, pageFontKeys);

    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = 1;
        const runs = splitTextBySupportedFont(block.text, customFont, primarySupport, fallbackFontSupports);
        const { width: textWidth, height: textHeight } = measureRuns(runs, fontSize);

        if (textWidth === 0 || textHeight === 0) continue;

        if (block.writingMode === 'vertical') {
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;

          if (!isFinite(sx) || !isFinite(sy)) continue;

          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;
          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          let offset = 0;
          for (const run of runs) {
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.drawText(run.text, { x: 0, y: offset, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            offset += run.font.widthOfTextAtSize(run.text, fontSize);
          }
          page.pushOperators(popGraphicsState());
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;

          if (!isFinite(sx) || !isFinite(sy)) continue;

          const baselineY = height - block.bbox.y - textHeight * sy * 0.8;
          page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
          let offset = 0;
          for (const run of runs) {
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.drawText(run.text, { x: offset, y: 0, size: fontSize, renderMode: 3 });
            offset += run.font.widthOfTextAtSize(run.text, fontSize);
          }
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

  // Acrobat 7.0 互換性のため useObjectStreams:false で旧形式 xref を維持する。
  // save() 全書き換え経路 (incremental の fontkit subset 破損を回避)。
  const saveOptions: Parameters<typeof pdfDoc.save>[0] = {
    useObjectStreams: false,
    addDefaultPage: false,
  };
  // pdf-lib save() が pdf-lib 内部で hang する edge case 対策として 90s timeout を設定。
  const savePromise = pdfDoc.save(saveOptions);
  const saveTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('[pdf.worker] pdfDoc.save() timed out after 90s')), 90_000);
  });
  const savedBytes = await Promise.race([savePromise, saveTimeout]);
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);
  return savedBytes;
}

// Worker scope での self 型付け。WebWorker lib を tsconfig で有効化しているため DedicatedWorkerGlobalScope が使える。
declare const self: DedicatedWorkerGlobalScope;

/**
 * payload から元 PDF bytes を取得する。
 * - bytes 指定: 従来経路（main thread から transfer された Uint8Array をそのまま使う）
 * - url 指定: Worker 内で直接 fetch → arrayBuffer する経路。
 *   main thread heap を経由しないので 100MB 級 PDF でも OOM しない。
 * 両方指定された場合は bytes を優先。
 */
async function resolvePdfBytes(data: {
  bytes?: Uint8Array;
  url?: string;
}): Promise<Uint8Array> {
  if (data.bytes) return data.bytes;
  if (data.url) {
    // main thread 側の savePDF にもハードタイムアウトがあるが、Worker 内で
    // fetch 自体が無応答になった場合でも明示的に abort できるよう、ここでも
    // AbortController を掛けておく（defense in depth）。
    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(data.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`[pdf.worker] fetch failed: ${res.status} ${res.statusText}`);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      clearTimeout(abortId);
    }
  }
  throw new Error('[pdf.worker] SAVE_PDF payload missing both bytes and url');
}

self.onmessage = async (e: MessageEvent<SavePdfWorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'SAVE_PDF': {
      try {
        const { documentState, fallbackFontBytes, fontBytes } = msg.data;
        const originalPdfBytes = await resolvePdfBytes(msg.data);
        const savedBytes = await handleSavePdf(originalPdfBytes, documentState, fontBytes, fallbackFontBytes);
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
