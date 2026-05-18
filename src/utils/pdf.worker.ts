import {
  PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, PDFRawStream,
  pushGraphicsState, popGraphicsState, translate, scale, degrees,
  concatTransformationMatrix, PDFArray,
  PDFDict
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { deflate, inflate } from 'pako';
import { stripTextBlocks } from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import { safeDecodePdfText } from './pdfLibSafeDecode';
import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';
import {
  createSkippedTextCollector,
  getSkippedTextChars,
  recordSkippedTextChar,
  sanitizeTextForPdfCopy,
  stripUnsafePdfCopyChars,
  type SkippedTextCollector,
} from './pdfSkippedTextChars';
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

function concatWithNewlines(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
    out[offset++] = 0x0a;
  }
  return out;
}

function isPecoToolFontKey(key: PDFName): boolean {
  const name = key.toString();
  return (
    name.startsWith('/IPAexGothic-') ||
    name.startsWith('/IPAmjMincho-') ||
    name.startsWith('/NotoSansCJKjp-') ||
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

function addRefCount(counts: Map<string, number>, value: unknown): void {
  if (!isPdfRef(value)) return;
  const key = value.toString();
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function collectPageContentRefCounts(pdfDoc: PDFDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const contentsKey = PDFName.of('Contents');

  for (const page of pdfDoc.getPages()) {
    const rawContents = page.node.get(contentsKey) ?? page.node.Contents?.();
    if (!rawContents) continue;

    addRefCount(counts, rawContents);
    const resolved = pdfDoc.context.lookup(rawContents);
    if (!(resolved instanceof PDFArray)) continue;

    for (const streamRef of resolved.asArray()) {
      addRefCount(counts, streamRef);
    }
  }

  return counts;
}

function deleteIfUniqueRef(
  context: typeof PDFDocument.prototype.context,
  value: unknown,
  contentRefCounts: Map<string, number>,
): void {
  if (!isPdfRef(value)) return;
  if (contentRefCounts.get(value.toString()) !== 1) return;
  context.delete(value);
}

function cleanContentStream(stream: PDFRawStream): boolean {
  const decoded = decodeStreamContents(stream);
  if (decoded === null) return false;

  const cleaned = stripTextBlocks(decoded);
  if (bytesEqual(cleaned, decoded)) return false;

  stream.updateContents(deflate(cleaned));
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.delete(PDFName.of('DecodeParms'));
  return true;
}

function isFormXObject(stream: PDFRawStream): boolean {
  const subtype = stream.dict.lookup(PDFName.of('Subtype'));
  return subtype instanceof PDFName && subtype.asString() === '/Form';
}

function cleanFormXObjectsInResources(
  resources: PDFDict | undefined,
  context: typeof PDFDocument.prototype.context,
  visitedRefs: Set<string> = new Set(),
): void {
  const xObjectDict = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjectDict) return;

  for (const [, value] of xObjectDict.entries()) {
    const refKey = isPdfRef(value) ? value.toString() : null;
    if (refKey !== null) {
      if (visitedRefs.has(refKey)) continue;
      visitedRefs.add(refKey);
    }

    const xObject = context.lookup(value);
    if (!(xObject instanceof PDFRawStream) || !isFormXObject(xObject)) continue;

    cleanContentStream(xObject);
    const childResources = xObject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    cleanFormXObjectsInResources(childResources, context, visitedRefs);
  }
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
  contentRefCounts: Map<string, number>,
): void {
  const contentsKey = PDFName.of('Contents');
  const rawContents = pageNode.get?.(contentsKey) ?? pageNode.Contents?.();
  if (!rawContents) return;

  const resolved = context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  type ResolvedEntry = { ref: unknown; stream: PDFRawStream; decoded: Uint8Array };
  const resolvedEntries: ResolvedEntry[] = [];

  // #78: 詳細コメントは pdfSaver.ts 側参照。
  // decode 失敗があれば merge せず、成功 stream のみ in-place で個別 strip する。
  let anyDecodeFailed = false;
  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) {
      // issue #44: see pdfSaver.ts comment.
      console.warn('[pdf.worker] Skipping text strip: page content stream is not a PDFRawStream', {
        streamType: stream?.constructor?.name ?? typeof stream,
      });
      return;
    }
    const decoded = decodeStreamContents(stream);
    if (decoded === null) {
      cleanContentStream(stream);
      anyDecodeFailed = true;
      continue;
    }
    resolvedEntries.push({ ref: streamRef, stream, decoded });
  }

  if (anyDecodeFailed) {
    for (const entry of resolvedEntries) {
      const cleaned = stripTextBlocks(entry.decoded);
      if (bytesEqual(cleaned, entry.decoded)) continue;
      entry.stream.updateContents(deflate(cleaned));
      entry.stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      entry.stream.dict.delete(PDFName.of('DecodeParms'));
    }
    return;
  }

  const merged = concatWithNewlines(resolvedEntries.map((e) => e.decoded));
  const cleaned = stripTextBlocks(merged);
  if (!bytesEqual(cleaned, merged)) {
    pageNode.set(contentsKey, context.register(context.flateStream(cleaned)));
    if (resolved instanceof PDFArray) deleteIfUniqueRef(context, rawContents, contentRefCounts);
    for (const streamRef of streams) {
      deleteIfUniqueRef(context, streamRef, contentRefCounts);
    }
  }
}

interface FontRun {
  text: string;
  font: PDFFont;
}

/**
 * #71: 詳細コメントは pdfSaver.ts 側参照。
 * 回転ページで viewport-space bbox を正しく描画するための cm (concat matrix) を返す。
 */
function getRotationCm(
  rotation: number,
  pageW: number,
  pageH: number,
) {
  switch (rotation) {
    case 0:
      return [] as const;
    case 90:
      return [concatTransformationMatrix(0, 1, -1, 0, pageW, 0)] as const;
    case 180:
      return [concatTransformationMatrix(-1, 0, 0, -1, pageW, pageH)] as const;
    case 270:
      return [concatTransformationMatrix(0, -1, 1, 0, pageH - pageW, pageW)] as const;
    default:
      return [] as const;
  }
}

function normalizeRotation(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

function getViewportSize(rotation: number, pageW: number, pageH: number): { vw: number; vh: number } {
  if (rotation === 90 || rotation === 270) return { vw: pageH, vh: pageW };
  return { vw: pageW, vh: pageH };
}

interface RepairTextBlock {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  writingMode: 'horizontal' | 'vertical';
  order: number;
}

interface RepairPageData {
  textBlocks: RepairTextBlock[];
}

function asPageIndex(value: unknown): number | null {
  const pageIndex = typeof value === 'string' ? parseInt(value, 10) : value;
  return typeof pageIndex === 'number' && Number.isInteger(pageIndex) ? pageIndex : null;
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
  skippedChars?: SkippedTextCollector,
  pageIndex?: number,
): FontRun[] {
  const runs: FontRun[] = [];
  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0);
    let font = primaryFont;
    if (codePoint !== undefined && primarySupport !== null && !primarySupport.has(codePoint)) {
      const fallbackFont = fallbackFonts.find((fallback) => fallback.support?.has(codePoint))?.font;
      if (!fallbackFont) {
        if (skippedChars) recordSkippedTextChar(skippedChars, 'unsupported-font', char, pageIndex);
        continue;
      }
      font = fallbackFont;
    }
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

/**
 * 修正 (#33): Resources の Font 辞書登録と pageLike state の同期を分離する。
 * 詳細コメントは pdfSaver.ts 側参照。
 */
function getOrRegisterPageFontKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): PDFName | undefined {
  const cached = fontKeys.get(font);
  if (cached) return cached;

  const pageLike = page as {
    fontKey?: PDFName;
    node?: { newFontDictionary?: (tag: string, fontRef: PDFRef) => PDFName };
    setFont?: (font: PDFFont) => void;
  };
  let key = pageLike.node?.newFontDictionary?.(font.name, font.ref);
  if (!key) {
    pageLike.setFont?.(font);
    key = pageLike.fontKey;
  }
  if (key) fontKeys.set(font, key);
  return key;
}

function syncPageFontState(page: unknown, font: PDFFont, key: PDFName | undefined): void {
  const pageLike = page as { font?: PDFFont; fontKey?: PDFName };
  if (!key) return;
  pageLike.font = font;
  pageLike.fontKey = key;
}

function setPageFontWithStableKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): void {
  const key = getOrRegisterPageFontKey(page, font, fontKeys);
  syncPageFontState(page, font, key);
}

async function handleSavePdf(
  originalPdfBytes: Uint8Array,
  documentState: { pages: Record<number, SerializedPageData> },
  fontBytes: ArrayBuffer | undefined,
  fallbackFontBytes: ArrayBuffer[] = [],
): Promise<{ savedBytes: Uint8Array; skippedChars: ReturnType<typeof getSkippedTextChars> }> {
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
  const contentRefCounts = collectPageContentRefCounts(pdfDoc);
  const skippedChars = createSkippedTextCollector();

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

  // 修正 (#25): existingBBoxMeta から pagesToWrite を pre-populate しない。
  // 以前は existingBBoxMeta の全ページを pagesToWrite に登録していたため、
  // 未編集ページに対しても pruneStalePecoToolResources / replacePageTextContentStreams
  // が走り、保存しただけで content stream が書き換わって原本のメタが破壊されていた。
  // dirty page が無い場合は metaChanged も false のままで infoDict.set は呼ばれず、
  // 既存メタはバイト等価で保持される (E2-3c 大容量メタ保存テストが要求する不変条件)。
  const pagesToWrite = new Map<number, RepairPageData>();
  for (const [pageIndexValue, pageData] of dirtyPages) {
    const pageIndex = asPageIndex(pageIndexValue);
    if (pageIndex === null || pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
    pagesToWrite.set(pageIndex, { textBlocks: pageData.textBlocks });
  }
  const pageEntriesToWrite = [...pagesToWrite.entries()].sort(([a], [b]) => a - b);

  // Only embed font if we actually have something to draw
  const needsFont = pageEntriesToWrite.some(([, pageData]) =>
    pageData.textBlocks.some((b) => stripUnsafePdfCopyChars(b.text).trim() !== '')
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

  // issue #54: Form XObject 共有時に同じ ref を複数回 strip しないよう全ページで visited を共有。
  const sharedVisitedFormRefs = new Set<string>();

  for (const [pageIndex, pageData] of pageEntriesToWrite) {

    const sortedBlocks: RepairTextBlock[] = [...pageData.textBlocks]
      .map((block) => ({ ...block, text: sanitizeTextForPdfCopy(block.text, skippedChars, pageIndex) }))
      .sort((a, b) => a.order - b.order);

    bboxMeta[String(pageIndex)] = sortedBlocks.map((b) => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text,
    }));
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { width: pageW, height: pageH } = page.getSize();
    // #71: 詳細コメントは pdfSaver.ts 側参照。viewport-space bbox を rotation 別 cm で描画する。
    const rotation = normalizeRotation(page.getRotation().angle);
    const { vh } = getViewportSize(rotation, pageW, pageH);
    const rotationCm = getRotationCm(rotation, pageW, pageH);

    // --- Surgical Text Stripping ---
    pruneStalePecoToolResources(page.node as unknown as { Resources?: () => PDFDict | undefined });
    cleanFormXObjectsInResources(page.node.Resources?.(), pdfDoc.context, sharedVisitedFormRefs);
    replacePageTextContentStreams(
      page.node as unknown as {
        get?: (key: PDFName) => PDFObject | undefined;
        Contents?: () => PDFObject | undefined;
        set: (key: PDFName, value: PDFObject) => void;
      },
      pdfDoc.context,
      contentRefCounts,
    );

    if (!customFont) continue;
    const pageFontKeys = new Map<PDFFont, PDFName>();
    setPageFontWithStableKey(page, customFont, pageFontKeys);

    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = Math.max(1, Math.min(96, (block.writingMode === 'vertical' ? block.bbox.width : block.bbox.height) * 0.8));
        const runs = splitTextBySupportedFont(
          block.text,
          customFont,
          primarySupport,
          fallbackFontSupports,
          skippedChars,
          pageIndex,
        );
        const { width: textWidth, height: textHeight } = measureRuns(runs, fontSize);

        if (textWidth === 0 || textHeight === 0) continue;

        if (block.writingMode === 'vertical') {
          // 修正 (#23, #28, #75): 詳細コメントは pdfSaver.ts 側参照。
          // #75: cm 内 scale を共通化 (sx_outer, sy_outer)。advance は runTextWidth * sy_outer で
          //      Σ = bbox.height となり完全に bbox を埋める。
          const sx_outer = block.bbox.width / textHeight;
          const sy_outer = block.bbox.height / textWidth;
          if (!isFinite(sx_outer) || !isFinite(sy_outer)) continue;
          let offsetInPage = 0;
          let renderedAny = false;
          for (const run of runs) {
            const runHeight = run.font.heightAtSize(fontSize);
            if (runHeight === 0) continue;
            const runTextWidth = run.font.widthOfTextAtSize(run.text, fontSize);
            if (runTextWidth === 0) continue;
            const runAscent = run.font.heightAtSize(fontSize, { descender: false });
            const descentRatio = (runHeight - runAscent) / runHeight;
            const baselineX_run = block.bbox.x + descentRatio * block.bbox.width;
            const baselineY_run = vh - block.bbox.y - offsetInPage;
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.pushOperators(
              pushGraphicsState(),
              ...rotationCm,
              translate(baselineX_run, baselineY_run),
              scale(sx_outer, sy_outer),
            );
            page.drawText(run.text, { x: 0, y: 0, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            page.pushOperators(popGraphicsState());
            offsetInPage += runTextWidth * sy_outer;
            renderedAny = true;
          }
          if (!renderedAny) continue;
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;

          if (!isFinite(sx) || !isFinite(sy)) continue;

          const baselineY = vh - block.bbox.y - textHeight * sy * 0.8;
          page.pushOperators(
            pushGraphicsState(),
            ...rotationCm,
            translate(block.bbox.x, baselineY),
            scale(sx, sy),
          );
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

  // 修正 (#30): Catalog の /Version を消す (詳細は pdfSaver.ts 側コメント参照)。
  if (originalVersion) stripCatalogVersion(pdfDoc);
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
  return { savedBytes, skippedChars: getSkippedTextChars(skippedChars) };
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
        const { savedBytes, skippedChars } = await handleSavePdf(originalPdfBytes, documentState, fontBytes, fallbackFontBytes);
        const response: SavePdfWorkerResponse = { type: 'SAVE_PDF_SUCCESS', data: savedBytes, skippedChars };
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
