import {
  PDFDocument, StandardFonts, PDFName, PDFRawStream,
  pushGraphicsState, popGraphicsState, translate, scale, degrees,
  concatTransformationMatrix, PDFArray,
  PDFDict, PDFHexString
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { deflate } from 'pako';
import {
  stripTextBlocks,
  stripEmptyGraphicsStateBlocksOnly,
  hasTextOperatorsOutsideTextObjects,
} from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import {
  PECO_FONT_KEY_TAG,
  isPecoToolFontKey,
} from './pdfPecoToolMarkers';
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
import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';
import type { SaveDialogOptions } from '../hooks/useFileOperations';
import {
  createSkippedTextCollector,
  getSkippedTextChars,
  recordSkippedTextChar,
  sanitizeTextForPdfCopy,
  stripUnsafePdfCopyChars,
  type SkippedTextCollector,
} from './pdfSkippedTextChars';
import type { PDFObject, PDFRef, PDFFont } from '@cantoo/pdf-lib';
import {
  decodeStreamContents,
  bytesEqual,
  concatWithNewlines,
  isPdfRef,
  collectPageContentRefCounts,
  deleteIfUniqueRef,
  cleanContentStream,
  cleanFormXObjectsInResources,
  pruneStalePecoToolResources,
} from './pdfSaverCore';

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
      anyDecodeFailed = true;
      continue;
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

function pageHasTextOperatorDamage(
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

function sanitizeBBoxMetaTexts(
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

/**
 * issue #96 要件2: 未編集ページの content stream から「空 q-Q ラッパー」だけを除去する軽量パス。
 * 詳細は pdfSaver.ts 側参照（同一ロジック）。
 */
function stripEmptyQBlocksOnPage(
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
      // Critical 数式誤りを修正。pdfjs convertToPdfPoint の R=270 は user(pageW - y_v, pageH - x_v)。
      // 旧 [.. pageH-pageW pageW] は OCR テキストを画面外に描画していた (#71 の regression)。
      return [concatTransformationMatrix(0, -1, 1, 0, 0, pageH)] as const;
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
  /** issue #186: 湾曲ベースライン定義 (任意) */
  curve?: import('../types').CurveDefinition;
}

interface RepairPageData {
  textBlocks: RepairTextBlock[];
}

function asPageIndex(value: unknown): number | null {
  const pageIndex = typeof value === 'string' ? parseInt(value, 10) : value;
  return typeof pageIndex === 'number' && Number.isInteger(pageIndex) ? pageIndex : null;
}

/**
 * issue #96 Option B: existingBBoxMeta から読み出した 1 ページ分のエントリが
 * 「再描画に必要な最小情報」を備えているか検証する type guard。
 * 詳細は pdfSaver.ts 側コメント参照。
 */
function isRepairTextBlock(value: unknown): value is RepairTextBlock {
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
  // issue #179: 中間配列を生成しないよう string iterator を直接 for...of で回す。
  // pdfSaver.ts 側と同じ最適化。
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
 * フォントの descent 比 |descent| / (ascent + |descent|) を返す。
 * pdf-lib heightAtSize({descender:false}) は unitsPerEm≠1000 で誤差を持つため
 * embedder 経由で fontkit の生メトリクスから直接算出する (詳細は pdfSaver.ts 側参照)。
 */
function getFontDescentRatio(font: PDFFont, fontSize: number): number {
  const fk = (font as unknown as {
    embedder?: { font?: { ascent?: number; descent?: number } };
  }).embedder?.font;
  if (fk && typeof fk.ascent === 'number' && typeof fk.descent === 'number') {
    const span = fk.ascent - fk.descent; // ascent + |descent| (descent は負値)
    if (span > 0) return Math.abs(fk.descent) / span;
  }
  const full = font.heightAtSize(fontSize);
  if (full > 0) {
    return (full - font.heightAtSize(fontSize, { descender: false })) / full;
  }
  return 0.2;
}

/**
 * #80: Resources.Font dict scan で既存 key を再利用する (pdfSaver.ts 側詳細参照)。
 * `font.ref` 完全一致 + key tag prefix が `/<font.name>-` 一致のみ採用。
 */
function findExistingFontKey(page: unknown, font: PDFFont): PDFName | undefined {
  const pageLike = page as {
    node?: { Resources?: () => PDFDict | undefined };
  };
  const resources = pageLike.node?.Resources?.();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fontDict) return undefined;

  const targetRefKey = font.ref.toString();
  // issue #96 Fix 1: 統一タグ PECO_FONT_KEY_TAG で生成されたキーのみ再利用対象とする。
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
 * 修正 (#33, #80): Resources の Font 辞書登録と pageLike state の同期を分離する。
 * 詳細コメントは pdfSaver.ts 側参照。
 *
 * #80: cache → scan → newFontDictionary の 3 段。内部 API 依存は scan miss 時のみ。
 */
function getOrRegisterPageFontKey(
  page: unknown,
  font: PDFFont,
  fontKeys: Map<PDFFont, PDFName>,
): PDFName | undefined {
  const cached = fontKeys.get(font);
  if (cached) return cached;

  // #80: 内部 API を叩く前に Font dict scan を 1 回挟む。
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
  // issue #96 Fix 1: PECO_FONT_KEY_TAG を渡して `/PecoF-<random>` 形式の key を生成。
  let key = pageLike.node?.newFontDictionary?.(PECO_FONT_KEY_TAG, font.ref);
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
  options?: SaveDialogOptions,
): Promise<{ savedBytes: Uint8Array; skippedChars: ReturnType<typeof getSkippedTextChars> }> {
  const originalVersion = extractPdfVersion(originalPdfBytes);
  // Acrobat dirty-flag 回避: 入力 PDF の trailer /ID を保存後に書き戻す。
  const originalTrailerId = extractTrailerId(originalPdfBytes);
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

  const hadLegacyBBoxMeta = hasLegacyPecoToolBBoxInfo(pdfDoc);
  const existingBBoxMeta = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);

  // Acrobat dirty-flag 回避 short-circuit (詳細は pdfSaver.ts 側参照)。
  if (
    dirtyPages.length === 0 &&
    !hadLegacyBBoxMeta &&
    Object.keys(existingBBoxMeta).length === 0
  ) {
    return { savedBytes: originalPdfBytes, skippedChars: getSkippedTextChars(skippedChars) };
  }

  const bboxMeta: Record<string, unknown> = { ...existingBBoxMeta };
  let metaChanged = false;
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
    if (pageIndex === null || pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
    pagesToWrite.set(pageIndex, { textBlocks: pageData.textBlocks });
  }

  // issue #96 要件2 (Option B): 「未編集だが明らかに bloated」なページを自動検知して
  // フルクリーンアップ対象に追加する。詳細は pdfSaver.ts 側コメント参照（同一ロジック）。
  //
  // 検知条件: (a) 未 dirty / (b) existingBBoxMeta にエントリ有 / (c) Pecotool 由来フォント
  // 辞書が BLOAT_THRESHOLD 個超 / (d) fontBytes (Japanese-capable) 有
  //
  // 副作用: pruneStalePecoToolResources + replacePageTextContentStreams + drawText 再描画
  //         により Meiryo subset 群が 1 個の PecoF subset に集約される。
  const BLOAT_DETECTION_FONT_THRESHOLD = 3;
  if (fontBytes) {
    for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
      if (pagesToWrite.has(pi)) continue;
      const entries = existingBBoxMeta[String(pi)];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      const page = pdfDoc.getPage(pi);
      // issue #171: 軽量な font エントリ数チェックで先に絞り込み、
      // 該当する場合のみ重い pageHasTextOperatorDamage (pako.inflate 伴う) を走らせる。
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
      if (!hasLegacyBloat) continue;
      const hasTextOperatorDamage = pageHasTextOperatorDamage(
        page.node as unknown as { get?: (key: PDFName) => PDFObject | undefined; Contents?: () => PDFObject | undefined },
        pdfDoc.context,
      );
      if (!hasTextOperatorDamage) continue;

      const repairBlocks = entries
        .filter(isRepairTextBlock)
        .map((block) => {
          const out: RepairTextBlock = {
            text: block.text,
            bbox: block.bbox,
            writingMode: block.writingMode,
            order: block.order,
          };
          if (isCurveDefinition((block as { curve?: unknown }).curve)) {
            out.curve = (block as { curve: import('../types').CurveDefinition }).curve;
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

    bboxMeta[String(pageIndex)] = sortedBlocks.map((b) => {
      const entry: Record<string, unknown> = {
        bbox: b.bbox,
        writingMode: b.writingMode,
        order: b.order,
        text: b.text,
      };
      if (b.curve) entry.curve = b.curve;
      return entry;
    });
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

        // issue #187: curve 定義があるブロックは per-glyph Tm/Tj 経路で描画する。
        // 詳細は pdfSaver.ts 側コメント参照 (同一ロジック)。
        if (block.curve) {
          const ops = buildCurveBlockOperators(
            block.text,
            block.curve,
            customFont,
            pageFontKeys.get(customFont)!,
            fontSize,
            vh,
            rotationCm as unknown as Parameters<typeof buildCurveBlockOperators>[6],
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
              translate(baselineX_run, baselineY_run),
              scale(sx_outer, sy_outer),
            );
            page.drawText(run.text, { x: 0, y: 0, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            page.pushOperators(popGraphicsState());
            offsetInPage += runTextWidth * sy_outer;
            renderedAny = true;
            lastRunFont = run.font;
            lastBaselineX = baselineX_run;
          }
          if (!renderedAny) continue;
          // issue #100: 詳細コメントは pdfSaver.ts 側参照。invisible U+0020 で Acrobat の
          // word-break heuristic を成立させ、Ctrl+A 連結を回避する。
          if (lastRunFont) {
            const trailingBaselineY = vh - block.bbox.y - offsetInPage;
            setPageFontWithStableKey(page, lastRunFont, pageFontKeys);
            page.pushOperators(
              pushGraphicsState(),
              ...rotationCm,
              translate(lastBaselineX, trailingBaselineY),
              scale(sx_outer, sy_outer),
            );
            page.drawText(' ', { x: 0, y: 0, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            page.pushOperators(popGraphicsState());
          }
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;

          if (!isFinite(sx) || !isFinite(sy)) continue;

          // 横書き baselineY: primary font の descent 比 (getFontDescentRatio) から動的計算。
          // 詳細コメントは pdfSaver.ts 側参照。
          const descentRatio = getFontDescentRatio(customFont, fontSize);
          const baselineY = vh - block.bbox.y - textHeight * sy * (1 - descentRatio);
          page.pushOperators(
            pushGraphicsState(),
            ...rotationCm,
            translate(block.bbox.x, baselineY),
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
          // issue #100: 詳細コメントは pdfSaver.ts 側参照。invisible U+0020 で Acrobat の
          // word-break heuristic を成立させ、Ctrl+A 連結を回避する。
          if (lastRunFont) {
            page.drawText(' ', { x: offset, y: 0, size: fontSize, renderMode: 3 });
          }
          page.pushOperators(popGraphicsState());
        }
      } catch (e) {
        console.warn(`[pdf.worker] Page ${pageIndex} block error:`, e);
      }
    }
  }

  if (metaChanged || Object.keys(existingBBoxMeta).length > 0 || hadLegacyBBoxMeta) {
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, bboxMeta);
  }

  // issue #96 要件2: 未編集ページにも空 q-Q ラッパー除去のみ適用 (詳細は pdfSaver.ts 側参照)。
  const dirtyPageIndexSet = new Set(pageEntriesToWrite.map(([pi]) => pi));
  for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
    if (dirtyPageIndexSet.has(pi)) continue;
    const page = pdfDoc.getPage(pi);
    stripEmptyQBlocksOnPage(
      page.node as unknown as {
        get?: (key: PDFName) => PDFObject | undefined;
        Contents?: () => PDFObject | undefined;
        set: (key: PDFName, value: PDFObject) => void;
      },
      pdfDoc.context,
    );
  }

  // 修正 (#30): Catalog の /Version を消す (詳細は pdfSaver.ts 側コメント参照)。
  // #85: originalVersion を渡して header >= catalog の場合のみ削除させる。
  if (originalVersion) stripCatalogVersion(pdfDoc, originalVersion);
  // Acrobat 7.0 互換性のため通常は useObjectStreams:false で旧形式 xref を維持する。
  // issue #206: ユーザーが明示的に 'compressed' プリセットを選択した場合のみ
  // useObjectStreams:true に切り替えてファイルサイズを削減する。
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
      `[pdf.worker] GC: dropped ${sweepResult.dropped} unreachable objects`,
    );
  }
  // sweep が 1 件も dropped を出していなければ indirect 番号に gap は発生しないので
  // compact (全 indirect object の再走査+再 assign) を丸ごとスキップできる。
  if (sweepResult.dropped > 0) {
    compactIndirectObjectNumbers(pdfDoc);
  }

  // pdf-lib save() が pdf-lib 内部で hang する edge case 対策として 90s timeout を設定。
  const savePromise = pdfDoc.save(saveOptions);
  const saveTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('[pdf.worker] pdfDoc.save() timed out after 90s')), 90_000);
  });
  let savedBytes = await Promise.race([savePromise, saveTimeout]);
  savedBytes = ensureDenseClassicXref(savedBytes);
  if (originalTrailerId) {
    savedBytes = overwriteTrailerId(savedBytes, originalTrailerId);
  }
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);

  // dev mode セーフティチェック: 平均ページサイズが 2MB を超えた場合に警告。
  if (process.env.NODE_ENV !== 'production') {
    const pageCount = pdfDoc.getPageCount();
    if (pageCount > 0) {
      const avgPerPage = savedBytes.byteLength / pageCount;
      if (avgPerPage > 2 * 1024 * 1024) {
        console.warn(
          `[pdf.worker] WARN: Avg page size ${(avgPerPage / 1024 / 1024).toFixed(2)} MB exceeds 2MB threshold (issue #96 regression?)`,
        );
      }
    }
  }

  return { savedBytes, skippedChars: getSkippedTextChars(skippedChars) };
}

export const __handleSavePdfForTest = handleSavePdf;

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
        const { documentState, fallbackFontBytes, fontBytes, options } = msg.data;
        const originalPdfBytes = await resolvePdfBytes(msg.data);
        const { savedBytes, skippedChars } = await handleSavePdf(originalPdfBytes, documentState, fontBytes, fallbackFontBytes, options);
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
