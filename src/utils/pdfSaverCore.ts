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
  StandardFonts,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  translate,
  scale,
  PDFHexString,
  setWordSpacing,
  beginText,
  endText,
  setFontAndSize,
  showText,
  setTextMatrix,
  setTextRenderingMode,
  TextRenderingMode,
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { deflate, inflate } from 'pako';
import {
  stripTextBlocks,
  stripEmptyGraphicsStateBlocksOnly,
  hasTextOperatorsOutsideTextObjects,
  stripStrayTextOperatorsOutsideTextObjects,
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
  createSkippedTextCollector,
  getSkippedTextChars,
  stripUnsafePdfCopyChars,
} from './pdfSkippedTextChars';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import { ensureDenseClassicXref } from './pdfClassicXref';
import { compactIndirectObjectNumbers, sweepUnreachableObjects } from './pdfReachabilityGc';
import {
  hasLegacyPecoToolBBoxInfo,
  readPecoToolBBoxMetaFromPdfDoc,
  writePecoToolBBoxMetaToPdfDoc,
} from './pdfPecoToolMetadata';
import { extractTrailerId, overwriteTrailerId } from './pdfTrailerId';
import { isCurveDefinition } from './curveDefinition';
import { buildCurveBlockOperators } from './pdfCurveTextRender';
import { BLOCK_SEPARATOR_EXTRA_ADVANCE_EM } from './blockSeparatorConstants';
import type { PDFRef, PDFFont, PDFObject } from '@cantoo/pdf-lib';
import type { CurveDefinition } from '../types';
import type { SerializedPageData, SkippedPdfTextChar } from './pdfWorkerTypes';
import type { SaveDialogOptions } from '../hooks/useFileOperations';

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

  // PCT-177 (#408): 損傷判定は「全 decode 済み stream を連結した全体」に対して 1 回行う。
  // PDF 32000-1 §7.8.2 はトークン境界での content stream 分割を許すため、BT が stream A・
  // ET が stream B に分かれる合法な構成がありうる。per-stream 判定だと BT だけの stream A で
  // textDepth!==0 → 損傷と誤判定し、bloat 検知が不要にページを再描画対象へ入れてしまう。
  // stream は実行時に (whitespace 区切りで) 連結されるため、連結後の全体で判定するのが正しい。
  const decodedStreams: Uint8Array[] = [];
  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const decoded = decodeStreamContents(stream);
    // decode 不能 stream は判定に含められない。連結の連続性が切れるため、そこで
    // 区切って「連結済みの塊ごと」に判定する（decode 不能 stream を跨いだ BT...ET は
    // どのみち安全に解釈できないため、塊単位の判定が最も保守的）。
    if (decoded === null) {
      if (decodedStreams.length > 0 && hasTextOperatorsOutsideTextObjects(concatWithNewlines(decodedStreams))) {
        return true;
      }
      decodedStreams.length = 0;
      continue;
    }
    decodedStreams.push(decoded);
  }
  if (decodedStreams.length > 0 && hasTextOperatorsOutsideTextObjects(concatWithNewlines(decodedStreams))) {
    return true;
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
// sweepNonDirtyPage
// ---------------------------------------------------------------------------

/**
 * 未編集 (non-dirty) ページの content stream を **非破壊修復** する。
 *
 * 目的: Acrobat の "text operator outside text object" エラー（「このページにはエラーが
 * あります」/ Acrobat 7 の Tj エラー）の原因＝BT...ET の外に漏れたテキスト演算子（Tf/TL/T*
 * 等）と、過去保存で累積した空 q-Q ラッパーを除去する。一方で **BT...ET（OCR/手補正済みの
 * テキストレイヤー）はバイト等価で温存** する。
 *
 * 修復は stripStrayTextOperatorsOutsideTextObjects に委譲。損傷の有無に依存しない冪等処理:
 *  - 損傷あり (BT 外にテキスト演算子が漏れている): 漏れ演算子＋空 q-Q を除去、BT...ET は保持。
 *  - 損傷なし: 空 q-Q ラッパーのみ除去（従来 stripEmptyGraphicsStateBlocksOnly と同結果）。
 *
 * 旧実装 (PCT-059) は損傷ページで replacePageTextContentStreams を呼び BT...ET ごと strip して
 * いたが、未編集ページには再描画材料 (existingBBoxMeta) が無いため、メタを持たないファイル
 * （他ツール由来 OCR 層など）では原本テキストが復元されず消失していた。本実装はテキストを
 * 失わずにエラーだけ除去する。dirty ページの strip→再描画は呼び出し側メインループ
 * (pruneStalePecoToolResources + replacePageTextContentStreams + drawText) が従来どおり担う。
 *
 * decode は stream あたり 1 回（PCT-059 の decode 削減を維持）。decode 不能 stream は無変更。
 * （contentRefCounts / logPrefix は呼び出し側互換のため引数に残すが現実装では未使用。）
 */
export function sweepNonDirtyPage(
  pageNode: {
    get?: (key: PDFName) => PDFObject | undefined;
    Contents?: () => PDFObject | undefined;
    set: (key: PDFName, value: PDFObject) => void;
  },
  context: typeof PDFDocument.prototype.context,
  _contentRefCounts: Map<string, number>,
  _logPrefix = '[pdfSaverCore]',
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
    // 非破壊修復: BT...ET（テキスト層）を温存し、BT 外の漏れテキスト演算子＋空 q-Q のみ除去。
    const cleaned = stripStrayTextOperatorsOutsideTextObjects(decoded);
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
  /** PCT-047: OCR 信頼度 (0..1)。永続化のために追加。後方互換のため optional。 */
  confidence?: number;
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
// PCT-092: descent 比の上限。
// 本ツールは「フォント論理ボックス (ascent〜descent) を OCR bbox にフィット」させて
// baseline を bbox 下端から descent 比の高さに置くが、Meiryo の hhea メトリクスは
// 行間設計込みで descent 比 ≈ 0.293 と深く、スキャン原稿の和文活字の実ベースライン
// (行下端から約 10〜12%。IPAmjMincho の実測も 0.1201) より大きい。比が大きいほど
// テキスト論理位置が画像の文字より上 (縦書きでは左) に座り、Acrobat の選択
// ハイライトが「左上に寄って」見える (v2.0.15 実機報告・実測で確認)。
// 明朝系実測に合わせ 0.12 で打ち切る。0.12 以下のフォントは実値のまま。
const DESCENT_RATIO_CAP = 0.12;

export function getFontDescentRatio(font: PDFFont, fontSize: number): number {
  const fk = (font as unknown as {
    embedder?: { font?: { ascent?: number; descent?: number } };
  }).embedder?.font;
  if (fk && typeof fk.ascent === 'number' && typeof fk.descent === 'number') {
    const span = fk.ascent - fk.descent; // ascent + |descent| (descent は負値)
    if (span > 0) return Math.min(Math.abs(fk.descent) / span, DESCENT_RATIO_CAP);
  }
  // フォールバック: embedder 非公開時 (テストのモックフォント等)。
  const full = font.heightAtSize(fontSize);
  if (full > 0) {
    // PCT-092: フォールバック経路にも同じキャップを適用する。
    return Math.min((full - font.heightAtSize(fontSize, { descender: false })) / full, DESCENT_RATIO_CAP);
  }
  return DESCENT_RATIO_CAP;
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

// ---------------------------------------------------------------------------
// CoreSaveDocument / BuildPdfCoreOptions
// ---------------------------------------------------------------------------

/**
 * buildPdfDocumentCore に渡すドキュメント状態。
 * D1: pages 型は Map<number, SerializedPageData> に正規化済み（thumbnail 除去後）。
 */
export interface CoreSaveDocument {
  totalPages: number;
  pages: Map<number, SerializedPageData>;
}

/**
 * buildPdfDocumentCore のオプション。
 * D4: saveTimeoutMs?: number — 未指定なら pdfDoc.save() に race をかけない。worker 殻が 90_000 を渡す。
 */
export interface BuildPdfCoreOptions {
  options?: SaveDialogOptions;
  pageOrder?: number[];
  saveTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// remapBBoxMetaForPageOrder (core 用ローカル版)
// ---------------------------------------------------------------------------

function remapBBoxMetaForPageOrderCore(
  bboxMeta: Record<string, unknown>,
  pageOrder: number[] | undefined,
  isDefaultOrder: boolean,
): Record<string, unknown> {
  if (isDefaultOrder || !pageOrder || Object.keys(bboxMeta).length === 0) return bboxMeta;
  const remapped: Record<string, unknown> = {};
  for (let displayIndex = 0; displayIndex < pageOrder.length; displayIndex += 1) {
    const originalIndex = pageOrder[displayIndex];
    const originalEntry = bboxMeta[String(originalIndex)];
    if (originalEntry !== undefined) {
      remapped[String(displayIndex)] = originalEntry;
    }
  }
  return remapped;
}

// ---------------------------------------------------------------------------
// buildBlockSeparatorOperators
// ---------------------------------------------------------------------------

/**
 * 各 BB（テキストブロック）の末尾に挿入する「境界区切りスペース」を BT...ET operator 列として返す。
 *
 * ## 目的
 * Acrobat のテキスト抽出ヒューリスティクスは座標と文字幅を使って隣接 BT ブロックを連結する
 * (issue #100)。各 BB の末尾に invisible U+0020 を 1 文字発行して「語/行境界」とみなさせる
 * ことで連結を回避する。
 *
 * ## 案A: 境界スペースの送り幅拡大
 * 近接した別 BB に対して Acrobat が「字間」とみなすケースを緩和するため、末尾スペースの
 * 直前に Tw (setWordSpacing) で送り幅を拡大し、直後に必ず 0 にリセットする。
 *
 * - renderMode は必ず 3 (invisible) ＝ 画面・印刷に出力しない。
 * - Tw は BT...ET の内側で発行し、ET 直前に 0 リセットする。
 *   BT の外側では pushGraphicsState による text-state の隔離で意図しないリセットが
 *   起こりうるため、このヘルパーは BT...ET を丸ごと組み立てて返す。
 * - 本文グリフ列 (run.text) は一切変更しない。
 * - Tw/Tc をこのフレーム外に漏らさないため、ET 前に必ず 0 リセット。
 *
 * ## チューニング定数
 * `BLOCK_SEPARATOR_EXTRA_ADVANCE_EM` (`src/utils/blockSeparatorConstants.ts`) はフォントサイズに
 * 対する追加送り幅の倍率。初期値 0.8em は「隣接 BB を Acrobat が語境界と判断する閾値」の保守的な
 * 下限として選択。Acrobat 実機テストでチューニング推奨。
 * - 大きすぎると同一行の語が余分な空白で分断される (#4 一字一句保存)
 * - 小さすぎると連結抑止が不十分になる
 *
 * @param font     末尾スペースを描画するフォント（最後の run フォント）
 * @param fontKey  Resources.Font dict 内のキー（setPageFontWithStableKey で登録済み）
 * @param fontSize フォントサイズ (pt)
 * @param x        BT 内の描画 x 座標（スペースを置く位置）
 * @param y        BT 内の描画 y 座標
 * @returns BT...ET operator 列
 */

export function buildBlockSeparatorOperators(
  font: PDFFont,
  fontKey: PDFName,
  fontSize: number,
  x: number,
  y: number,
): import('@cantoo/pdf-lib').PDFOperator[] {
  // Tw: word spacing (pt)。U+0020 を showText すると Tw が advance に加算される。
  // BT 直前の setWordSpacing は pushGraphicsState でリセットされる可能性があるため、
  // このヘルパーは BT...ET を自己完結した単位として組み立てる。
  const extraAdvancePt = fontSize * BLOCK_SEPARATOR_EXTRA_ADVANCE_EM;
  return [
    beginText(),
    setFontAndSize(fontKey, fontSize),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setWordSpacing(extraAdvancePt),
    setTextMatrix(1, 0, 0, 1, x, y),
    showText(font.encodeText(' ')),
    // Tw を必ず 0 にリセット。ET で text state は破棄されるが、
    // 仕様上 ET 後もページレベルの Tw は残るため明示リセットする。
    setWordSpacing(0),
    endText(),
  ];
}

// ---------------------------------------------------------------------------
// buildBlockSeparatorOperators (vertical / -90° variant)
// ---------------------------------------------------------------------------

/**
 * 縦書きブロックの末尾境界スペース用 operator 列。
 *
 * 縦書きは各 run が独立した GS フレーム (pushGraphicsState / popGraphicsState) を持つ。
 * 末尾スペース用の GS フレームも独立して push/pop するため、translate + scale は
 * 呼び出し側で pushGraphicsState / popGraphicsState / translate / scale を発行し、
 * このヘルパーは BT...ET の中身のみを返す。
 *
 * Tw で追加送り幅を与えても縦書きの行方向は PDF Tm 内で回転 (-90°) で表現されており、
 * Tw は横方向の word spacing なので縦書きの行送りに作用しない（PDF 仕様 §9.3.3）。
 * 縦書き末尾スペースの連結抑止は主として BT...ET 境界の存在に依存し、追加送り幅の
 * 効果は横書きより限定的。それでも一貫性のため同じ Tw を発行する。
 *
 * @param font     末尾スペースフォント
 * @param fontKey  Resources.Font dict キー
 * @param fontSize フォントサイズ
 * @returns BT...ET operator 列（GS ラッパーは呼び出し側で発行）
 */
export function buildBlockSeparatorOperatorsVertical(
  font: PDFFont,
  fontKey: PDFName,
  fontSize: number,
): import('@cantoo/pdf-lib').PDFOperator[] {
  const extraAdvancePt = fontSize * BLOCK_SEPARATOR_EXTRA_ADVANCE_EM;
  // 縦書きは drawText(..., {rotate: degrees(-90)}) が発行していた Tm を再現する。
  // degrees(-90) → rotationMatrix: cos(-90°)=0, sin(-90°)=-1 → Tm: 0 -1 1 0 0 0 (x=0,y=0)
  return [
    beginText(),
    setFontAndSize(fontKey, fontSize),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setWordSpacing(extraAdvancePt),
    setTextMatrix(0, -1, 1, 0, 0, 0),
    showText(font.encodeText(' ')),
    setWordSpacing(0),
    endText(),
  ];
}

// ---------------------------------------------------------------------------
// buildPdfDocumentCore
// ---------------------------------------------------------------------------

/**
 * PCT-100: 保存オーケストレーションの単一実装。
 *
 * pdfSaver.ts (main-thread) と pdf.worker.ts (worker) の両方がこの関数を呼ぶ。
 * 各殻はアダプタとして:
 *   - D1: pages を Map<number, SerializedPageData> に正規化 (thumbnail 除去)
 *   - D2: originalPdfBytes を解決済み Uint8Array として渡す (fetch は殻の責務)
 *   - D3: 戻り値の skippedChars を受け取り onSkippedChars コールバックに変換 (main 殻のみ)
 *   - D4: saveTimeoutMs を渡す (worker 殻は 90_000、main 殻は未指定)
 *   - D5: ログ tag は '[buildPdfDocumentCore]' に統一
 *
 * D-after: worker の clean short-circuit は earlySweep なしで即 return していたが、
 * この core では main 版 (earlySweep あり・A-06 準拠) を採用する。
 * worker 経路が invariants A-06 に合致する正しい修正。
 */
export async function buildPdfDocumentCore(
  originalPdfBytes: Uint8Array,
  documentState: CoreSaveDocument,
  fontBytes: ArrayBuffer | undefined,
  fallbackFontBytes: ArrayBuffer[] = [],
  coreOptions: BuildPdfCoreOptions = {},
): Promise<{ savedBytes: Uint8Array; skippedChars: SkippedPdfTextChar[] }> {
  const { options, pageOrder, saveTimeoutMs } = coreOptions;

  // OCR テキスト層 (renderMode 3・Ctrl+A 選択範囲) の表示オフセット (point)。
  // viewport 表示座標系で平行移動する: dx>0 で右、dy>0 で下。
  // 全描画経路 (横書き / 縦書き / curve) で translate / cm に同量を加える。
  // 未指定なら無シフト ({0,0})。直接 core を叩く既存テストの座標は不変に保たれる。
  const textOffsetDx = options?.textLayerOffsetPt?.dx ?? 0;
  const textOffsetDy = options?.textLayerOffsetPt?.dy ?? 0;

  // 緊急対応 (escape hatch): true のとき、下記 Acrobat dirty-flag 回避 short-circuit を
  // 無効化して、編集が無く PecoTool メタも無いファイルでも通常パス（sweepNonDirtyPage に
  // よる空 q-Q 除去・BT 外テキスト演算子 strip、stripCatalogVersion 等）を必ず通す。
  // 過去保存ゴミ起因の Acrobat エラー / Acrobat 7 Tj エラーを、開いて保存し直すだけで
  // 修復するための逃げ道。OFF（既定）では従来どおり無傷ファイルはバイト温存する。
  const forceFullRewrite = options?.forceFullRewrite ?? false;

  const originalVersion = extractPdfVersion(originalPdfBytes);
  // Acrobat dirty-flag 回避: 入力 PDF の trailer /ID を保存後に書き戻す。
  const originalTrailerId = extractTrailerId(originalPdfBytes);
  // forIncrementalUpdate + commit() を試したが、subset embedFont と組み合わせると
  // fontkit 生成 subset の glyf table が OTS 検証をパスしない状態 (Acrobat でも
  // 「フォントを抽出できません」) になる。ベンチ実測では pdfDoc.save() 全書き換えと
  // commit() incremental は 91ms vs 126ms でほぼ同速なので、安全側の全書き換えに戻す。
  // throwOnInvalidObject:false → 不正オブジェクトの回復試行をスキップして高速化
  // updateMetadata:false → 更新日時の自動書き換えを抑制
  const pdfDoc = await PDFDocument.load(originalPdfBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  pdfDoc.registerFontkit(fontkit);
  const originalPdfPageCount = typeof (pdfDoc as unknown as { getPageCount?: () => number }).getPageCount === 'function'
    ? pdfDoc.getPageCount()
    : documentState.totalPages;

  // issue #193 / #209: pageOrder に基づきページを削除/並べ替えする。
  // pageOrder は caller (useFileOperations) が store から取得して渡す canonical な値。
  // 未設定または [0,1,...,n-1] の場合はスキップ。
  const isDefaultOrder =
    !pageOrder ||
    (pageOrder.length === originalPdfPageCount &&
      pageOrder.every((v, i) => v === i));
  if (!isDefaultOrder && pageOrder) {
    // pageOrder は「新しい表示順に対応する元 pdfDoc ページインデックス」の配列。
    // 例: pageOrder=[2,0,1] → 新ページ0=旧ページ2, 新ページ1=旧ページ0, 新ページ2=旧ページ1
    // pdf-lib では直接 movePage API がないため、copyPages + removePage で並べ替える。
    const srcDoc = pdfDoc;
    // 新しい順序でページをコピー
    const copiedPages = await srcDoc.copyPages(srcDoc, pageOrder);
    // 既存の全ページを後ろから削除 (インデックスずれを防ぐため末尾から)
    for (let i = originalPdfPageCount - 1; i >= 0; i--) {
      srcDoc.removePage(i);
    }
    // コピーしたページを新しい順序で挿入
    for (const page of copiedPages) {
      srcDoc.addPage(page);
    }
    // bboxMeta も新しいページ順序に合わせてキーを更新 (後で読み込まれる existingBBoxMeta を上書き)
    // この時点では existingBBoxMeta はまだ元のインデックスを持つ。
    // 後処理で更新するため、ここではページの物理順を変えるだけ。
  }

  const pdfPageCount = typeof (pdfDoc as unknown as { getPageCount?: () => number }).getPageCount === 'function'
    ? pdfDoc.getPageCount()
    : documentState.totalPages;

  // D1: pages は Map<number, SerializedPageData> として受け取る。
  const dirtyPages = Array.from(documentState.pages.entries()).filter(([, pageData]) => pageData.isDirty);
  const contentRefCounts = collectPageContentRefCounts(pdfDoc);
  const skippedChars = createSkippedTextCollector();

  const hadLegacyBBoxMeta = hasLegacyPecoToolBBoxInfo(pdfDoc);
  const rawExistingBBoxMeta = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
  const existingBBoxMeta = remapBBoxMetaForPageOrderCore(rawExistingBBoxMeta, pageOrder, isDefaultOrder);
  const hadExistingBBoxMeta = Object.keys(rawExistingBBoxMeta).length > 0;

  // Acrobat dirty-flag 回避 short-circuit:
  // 編集なし & PecoTool メタ (旧 Info 形式 / 新 stream 形式) が皆無のとき、
  // pdf-lib roundtrip を完全にスキップして入力 bytes をそのまま返す。
  // pdf-lib の save() は (たとえ no-op でも) trailer /ID 再生成・xref 再配置で
  // 微妙な byte 差分を生み、Acrobat が dirty 判定する原因になる。
  //
  // ただし issue #96 要件2 (#130): 過去保存の累積で /Root から到達不能な
  // 孤児オブジェクトが大量に残った PDF を再保存しただけで縮める要件があるため、
  // 短絡前に reachability sweep を実行し、孤児が見つかった場合は通常パスに
  // 進んで全書き換え (= 孤児消去) する。孤児ゼロなら短絡してバイト同一性を維持。
  //
  // D-after: worker の旧 short-circuit は earlySweep を呼ばず即 return していたが、
  // この core では main 版 (earlySweep あり・invariants A-06 準拠) を採用する。
  if (
    !forceFullRewrite &&
    isDefaultOrder &&
    dirtyPages.length === 0 &&
    !hadLegacyBBoxMeta &&
    !hadExistingBBoxMeta
  ) {
    const earlySweep = sweepUnreachableObjects(pdfDoc);
    if (earlySweep.dropped === 0) {
      return { savedBytes: originalPdfBytes, skippedChars: getSkippedTextChars(skippedChars) };
    }
  }

  const bboxMeta = { ...existingBBoxMeta };
  let metaChanged = existingBBoxMeta !== rawExistingBBoxMeta;
  if (sanitizeBBoxMetaTexts(bboxMeta, skippedChars)) {
    metaChanged = true;
  }

  // 修正 (#25): existingBBoxMeta から pagesToWrite を pre-populate しない。
  // 以前は existingBBoxMeta の全ページを pagesToWrite に登録していたため、
  // 未編集ページに対しても pruneStalePecoToolResources / replacePageTextContentStreams
  // が走り、保存しただけで content stream が書き換わって原本のメタが破壊されていた。
  // dirty page が無い場合は metaChanged も false のままで infoDict.set は呼ばれず、
  // 既存メタはバイト等価で保持される (E2-3c 大容量メタ保存テストが要求する不変条件)。
  const pagesToWrite = new Map<number, RepairPageData>();
  for (const [pageIndexValue, pageData] of dirtyPages) {
    const pageIndex = asPageIndex(pageIndexValue);
    if (pageIndex === null || pageIndex < 0 || pageIndex >= pdfPageCount) continue;
    pagesToWrite.set(pageIndex, { textBlocks: pageData.textBlocks });
  }

  // issue #96 要件2 (Option B): 「未編集だが明らかに bloated」なページを自動検知して
  // フルクリーンアップ対象に追加する。
  //
  // 背景:
  //   PR #25 で「未編集ページの content stream を保存しただけで書き換わって原本メタが
  //   破壊される」のを防ぐため、dirty page のみが pruneStalePecoToolResources /
  //   replacePageTextContentStreams のフルパスを通るよう制限した。
  //   しかし過去保存で累積した Meiryo subset 群 (1 ページに 50+ 個) のような bloat は
  //   live xref 内に残り続け、再読み込み → 保存だけでは縮まない。Option Beta (空 q-Q
  //   除去) だけでは 115MB → 30MB 止まりで acceptance #1 (<20MB) を満たさない。
  //
  // 検知条件 (全て満たすこと):
  //   (a) まだ dirty 扱いになっていない (pagesToWrite に未登録)
  //   (b) existingBBoxMeta にこのページのエントリ (TextBlock 配列) がある
  //       — 無いと再描画すべきテキストが分からないので cleanup 不能
  //   (c) Font 辞書に PecoTool 由来のフォントエントリが BLOAT_THRESHOLD 個以上ある
  //       — 通常 1-3 個。58 個も入っているのは過去保存で累積した bloat の証跡
  //   (d) fontBytes が呼び出し側から渡されている (Japanese 対応フォント有)
  //       — 無いと Helvetica にフォールバックして Japanese テキストが skip され OCR レイヤー
  //         を破壊する。fontBytes 無しのケースは bloat も発生しえない (描画してない) ので
  //         検知 fire しなくて問題ない。
  //
  // 副作用 (既存 dirty page と同等):
  //   pruneStalePecoToolResources で Meiryo subset 群が除去され、
  //   replacePageTextContentStreams で旧 BT...ET が削除され、
  //   既存ループで existingBBoxMeta から取り出した TextBlock を新 PecoF subset で再描画する。
  //   結果: 58 個の Meiryo subset → 1 個の PecoF subset に集約され、大幅縮小。
  //
  // PR #25 の不変条件への影響:
  //   - 通常の pristine PDF (PecoTool 由来フォント無し or existingBBoxMeta 無し) では検知が
  //     fire しないため、bit-equiv 保存が維持される
  //   - bloated PDF では既に「原本メタ」が壊れた状態なので、再描画して clean meta を出すことが
  //     issue #96 の意図そのもの (原本メタ保護より優先される)
  //   - E2-3c 大容量メタ保存テスト: dirty 0 件 + bloat 検知 fire 無し (existingBBoxMeta から
  //     populate されないので bloated 判定の (c) が満たされない pristine 状態) の場合は
  //     既存挙動を維持する。bloated PDF を 2 回保存しても 2 回目は subset 数が <= threshold に
  //     縮んでいるため (c) を満たさず safe。
  const BLOAT_DETECTION_FONT_THRESHOLD = 3;
  if (fontBytes) {
    for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
      if (pagesToWrite.has(pi)) continue; // (a)
      const entries = existingBBoxMeta[String(pi)];
      if (!Array.isArray(entries) || entries.length === 0) continue; // (b)

      const page = pdfDoc.getPage(pi);
      // issue #171: フォント数カウントは O(N) で軽量、pageHasTextOperatorDamage は
      // 全 content stream の pako.inflate を伴う。1000+ ページ no-op save では
      // この inflate が数百ms〜数秒掛かるため、軽い font 検査で先に絞り込む。
      const resources = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
      const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);

      let pecoCount = 0;
      if (fontDict) {
        for (const [key] of fontDict.entries()) {
          if (isPecoToolFontKey(key)) {
            pecoCount++;
            if (pecoCount > BLOAT_DETECTION_FONT_THRESHOLD) break;
          }
        }
      }
      const hasLegacyBloat = pecoCount > BLOAT_DETECTION_FONT_THRESHOLD;
      if (!hasLegacyBloat) continue; // (c) フォント累積が主たる bloat 指標
      const hasTextOperatorDamage = pageHasTextOperatorDamage(
        page.node as unknown as { get?: (key: PDFName) => PDFObject | undefined; Contents?: () => PDFObject | undefined },
        pdfDoc.context,
      );
      if (!hasTextOperatorDamage) continue;

      // Bloated と判定。dirty 相当として pagesToWrite に追加
      // (テキストは existingBBoxMeta から復元)。
      const repairBlocks = entries
        .filter(isRepairTextBlock)
        .map((block) => {
          const out: RepairTextBlock = {
            text: block.text,
            bbox: block.bbox,
            writingMode: block.writingMode,
            order: block.order,
          };
          // issue #186: curve は再描画でも維持
          if (isCurveDefinition((block as { curve?: unknown }).curve)) {
            out.curve = (block as { curve: CurveDefinition }).curve;
          }
          // PCT-112: confidence も repair 経路で引き継ぐ。引き継がないと bloat 検知が
          // fire した保存→再オープンの 1 サイクルで低信頼ハイライトが一時消失する。
          // 値域 0..1 の有限数値のみ採用（永続化側 1146 と同じ条件）。
          const conf = (block as { confidence?: unknown }).confidence;
          if (typeof conf === 'number' && Number.isFinite(conf) && conf >= 0 && conf <= 1) {
            out.confidence = conf;
          }
          return out;
        });
      if (repairBlocks.length === 0) continue;
      pagesToWrite.set(pi, { textBlocks: repairBlocks });
    }
  }

  const pageEntriesToWrite = [...pagesToWrite.entries()].sort(([a], [b]) => a - b);

  // Only embed font if we actually have something to draw
  const needsFont = pageEntriesToWrite.some(([, pageData]) =>
    pageData.textBlocks.some(b => stripUnsafePdfCopyChars(b.text).trim() !== '')
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

  // issue #54: Form XObject は複数ページで共有されている (Acrobat の typical な造り) ことが多く、
  // ページごとに new Set() を作ると同じバイト列を複数回 deflate してファイル肥大化する。
  // 全ページで visited ref を共有する。
  const sharedVisitedFormRefs = new Set<string>();

  for (const [pageIndex, pageData] of pageEntriesToWrite) {

    const sortedBlocks = [...pageData.textBlocks]
      .map((block) => ({ ...block, text: sanitizeTextForPdfCopy(block.text, skippedChars, pageIndex) }))
      .sort((a, b) => a.order - b.order);
    const hasDrawableBlocks = sortedBlocks.some((block) => stripUnsafePdfCopyChars(block.text).trim() !== '');
    bboxMeta[String(pageIndex)] = sortedBlocks.map(b => {
      const entry: Record<string, unknown> = {
        bbox: b.bbox,
        writingMode: b.writingMode,
        order: b.order,
        text: b.text,
      };
      // issue #186: 湾曲ベースラインが定義されていれば JSON に同梱
      if (b.curve) entry.curve = b.curve;
      // #192 / PCT-047: confidence を永続化する。再オープン後も低信頼ハイライトが機能するよう、
      // undefined でない場合のみキーを書き込む（後方互換: 欠如時は undefined 扱いのまま）。
      if (b.confidence !== undefined) entry.confidence = b.confidence;
      return entry;
    });
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { width: pageW, height: pageH } = page.getSize();

    // issue #207: ユーザー指定の rotation があれば PDF ページの /Rotate を上書きする。
    // documentState.pages には dirty ページが含まれるが、pageOrder 並べ替え後の新インデックスで
    // 引けるように dirtyPages の元エントリ (pageData) を参照する。
    const userRotation = documentState.pages.get(pageIndex)?.rotation;
    if (userRotation !== undefined) {
      page.setRotation(degrees(userRotation));
    }

    // #71: bbox は OCR / 既存テキスト経由いずれも viewport 空間 (rotated screen, y-down)。
    // pdfSaver は元々 R=0 を仮定して translate(bbox.x, pageH - bbox.y) していたため、
    // R=90/180/270 では位置がページ外へ飛んでいた (#50 regression)。
    // 修正方針: viewport 寸法 (vw/vh) を使い、rotation に応じた cm を per-block push する。
    // rotation は setRotation 後の値を取得する (user rotation 適用済み)。
    const rotation = normalizeRotation(page.getRotation?.().angle ?? 0);
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
      '[buildPdfDocumentCore]',
    );

    if (!customFont || !hasDrawableBlocks) continue;
    const pageFontKeys = new Map<PDFFont, PDFName>();
    setPageFontWithStableKey(page, customFont, pageFontKeys);

    // Now draw the NEW text blocks onto the cleaned page
    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = Math.max(1, Math.min(96, (block.writingMode === 'vertical' ? block.bbox.width : block.bbox.height) * 0.8));

        // issue #187: curve 定義があるブロックは per-glyph Tm/Tj 経路で描画する。
        // axis-aligned 経路 (pushGraphicsState + translate/scale + drawText) と完全に
        // 分岐するため、curve branch 内で描画完了したら continue で次ブロックへ。
        // フォントは primary customFont のみ使用 (fallback 切り替えは Phase 3.5 へ繰越)。
        // primary でサポートされない char は recordSkippedTextChar で記録して drop。
        if (block.curve) {
          const ops = buildCurveBlockOperators(
            block.text,
            block.curve,
            customFont,
            // primary font は pageFontKeys に setPageFontWithStableKey 済み (loop 上方)。
            // 必ず key が解決済みのため non-null assertion (key が無いと axis-aligned 経路でも
            // drawText が誤キー出力するため、両経路で同じ前提)。
            pageFontKeys.get(customFont)!,
            fontSize,
            vh,
            rotationCm as unknown as Parameters<typeof buildCurveBlockOperators>[6],
            { dx: textOffsetDx, dy: textOffsetDy },
          );
          if (ops.length > 0) {
            page.pushOperators(...ops);
          }
          continue;
        }

        const runs = splitTextBySupportedFont(
          block.text,
          customFont,
          primarySupport,
          fallbackFontSupports,
          skippedChars,
          pageIndex,
        );
        const { width: textWidth, height: textHeight } = measureRuns(runs, fontSize);

        if (textWidth === 0 || textHeight === 0) {
          console.warn(`[buildPdfDocumentCore] Page ${pageIndex}: skipped block (zero font metrics) text="${block.text.slice(0, 20)}"`);
          continue;
        }

        if (block.writingMode === 'vertical') {
          // 修正 (#23, #28, #75): 縦書きは run ごとに pushGraphicsState を切り替え、
          // フォント別の ascent から baselineX を算出する (Meiryo 0.2 マジックナンバーを廃止)。
          //  - sx_outer / sy_outer: ブロック全体で共通のスケール。Σ run advance = bbox.height。
          //  - baselineX_run: 各 run の ascent/descent 比から導出
          //  - offsetInPage: ページ座標で累積する縦方向 advance
          //
          // #75 修正: 旧実装は per-run sx_run (heightAtSize 別) + 共通 sy_outer の組み合わせで
          // cm を発行していたため、混在フォントで heightAtSize の異なる run の glyph が
          // 視覚的に揃わず "重なる/隙間ができる" バグがあった。
          // 修正後: cm 内 scale を完全に共通化 (sx_outer = bbox.width / textHeight, sy_outer)。
          // 全 run が同一スケールで描画され、advance は `widthOfTextAtSize * sy_outer` で一貫する。
          // Σ widthOfTextAtSize = textWidth なので Σ advance = textWidth * sy_outer = bbox.height。
          const sx_outer = block.bbox.width / textHeight;
          const sy_outer = block.bbox.height / textWidth;
          if (!isFinite(sx_outer) || !isFinite(sy_outer)) {
            console.warn(`[buildPdfDocumentCore] Page ${pageIndex}: skipped block (non-finite scale sx=${sx_outer} sy=${sy_outer}) text="${block.text.slice(0, 20)}"`);
            continue;
          }
          let offsetInPage = 0;
          let renderedAny = false;
          let lastRunFont: PDFFont | null = null;
          let lastBaselineX: number = 0;
          for (const run of runs) {
            const runHeight = run.font.heightAtSize(fontSize);
            if (runHeight === 0) continue;
            const runTextWidth = run.font.widthOfTextAtSize(run.text, fontSize);
            if (runTextWidth === 0) continue;
            const descentRatio = getFontDescentRatio(run.font, fontSize);
            const baselineX_run = block.bbox.x + descentRatio * block.bbox.width;
            const baselineY_run = vh - block.bbox.y - offsetInPage;
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.pushOperators(
              pushGraphicsState(),
              ...rotationCm,
              translate(baselineX_run + textOffsetDx, baselineY_run - textOffsetDy),
              scale(sx_outer, sy_outer),
            );
            page.drawText(run.text, { x: 0, y: 0, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            page.pushOperators(popGraphicsState());
            // #75: per-run advance は runTextWidth * sy_outer (共通スケール)。
            // Σ advance = textWidth * sy_outer = bbox.height で完全に bbox を埋める。
            offsetInPage += runTextWidth * sy_outer;
            renderedAny = true;
            lastRunFont = run.font;
            lastBaselineX = baselineX_run;
          }
          if (!renderedAny) continue;
          // issue #100 / 案A: 縦書きも横書きと同様に、最後の run の続きに invisible スペース
          // (U+0020) を描画して Acrobat の word-break heuristic を成立させる。縦書きは run ご
          // とに独立した GS フレームを持つため、境界スペース用に別フレームを push する。
          // 案A: buildBlockSeparatorOperatorsVertical で Tw 拡大済みの BT...ET を組み込む。
          // 縦書きの行方向への Tw 効果は PDF 仕様上限定的だが、一貫性のため同じ定数を使用。
          if (lastRunFont) {
            const trailingBaselineY = vh - block.bbox.y - offsetInPage;
            setPageFontWithStableKey(page, lastRunFont, pageFontKeys);
            const fontKey = pageFontKeys.get(lastRunFont);
            if (fontKey) {
              page.pushOperators(
                pushGraphicsState(),
                ...rotationCm,
                translate(lastBaselineX + textOffsetDx, trailingBaselineY - textOffsetDy),
                scale(sx_outer, sy_outer),
                ...buildBlockSeparatorOperatorsVertical(lastRunFont, fontKey, fontSize),
                popGraphicsState(),
              );
            } else {
              console.warn('[pdfSaver] separator skipped (vertical): fontKey unresolved', { pageIndex, font: lastRunFont });
            }
          }
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;

          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocumentCore] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

          // 横書き baselineY: primary font の descent 比から baseline 位置を動的に決める。
          //   baselineY = vh - bbox.y - textHeight * sy * (1 - descentRatio)
          // descentRatio はフォント実メトリクス由来 (getFontDescentRatio)。#99 では
          // heightAtSize(size, {descender:false}) から算出していたが、その pdf-lib API は
          // unitsPerEm≠1000 のフォント (Meiryo/IPAmjMincho=2048) で誤差を持ち、baseline が
          // bbox 上端方向へずれていた。primary font 代表値で十分 (混在 run でも cm は
          // primary font メトリクスで発行している)。
          const descentRatio = getFontDescentRatio(customFont, fontSize);
          const baselineY = vh - block.bbox.y - textHeight * sy * (1 - descentRatio);

          page.pushOperators(
            pushGraphicsState(),
            ...rotationCm,
            translate(block.bbox.x + textOffsetDx, baselineY - textOffsetDy),
            scale(sx, sy),
          );
          let offset = 0;
          let lastRunFont: PDFFont | null = null;
          for (const run of runs) {
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.drawText(run.text, { x: offset, y: 0, size: fontSize, renderMode: 3 });
            offset += run.font.widthOfTextAtSize(run.text, fontSize);
            lastRunFont = run.font;
          }
          // issue #100 / 案A: Acrobat の text extraction は座標と文字幅の heuristic で
          // 隣接 BB を連結する (BT...ET 境界を無視)。各 BB の末尾に invisible スペース
          // (U+0020) を 1 文字描画して word-break heuristic を成立させ、隣接 BB の連結を
          // 回避する。renderMode 3 (invisible) なので画面・印刷への影響なし。
          // 案A: setWordSpacing (Tw) で末尾スペースの advance を拡大し「語境界」と Acrobat
          // に認識させる。buildBlockSeparatorOperators は BT...ET を自己完結した単位で組む
          // ため Tw が外部に漏れない (ET 直前に 0 リセット済み)。
          if (lastRunFont) {
            const fontKey = pageFontKeys.get(lastRunFont);
            if (fontKey) {
              page.pushOperators(
                ...buildBlockSeparatorOperators(lastRunFont, fontKey, fontSize, offset, 0),
              );
            } else {
              console.warn('[pdfSaver] separator skipped: fontKey unresolved', { pageIndex, font: lastRunFont });
            }
          }
          page.pushOperators(popGraphicsState());
        }
      } catch(e) {
        console.warn(`[buildPdfDocumentCore] Page ${pageIndex} block error:`, e);
      }
    }
  }

  // 未編集ページのスイープ: issue #96 要件2 (空 q-Q ラッパー除去) + issue #1
  // (Acrobat 7 TJ 互換 仮修正: BT 外テキスト演算子の strip)。経緯の詳細と
  // PCT-059 の decode 共有最適化は sweepNonDirtyPage の JSDoc を参照。
  const dirtyPageIndexSet = new Set(pageEntriesToWrite.map(([pi]) => pi));
  for (let pi = 0; pi < pdfPageCount; pi++) {
    if (dirtyPageIndexSet.has(pi)) continue;
    const page = pdfDoc.getPage(pi);
    sweepNonDirtyPage(
      page.node as unknown as {
        get?: (key: PDFName) => PDFObject | undefined;
        Contents?: () => PDFObject | undefined;
        set: (key: PDFName, value: PDFObject) => void;
      },
      pdfDoc.context,
      contentRefCounts,
      '[buildPdfDocumentCore#1]',
    );
  }

  if (metaChanged || hadExistingBBoxMeta || hadLegacyBBoxMeta) {
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, bboxMeta);
  }

  // 修正 (#30): Catalog の /Version を消す。Acrobat は header と Catalog /Version の
  // 最大値で実効バージョンを判定するため、header だけ 1.6 に戻しても Catalog の
  // /Version 1.7 が残っていると Acrobat 7 では開けない。save() 前に削除する。
  // #85: originalVersion を渡して header >= catalog の場合のみ削除させる。
  if (originalVersion) stripCatalogVersion(pdfDoc, originalVersion);
  // Acrobat 7.0 互換性のため通常は useObjectStreams:false で旧形式 xref を維持する。
  // issue #206: ユーザーが明示的に 'compressed' プリセットを選択した場合のみ
  // useObjectStreams:true に切り替えてファイルサイズを削減する。
  // (Acrobat 7 互換テストは preset='none' で従来挙動のまま通過する)
  const useObjectStreams = options?.compression === 'compressed';
  const saveOptions: Parameters<typeof pdfDoc.save>[0] = {
    useObjectStreams,
    addDefaultPage: false,
  };

  if (typeof pdfDoc.flush === 'function') {
    await pdfDoc.flush();
  }

  // Acrobat dirty-flag 回避: 入力 PDF に /ID があれば pdf-lib trailer にも同じ /ID を
  // 書き出させる。pdf-lib は trailerInfo.ID が未設定だと /ID を一切出力しないため、
  // 明示的に同値で上書きする。後段 overwriteTrailerId は念のための binary 安全網。
  if (originalTrailerId) {
    pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([
      PDFHexString.of(originalTrailerId.id0Hex),
      PDFHexString.of(originalTrailerId.id1Hex),
    ]);
  }

  // /Root 起点 BFS で到達不能な indirect object を掃く（issue #96）。
  // pdf-lib は context 内の全 indirect object を書き出すため、ここで GC
  // しないと過去保存の孤児ストリームが累積して PDF が膨れ続ける。
  const sweepResult = sweepUnreachableObjects(pdfDoc);
  if (sweepResult.dropped > 0) {
    console.log(
      `[buildPdfDocumentCore] GC: dropped ${sweepResult.dropped} unreachable objects`,
    );
  }
  // sweep が 1 件も dropped を出していなければ indirect 番号に gap は発生しないので
  // compact (全 indirect object の再走査+再 assign) を丸ごとスキップできる。
  if (sweepResult.dropped > 0) {
    compactIndirectObjectNumbers(pdfDoc);
  }

  // D4: saveTimeoutMs が指定されている場合のみ race をかける (worker 殻は 90_000 を渡す)。
  // 未指定の場合は race なしで直接 await する (main 殻)。
  let savedBytes: Uint8Array;
  const savePromise = pdfDoc.save(saveOptions);
  if (saveTimeoutMs !== undefined) {
    const saveTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`[buildPdfDocumentCore] pdfDoc.save() timed out after ${saveTimeoutMs}ms`)), saveTimeoutMs);
    });
    savedBytes = await Promise.race([savePromise, saveTimeout]);
  } else {
    savedBytes = await savePromise;
  }

  savedBytes = ensureDenseClassicXref(savedBytes);
  if (originalTrailerId) {
    savedBytes = overwriteTrailerId(savedBytes, originalTrailerId);
  }
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);

  // dev mode セーフティチェック: 平均ページサイズが 2MB を超えた場合に警告。
  // フォントや到達可能オブジェクト再検証は重いので、平均サイズチェックのみで十分。
  if (process.env.NODE_ENV !== 'production') {
    const pageCount = pdfPageCount;
    if (pageCount > 0) {
      const avgPerPage = savedBytes.byteLength / pageCount;
      if (avgPerPage > 2 * 1024 * 1024) {
        console.warn(
          `[buildPdfDocumentCore] WARN: Avg page size ${(avgPerPage / 1024 / 1024).toFixed(2)} MB exceeds 2MB threshold (issue #96 regression?)`,
        );
      }
    }
  }

  return { savedBytes, skippedChars: getSkippedTextChars(skippedChars) };
}
