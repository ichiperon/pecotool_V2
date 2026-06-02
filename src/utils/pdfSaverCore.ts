/**
 * Shared helpers used by both pdfSaver.ts (main-thread path) and pdf.worker.ts (worker path).
 *
 * Rules:
 * - Pure functions only; no side-effects beyond the arguments passed in.
 * - No imports that are specific to either the main-thread or the Worker environment.
 * - Extracted verbatim from pdfSaver.ts / pdf.worker.ts to eliminate duplication (issue #211, #246).
 */

import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFDict,
  concatTransformationMatrix,
} from '@cantoo/pdf-lib';
import { deflate, inflate } from 'pako';
import {
  stripTextBlocks,
  stripEmptyGraphicsStateBlocksOnly,
  hasTextOperatorsOutsideTextObjects,
} from './pdfContentStream';
import {
  PECO_FONT_KEY_TAG,
  isPecoToolFontKey,
  isPecoToolGraphicsStateKey,
} from './pdfPecoToolMarkers';
import {
  sanitizeTextForPdfCopy,
  recordSkippedTextChar,
  type SkippedTextCollector,
} from './pdfSkippedTextChars';
import type { PDFRef, PDFFont, PDFObject } from '@cantoo/pdf-lib';
import type { CurveDefinition } from '../types';

// Re-export types that callers reference together with these helpers.
export type { PDFRef };
export type { SkippedTextCollector };

// ---------------------------------------------------------------------------
// decodeStreamContents
// ---------------------------------------------------------------------------

/**
 * Returns decompressed stream contents, or null if decoding failed / unsupported filter.
 * Callers must skip stream modification when null is returned.
 *
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
export function decodeStreamContents(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();

  // Resolve filter names — Filter can be a single PDFName or a PDFArray of names.
  let filterNames: string[];
  if (filter instanceof PDFName) {
    filterNames = [filter.asString()];
  } else if (filter instanceof PDFArray) {
    // Use .asArray() — PDFArray does NOT expose a .array property
    // asArray() が返すのは PDFObject[] だが Filter 配列の実体は PDFName のみ
    filterNames = filter.asArray().map((f) => (f as PDFName).asString());
  } else if (!filter) {
    // No filter — raw bytes are already plain content operators
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

// ---------------------------------------------------------------------------
// bytesEqual
// ---------------------------------------------------------------------------

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// concatWithNewlines
// ---------------------------------------------------------------------------

export function concatWithNewlines(chunks: Uint8Array[]): Uint8Array {
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

// ---------------------------------------------------------------------------
// isPdfRef
// ---------------------------------------------------------------------------

export function isPdfRef(value: unknown): value is PDFRef {
  return typeof value === 'object' && value !== null && value.constructor?.name === 'PDFRef';
}

// ---------------------------------------------------------------------------
// addRefCount
// ---------------------------------------------------------------------------

export function addRefCount(counts: Map<string, number>, value: unknown): void {
  if (!isPdfRef(value)) return;
  const key = value.toString();
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// collectPageContentRefCounts
// ---------------------------------------------------------------------------

export function collectPageContentRefCounts(pdfDoc: PDFDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const contentsKey = PDFName.of('Contents');
  const getPages = (pdfDoc as unknown as { getPages?: () => Array<{ node: { get?: (key: PDFName) => unknown; Contents?: () => unknown } }> }).getPages;
  if (typeof getPages !== 'function') return counts;

  for (const page of getPages.call(pdfDoc)) {
    const rawContents = page.node.get?.(contentsKey) ?? page.node.Contents?.();
    if (!rawContents) continue;

    addRefCount(counts, rawContents);
    const resolved = pdfDoc.context.lookup(rawContents as any);
    if (!(resolved instanceof PDFArray)) continue;

    for (const streamRef of resolved.asArray()) {
      addRefCount(counts, streamRef);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// deleteIfUniqueRef
// ---------------------------------------------------------------------------

export function deleteIfUniqueRef(
  context: typeof PDFDocument.prototype.context,
  value: unknown,
  contentRefCounts: Map<string, number>,
): void {
  if (!isPdfRef(value)) return;
  if (contentRefCounts.get(value.toString()) !== 1) return;
  context.delete(value);
}

// ---------------------------------------------------------------------------
// cleanContentStream
// ---------------------------------------------------------------------------

export function cleanContentStream(stream: PDFRawStream): boolean {
  const decoded = decodeStreamContents(stream);
  if (decoded === null) return false;

  const cleaned = stripTextBlocks(decoded);
  if (bytesEqual(cleaned, decoded)) return false;

  stream.updateContents(deflate(cleaned));
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.delete(PDFName.of('DecodeParms'));
  return true;
}

// ---------------------------------------------------------------------------
// isFormXObject
// ---------------------------------------------------------------------------

export function isFormXObject(stream: PDFRawStream): boolean {
  const subtype = stream.dict.lookup(PDFName.of('Subtype'));
  return subtype instanceof PDFName && subtype.asString() === '/Form';
}

// ---------------------------------------------------------------------------
// cleanFormXObjectsInResources
// ---------------------------------------------------------------------------

/**
 * Form XObject (Subtype=/Form) を再帰的に走査し、BT...ET ブロックを strip する。
 *
 * #82 visited Set の不変条件 (将来回帰防止のため明示):
 *   1. **冪等性**: `stripTextBlocks` は純粋な状態機械で副作用なし。同じ入力に
 *      対して同じ出力を返し、複数回呼んでも結果は変わらない。
 *   2. **早期 return**: `cleanContentStream` は strip 結果が原本とバイト等価なら
 *      `updateContents` を呼ばずに false を返す。すなわち「2 回目以降の strip は
 *      物理的に no-op」になる。
 *   3. **deep-first add**: 子 Resources を再帰する直前ではなく entries() ループの先頭で
 *      `visitedRefs.add(refKey)` する。つまり「visited に入っている ref は、本体・
 *      子 Resources 含めて既に処理済み」が保証される。
 *
 * 上記 (1)(2)(3) の合成により、`visitedRefs` を全ページで共有 (`sharedVisitedFormRefs`)
 * しても「あるページで処理した Form XObject を別ページで二重処理してしまう」可能性は
 * ない。共有することで:
 *   - 複数ページに跨る共有 Form XObject (Acrobat の typical 構造) を 1 回だけ deflate
 *     できファイル肥大化を防ぐ (issue #54)。
 *   - サイクリック参照があっても無限再帰しない (cycle detection)。
 */
export function cleanFormXObjectsInResources(
  resources: PDFDict | undefined,
  context: typeof PDFDocument.prototype.context,
  visitedRefs: Set<string> = new Set(),
): void {
  const xObjectDict = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjectDict) return;

  for (const [, value] of xObjectDict.entries()) {
    const refKey = isPdfRef(value) ? value.toString() : null;
    if (refKey !== null) {
      // 上の不変条件 (3) を満たすため、recurse する手前で先に mark する。
      // 既存マークありなら本体+子 Resources は前回処理で完結している。
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

// ---------------------------------------------------------------------------
// pruneStalePecoToolResources
// ---------------------------------------------------------------------------

export function pruneStalePecoToolResources(
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

// ---------------------------------------------------------------------------
// replacePageTextContentStreams
// ---------------------------------------------------------------------------

/**
 * Strips BT...ET text blocks from a page's content streams.
 *
 * @param logPrefix - Caller-specific prefix for console.warn messages (e.g. '[pdfSaver]').
 */
export function replacePageTextContentStreams(
  pageNode: {
    get?: (key: PDFName) => PDFObject | undefined;
    Contents?: () => PDFObject | undefined;
    set: (key: PDFName, value: PDFObject) => void;
  },
  context: typeof PDFDocument.prototype.context,
  contentRefCounts: Map<string, number>,
  logPrefix = '[pdfSaverCore]',
): void {
  const contentsKey = PDFName.of('Contents');
  const rawContents = pageNode.get?.(contentsKey) ?? pageNode.Contents?.();
  if (!rawContents) return;

  const resolved = context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  type ResolvedEntry = { ref: unknown; stream: PDFRawStream; decoded: Uint8Array };
  const resolvedEntries: ResolvedEntry[] = [];

  // #78: 旧実装は途中 1 つの stream が decode 失敗すると early return しており、
  // それより前に decodedStreams へ積まれた stream が merge/strip されないまま元のまま残り、
  // 後段で部分書換 (B のみ書き換え + A,C は原本) になって Double OCR が部分残存していた。
  // 修正後: decode 失敗/非 PDFRawStream は merge 経路を諦め、
  // 成功した stream のみ per-stream strip する。
  let anyDecodeFailed = false;
  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) {
      // issue #44: 暗号化 PDF や indirect chain で stream が PDFRawStream 以外になる
      // ケースがあり、その場合 text strip が silent でスキップされて Double OCR が
      // 残る。原因切り分けのため警告を出す。
      console.warn(`${logPrefix} Skipping text strip: page content stream is not a PDFRawStream`, {
        streamType: stream?.constructor?.name ?? typeof stream,
      });
      anyDecodeFailed = true;
      continue;
    }
    const decoded = decodeStreamContents(stream);
    if (decoded === null) {
      // この stream は decode 不能。in-place で個別 strip を試みる。
      // 失敗時は何もしない (フィルタチェーン未対応等は元のまま残る) ので、他 stream への
      // 影響は無い。merge 経路には進まないので anyDecodeFailed を立てる。
      cleanContentStream(stream);
      anyDecodeFailed = true;
      continue;
    }
    resolvedEntries.push({ ref: streamRef, stream, decoded });
  }

  // 1 つでも decode 失敗があれば merge 経路は取らない (array 構造を維持する必要がある)。
  // 代わりに decode 成功 stream を個別に strip して in-place 書き戻す。
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

// ---------------------------------------------------------------------------
// pageHasTextOperatorDamage
// ---------------------------------------------------------------------------

export function pageHasTextOperatorDamage(
  pageNode: { get?: (key: PDFName) => PDFObject | undefined; Contents?: () => PDFObject | undefined },
  context: typeof PDFDocument.prototype.context,
): boolean {
  const contentsKey = PDFName.of('Contents');
  const rawContents = pageNode.get?.(contentsKey) ?? pageNode.Contents?.();
  if (!rawContents) return false;

  const resolved = context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const decoded = decodeStreamContents(stream);
    if (decoded !== null && hasTextOperatorsOutsideTextObjects(decoded)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// sanitizeBBoxMetaTexts
// ---------------------------------------------------------------------------

export function sanitizeBBoxMetaTexts(
  bboxMeta: Record<string, unknown>,
  skippedChars: SkippedTextCollector,
): boolean {
  let changed = false;
  for (const [pageKey, entries] of Object.entries(bboxMeta)) {
    if (!Array.isArray(entries)) continue;
    const pageIndex = Number(pageKey);
    const normalizedPageIndex = Number.isInteger(pageIndex) ? pageIndex : undefined;
    let pageChanged = false;
    const cleanedEntries = entries.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const text = (entry as { text?: unknown }).text;
      if (typeof text !== 'string') return entry;
      const cleanedText = sanitizeTextForPdfCopy(text, skippedChars, normalizedPageIndex);
      if (cleanedText === text) return entry;
      pageChanged = true;
      return { ...(entry as Record<string, unknown>), text: cleanedText };
    });
    if (pageChanged) {
      bboxMeta[pageKey] = cleanedEntries;
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// stripEmptyQBlocksOnPage
// ---------------------------------------------------------------------------

/**
 * issue #96 要件2: 未編集ページの content stream から「空 q-Q ラッパー」だけを
 * 除去する軽量パス。BT...ET には触れない（原本の OCR テキストレイヤーを破壊しない）。
 * フォント辞書も触らない（subset 名の参照不整合を避ける）。
 */
export function stripEmptyQBlocksOnPage(
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

  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const decoded = decodeStreamContents(stream);
    if (decoded === null) continue;
    const cleaned = stripEmptyGraphicsStateBlocksOnly(decoded);
    if (bytesEqual(cleaned, decoded)) continue;
    stream.updateContents(deflate(cleaned));
    stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    stream.dict.delete(PDFName.of('DecodeParms'));
  }
}

// ---------------------------------------------------------------------------
// getRotationCm
// ---------------------------------------------------------------------------

/**
 * #71: 回転ページで OCR bbox (viewport-space, y-down) を正しく描画するため、
 * 「viewport-aligned drawing frame」を PDF user space にマップする cm (concat matrix) を返す。
 * R=0 なら空配列。pageW/pageH は page.getSize() の原 PDF 寸法。
 */
export function getRotationCm(
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
      return [concatTransformationMatrix(0, -1, 1, 0, 0, pageH)] as const;
    default:
      return [] as const;
  }
}

// ---------------------------------------------------------------------------
// normalizeRotation / getViewportSize
// ---------------------------------------------------------------------------

/** /Rotate を 0..360 に正規化 (負値も対応) */
export function normalizeRotation(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

/** 回転後の viewport 寸法。R=90/270 で width/height swap。 */
export function getViewportSize(rotation: number, pageW: number, pageH: number): { vw: number; vh: number } {
  if (rotation === 90 || rotation === 270) return { vw: pageH, vh: pageW };
  return { vw: pageW, vh: pageH };
}

// ---------------------------------------------------------------------------
// asPageIndex
// ---------------------------------------------------------------------------

export function asPageIndex(value: unknown): number | null {
  const pageIndex = typeof value === 'string' ? parseInt(value, 10) : value;
  return typeof pageIndex === 'number' && Number.isInteger(pageIndex) ? pageIndex : null;
}

// ---------------------------------------------------------------------------
// RepairTextBlock / RepairPageData (shared types)
// ---------------------------------------------------------------------------

export interface FontRun {
  text: string;
  font: PDFFont;
}

export interface RepairTextBlock {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  writingMode: 'horizontal' | 'vertical';
  order: number;
  /** issue #186: 湾曲ベースライン定義。未定義時は従来の axis-aligned 描画 */
  curve?: CurveDefinition;
}

export interface RepairPageData {
  textBlocks: RepairTextBlock[];
}

// ---------------------------------------------------------------------------
// isRepairTextBlock
// ---------------------------------------------------------------------------

/**
 * issue #96 Option B: existingBBoxMeta から読み出した 1 ページ分のエントリが
 * 「再描画に必要な最小情報」を備えているか検証する type guard。
 */
export function isRepairTextBlock(value: unknown): value is RepairTextBlock {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string') return false;
  if (typeof v.order !== 'number') return false;
  if (v.writingMode !== 'horizontal' && v.writingMode !== 'vertical') return false;
  const bbox = v.bbox as Record<string, unknown> | null | undefined;
  if (!bbox || typeof bbox !== 'object') return false;
  return (
    typeof bbox.x === 'number' &&
    typeof bbox.y === 'number' &&
    typeof bbox.width === 'number' &&
    typeof bbox.height === 'number'
  );
  // 注: curve フィールドの妥当性は callers (#187 PDF saver path) で個別に
  // isCurveDefinition() で検査する。ここで弾くと「curve が壊れているが
  // bbox/text は有効」なエントリ全体が drop されてしまう。
}

// ---------------------------------------------------------------------------
// makeFontSupportSet / splitTextBySupportedFont / measureRuns
// ---------------------------------------------------------------------------

export function makeFontSupportSet(font: PDFFont): Set<number> | null {
  if (typeof font.getCharacterSet !== 'function') return null;
  return new Set(font.getCharacterSet());
}

export function splitTextBySupportedFont(
  text: string,
  primaryFont: PDFFont,
  primarySupport: Set<number> | null,
  fallbackFonts: Array<{ font: PDFFont; support: Set<number> | null }>,
  skippedChars?: SkippedTextCollector,
  pageIndex?: number,
): FontRun[] {
  const runs: FontRun[] = [];
  // issue #179: Array.from(text) は文字列全体を即時 array 化し、長文 page 単位で
  // 短命オブジェクトを大量に生成して GC を誘発していた。string は ES2015 で
  // 既に code-point iterator を持つので、直接 for...of で回せばサロゲートペアも
  // 正しく扱える上、中間配列を生成しない。
  for (const char of text) {
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

export function measureRuns(runs: FontRun[], size: number): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const run of runs) {
    width += run.font.widthOfTextAtSize(run.text, size);
    height = Math.max(height, run.font.heightAtSize(size));
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// getFontDescentRatio
// ---------------------------------------------------------------------------

/**
 * フォントの descent 比 |descent| / (ascent + |descent|) を返す。
 *
 * #99 で baseline を pdf-lib の heightAtSize(size, {descender:false}) から動的計算
 * するようにしたが、その pdf-lib API は unitsPerEm≠1000 のフォントで未スケールの
 * descent を減算するバグを持つ。Meiryo / IPAmjMincho (ともに unitsPerEm=2048) では
 * descentRatio が約2倍に膨張し、OCR テキスト層の baseline が bbox 上端方向へ
 * ずれて見える (校正→保存→再読込で顕在化, #99 の回帰)。embedder 経由で fontkit の
 * 生メトリクス (ascent/descent) から直接算出して回避する。比なので unitsPerEm
 * には依存しない。
 */
export function getFontDescentRatio(font: PDFFont, fontSize: number): number {
  const fk = (font as unknown as {
    embedder?: { font?: { ascent?: number; descent?: number } };
  }).embedder?.font;
  if (fk && typeof fk.ascent === 'number' && typeof fk.descent === 'number') {
    const span = fk.ascent - fk.descent; // ascent + |descent| (descent は負値)
    if (span > 0) return Math.abs(fk.descent) / span;
  }
  // フォールバック: embedder 非公開時 (テストのモックフォント等)。
  const full = font.heightAtSize(fontSize);
  if (full > 0) {
    return (full - font.heightAtSize(fontSize, { descender: false })) / full;
  }
  return 0.2;
}

// ---------------------------------------------------------------------------
// findExistingFontKey / getOrRegisterPageFontKey / syncPageFontState / setPageFontWithStableKey
// ---------------------------------------------------------------------------

/**
 * #80: Resources.Font dict を scan して、すでに同じ font.ref が登録されていれば
 * その key を再利用する。タグ prefix が PECO_FONT_KEY_TAG と一致するもののみ再利用対象。
 */
export function findExistingFontKey(page: unknown, font: PDFFont): PDFName | undefined {
  const pageLike = page as {
    node?: { Resources?: () => PDFDict | undefined };
  };
  const resources = pageLike.node?.Resources?.();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fontDict) return undefined;

  const targetRefKey = font.ref.toString();
  const tagPrefix = `/${PECO_FONT_KEY_TAG}-`;
  for (const [key, value] of fontDict.entries()) {
    if (!isPdfRef(value)) continue;
    if (value.toString() !== targetRefKey) continue;
    if (!key.toString().startsWith(tagPrefix)) continue;
    return key;
  }
  return undefined;
}

/**
 * 修正 (#33, #80): cache → scan → newFontDictionary の 3 段で同じ font には常に同じ key を返す。
 */
export function getOrRegisterPageFontKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): PDFName | undefined {
  const cached = fontKeys.get(font);
  if (cached) return cached;

  // #80: 内部 API を叩く前に Font dict を 1 回 scan して既存 key を再利用する。
  const existing = findExistingFontKey(page, font);
  if (existing) {
    fontKeys.set(font, existing);
    return existing;
  }

  const pageLike = page as {
    fontKey?: PDFName;
    node?: { newFontDictionary?: (tag: string, fontRef: PDFRef) => PDFName };
    setFont?: (font: PDFFont) => void;
  };
  // PECO_FONT_KEY_TAG をそのまま渡す。pdf-lib 内部で `<tag>-<random>` 形式の
  // PDFName が生成され、次回保存時に isPecoToolFontKey() で確実に検出できる
  // （issue #96 Fix 1）。
  let key = pageLike.node?.newFontDictionary?.(PECO_FONT_KEY_TAG, font.ref);
  if (!key) {
    pageLike.setFont?.(font);
    key = pageLike.fontKey;
  }
  if (key) fontKeys.set(font, key);
  return key;
}

export function syncPageFontState(page: unknown, font: PDFFont, key: PDFName | undefined): void {
  const pageLike = page as { font?: PDFFont; fontKey?: PDFName };
  if (!key) return;
  pageLike.font = font;
  pageLike.fontKey = key;
}

export function setPageFontWithStableKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): void {
  const key = getOrRegisterPageFontKey(page, font, fontKeys);
  syncPageFontState(page, font, key);
}
