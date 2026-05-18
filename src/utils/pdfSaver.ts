import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale, PDFName, PDFHexString, PDFString, PDFRawStream, PDFArray,
  PDFDict
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import { deflate, inflate } from 'pako';
import { stripTextBlocks } from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import { safeDecodePdfText } from './pdfLibSafeDecode';
import type {
  SavePdfSource,
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
  SkippedPdfTextChar,
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

// テスト互換のため再輸出（src/__tests__/unit/pdfSaver.stripTextBlocks.repro.test.ts 等）
export { stripTextBlocks };

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
  const decodedStreams: Uint8Array[] = [];

  for (const streamRef of streams) {
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) return;
    const decoded = decodeStreamContents(stream);
    if (decoded === null) {
      cleanContentStream(stream);
      return;
    }
    decodedStreams.push(decoded);
  }

  const merged = concatWithNewlines(decodedStreams);
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
 *
 * 旧実装:
 *   `pageLike.font = font;` を毎回無条件で代入し、その後 `pageLike.fontKey` を
 *   key 取得時のみ条件付きで代入していた。fallback で `pageLike.setFont?.(font)`
 *   を呼ぶ経路では setFont 内部で `newFontDictionary` がさらに呼ばれ、同じ font
 *   ref に対し Resources の Font dict に複数のユニークキーが追加される多重 alias
 *   が発生する余地があった (Meiryo ⇄ IPAmjMincho を 1 ページで切り替えるケース)。
 *
 * 新実装:
 *   1. `getOrRegisterPageFontKey()` — 同じ font には常に同じ key を返す純粋関数。
 *      cache hit なら何もしない。miss のときだけ 1 度だけ newFontDictionary を呼ぶ。
 *   2. `syncPageFontState()` — pageLike.font / pageLike.fontKey をペアで上書き。
 *      key が無いときは何も書かない (drawText で誤キー出力を防ぐ)。
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
    // fallback 経路: setFont は newFontDictionary を内部で呼ぶため、上の newFontDictionary
    // が成功しているときは絶対に踏まないように上の if で gating する。
    pageLike.setFont?.(font);
    key = pageLike.fontKey;
  }
  if (key) fontKeys.set(font, key);
  return key;
}

function syncPageFontState(page: unknown, font: PDFFont, key: PDFName | undefined): void {
  const pageLike = page as { font?: PDFFont; fontKey?: PDFName };
  if (!key) return; // key が解決できなければ pageLike の前回 state を維持 (誤キー出力防止)
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

/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
 * Powered by @cantoo/pdf-lib.
 */

/**
 * 保存対象の元 PDF ソース指定:
 * - Uint8Array を直接渡す（従来互換）
 * - `SavePdfSource`（{bytes} / {url}）を渡す。URL 経路は main thread 側で
 *   fetch → arrayBuffer する（Worker 経路では pdf.worker.ts 内で fetch するため
 *   main thread heap を経由しない）
 */
export type BuildPdfSource = Uint8Array | SavePdfSource;

async function resolveBuildPdfSource(source: BuildPdfSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source.bytes) return source.bytes;
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`[buildPdfDocument] fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** BuildPdfSource から bytes 経路の Uint8Array を抽出する（無ければ null） */
function extractBytes(source: BuildPdfSource): Uint8Array | null {
  if (source instanceof Uint8Array) return source;
  return source.bytes ?? null;
}

/** BuildPdfSource から URL を抽出する（無ければ null） */
function extractUrl(source: BuildPdfSource): string | null {
  if (source instanceof Uint8Array) return null;
  return source.url ?? null;
}

export async function buildPdfDocument(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer,
  fallbackFontBytes: ArrayBuffer[] = [],
  onSkippedChars?: (chars: SkippedPdfTextChar[]) => void,
): Promise<Uint8Array> {
  const originalPdfBytes = await resolveBuildPdfSource(source);
  const originalVersion = extractPdfVersion(originalPdfBytes);
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

  const dirtyPages = Array.from(documentState.pages.entries()).filter(([, pageData]) => pageData.isDirty);
  const contentRefCounts = collectPageContentRefCounts(pdfDoc);
  const skippedChars = createSkippedTextCollector();

  // getInfoDict() は pdf-lib の public API には無いため、型アサーションで呼び出す
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

  const bboxMeta = { ...existingBBoxMeta };
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

  for (const [pageIndex, pageData] of pageEntriesToWrite) {
    
    const sortedBlocks = [...pageData.textBlocks]
      .map((block) => ({ ...block, text: sanitizeTextForPdfCopy(block.text, skippedChars, pageIndex) }))
      .sort((a, b) => a.order - b.order);
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
    pruneStalePecoToolResources(page.node as unknown as { Resources?: () => PDFDict | undefined });
    cleanFormXObjectsInResources(page.node.Resources?.(), pdfDoc.context);
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

    // Now draw the NEW text blocks onto the cleaned page
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
        
        if (textWidth === 0 || textHeight === 0) {
          console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (zero font metrics) text="${block.text.slice(0, 20)}"`);
          continue;
        }

        if (block.writingMode === 'vertical') {
          // 修正 (#23, #28): 縦書きは run ごとに pushGraphicsState / scale を切り替え、
          // それぞれのフォントの heightAtSize / ascent でスケールと baselineX を算出する。
          //  - sy: 全 run 共通 (bbox.height / totalTextWidth) — 縦方向の総スケール
          //  - sx_run: 各 run の heightAtSize から算出。混在フォントでも縦幅にフィットする
          //  - baselineX_run: ascent 比から導出 (Meiryo 0.2 マジックナンバーを廃止)
          //  - offsetInPage: ページ座標で累積する縦方向 advance
          const sy = block.bbox.height / textWidth;
          if (!isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }
          let offsetInPage = 0;
          let renderedAny = false;
          for (const run of runs) {
            const runHeight = run.font.heightAtSize(fontSize);
            if (runHeight === 0) continue;
            const sx_run = block.bbox.width / runHeight;
            if (!isFinite(sx_run)) {
              console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped run (non-finite scale sx=${sx_run}) text="${run.text.slice(0, 20)}"`);
              continue;
            }
            const runAscent = run.font.heightAtSize(fontSize, { descender: false });
            const descentRatio = (runHeight - runAscent) / runHeight;
            const baselineX_run = block.bbox.x + descentRatio * block.bbox.width;
            const baselineY_run = height - block.bbox.y - offsetInPage;
            setPageFontWithStableKey(page, run.font, pageFontKeys);
            page.pushOperators(
              pushGraphicsState(),
              translate(baselineX_run, baselineY_run),
              scale(sx_run, sy),
            );
            page.drawText(run.text, { x: 0, y: 0, size: fontSize, rotate: degrees(-90), renderMode: 3 });
            page.pushOperators(popGraphicsState());
            offsetInPage += run.font.widthOfTextAtSize(run.text, fontSize) * sy;
            renderedAny = true;
          }
          if (!renderedAny) continue;
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          
          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

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
      } catch(e) {
        console.warn(`[buildPdfDocument] Page ${pageIndex} block error:`, e);
      }
    }
  }

  if (metaChanged && infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  // 修正 (#30): Catalog の /Version を消す。Acrobat は header と Catalog /Version の
  // 最大値で実効バージョンを判定するため、header だけ 1.6 に戻しても Catalog の
  // /Version 1.7 が残っていると Acrobat 7 では開けない。save() 前に削除する。
  if (originalVersion) stripCatalogVersion(pdfDoc);
  // Acrobat 7.0 互換性のため useObjectStreams:false で旧形式 xref を維持する。
  // save() 全書き換え経路。pdf-lib は streaming serializer で、ベンチ実測では
  // 100MB PDF でも 91ms で完了する (disk write は別段の writeFileChunked で処理)。
  const saveOptions: Parameters<typeof pdfDoc.save>[0] = {
    useObjectStreams: false,
    addDefaultPage: false,
  };
  const savedBytes = await pdfDoc.save(saveOptions);
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);
  onSkippedChars?.(getSkippedTextChars(skippedChars));
  return savedBytes;
}


let activeSaveWorker: Worker | null = null;
let currentSaveTask: Promise<Uint8Array> | null = null;

const PREVIOUS_SAVE_TIMEOUT_MS = 5000;
// 保存全体のハードタイムアウト。Worker 内で fetch や pdf-lib が想定外に無応答に
// なった場合でも、ここで強制的に reject して呼び出し側に失敗を返す。
const SAVE_HARD_TIMEOUT_MS = 120_000;

/**
 * Worker を生成するファクトリ。テストからの差し替えを容易にするため internal export。
 * 本番では `new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })` が使われる。
 * Worker API が利用できない環境（JSDOM 等）では null を返し、呼び出し側で main thread 実行にフォールバックする。
 */
export type SaveWorkerFactory = () => Worker | null;

let createSaveWorker: SaveWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
};

/** テスト用: Worker ファクトリを差し替える（テスト後は __resetSaveWorkerFactory で元に戻す） */
export function __setSaveWorkerFactoryForTest(factory: SaveWorkerFactory): void {
  createSaveWorker = factory;
}

/** テスト用: savePDF のモジュール状態（activeSaveWorker / currentSaveTask）をリセット */
export function __resetSaveStateForTest(): void {
  if (activeSaveWorker) {
    try { activeSaveWorker.terminate(); } catch { /* noop */ }
  }
  activeSaveWorker = null;
  currentSaveTask = null;
}

export async function savePDF(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer,
  fallbackFontBytes: ArrayBuffer[] = [],
  onSkippedChars?: (chars: SkippedPdfTextChar[]) => void,
): Promise<Uint8Array> {
  const sourceBytes = extractBytes(source);
  const sourceUrl = extractUrl(source);
  // 前回の保存が未完了の場合、完了 or タイムアウトまで待ってから新 worker を起動する
  if (currentSaveTask) {
    const timeoutSymbol = Symbol('timeout');
    const timeoutPromise = new Promise<typeof timeoutSymbol>((resolve) => {
      setTimeout(() => resolve(timeoutSymbol), PREVIOUS_SAVE_TIMEOUT_MS);
    });
    try {
      const raceResult = await Promise.race([
        currentSaveTask.then(() => 'done' as const, () => 'done' as const),
        timeoutPromise,
      ]);
      if (raceResult === timeoutSymbol) {
        console.warn('[savePDF] Previous save did not complete within timeout; terminating stale worker.');
        if (activeSaveWorker) {
          try { activeSaveWorker.terminate(); } catch { /* noop: terminate の二重呼び出しは無害扱い */ }
          activeSaveWorker = null;
        }
        currentSaveTask = null;
      }
    } catch {
      // 前回タスクの reject は無視（既に解決済み扱い）
    }
  }

  const task = new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const settleResolve = (value: Uint8Array) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    let worker: Worker | null = null;
    try {
      worker = createSaveWorker();
      if (!worker) {
        // Worker API 不在: main thread で直接実行
        buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars)
          .then(settleResolve)
          .catch(settleReject);
        return;
      }
      const activeWorker = worker;
      activeSaveWorker = activeWorker;

      const cleanup = () => {
        if (activeSaveWorker === activeWorker) activeSaveWorker = null;
        // terminate は idempotent: 二重呼び出しでも例外にならない。
        try { activeWorker.terminate(); } catch { /* noop */ }
      };

      // Worker が想定外に無応答になった場合のハードタイムアウト。
      // 正常経路では success/error 受領時に clearTimeout される。
      hardTimeoutId = setTimeout(() => {
        if (settled) return;
        console.warn('[savePDF] hard timeout reached; terminating worker.');
        cleanup();
        settleReject(new Error('保存がタイムアウトしました。'));
      }, SAVE_HARD_TIMEOUT_MS);

      activeWorker.onmessage = (e: MessageEvent<SavePdfWorkerResponse>) => {
        if (settled) return;
        const msg = e.data;
        if (msg.type === 'SAVE_PDF_SUCCESS') {
          cleanup();
          onSkippedChars?.(msg.skippedChars ?? []);
          settleResolve(msg.data);
        } else if (msg.type === 'ERROR') {
          cleanup();
          settleReject(new Error(msg.message));
        }
      };

      activeWorker.onerror = (err) => {
        if (settled) return;
        err.preventDefault();
        cleanup();
        const details = err instanceof ErrorEvent
          ? [
              err.message,
              err.filename ? `${err.filename}:${err.lineno}:${err.colno}` : '',
              err.error instanceof Error ? err.error.stack : '',
            ].filter(Boolean).join('\n')
          : String(err);
        settleReject(new Error(details || 'PDF保存ワーカーでエラーが発生しました。'));
      };

      activeWorker.onmessageerror = (err) => {
        if (settled) return;
        cleanup();
        settleReject(new Error(`PDF保存ワーカーとの通信に失敗しました: ${String(err)}`));
      };

      const serializedPages: Record<number, SerializedPageData> = {};
      for (const [idx, page] of documentState.pages.entries()) {
        // thumbnail は Worker 内で不要な blob URL であるため除去する
        const { thumbnail: _t, ...pageWithoutThumbnail } = page;
        serializedPages[idx] = pageWithoutThumbnail;
      }

      const transferables: Transferable[] = [];
      const fontBytesClone = fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined;
      if (fontBytesClone) transferables.push(fontBytesClone);
      const fallbackFontBytesClone = fallbackFontBytes.map((bytes) => bytes.slice(0));
      for (const bytes of fallbackFontBytesClone) transferables.push(bytes);

      // URL 経路は Worker 内で直接 fetch するため main thread heap を経由しない。
      // bytes 経路は従来どおり buffer を transfer する。
      // bytes が取れれば優先 (fetch 不要)、取れなければ url を Worker に転送する。
      let sourcePayload: SavePdfSource;
      if (sourceBytes) {
        const bytesClone = sourceBytes.slice();
        transferables.push(bytesClone.buffer);
        sourcePayload = { bytes: bytesClone };
      } else if (sourceUrl) {
        sourcePayload = { url: sourceUrl };
      } else {
        throw new Error('[savePDF] source must contain bytes or url');
      }

      const request: SavePdfWorkerRequest = {
        type: 'SAVE_PDF',
        data: {
          ...sourcePayload,
          documentState: { ...documentState, pages: serializedPages },
          fontBytes: fontBytesClone,
          fallbackFontBytes: fallbackFontBytesClone,
        },
      };
      activeWorker.postMessage(request, transferables);
    } catch (err) {
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      if (activeSaveWorker === worker) activeSaveWorker = null;
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars)
        .then(settleResolve)
        .catch(settleReject);
    }
  });

  currentSaveTask = task;
  try {
    return await task;
  } finally {
    if (currentSaveTask === task) currentSaveTask = null;
  }
}

