import {
  PDFDocument, StandardFonts, PDFName,
  pushGraphicsState, popGraphicsState, translate, scale, degrees,
  PDFDict, PDFHexString
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import {
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
  sanitizeTextForPdfCopy,
  stripUnsafePdfCopyChars,
} from './pdfSkippedTextChars';
import type { PDFObject, PDFFont } from '@cantoo/pdf-lib';
import {
  collectPageContentRefCounts,
  cleanFormXObjectsInResources,
  pruneStalePecoToolResources,
  replacePageTextContentStreams,
  pageHasTextOperatorDamage,
  sanitizeBBoxMetaTexts,
  sweepNonDirtyPage,
  getRotationCm,
  normalizeRotation,
  getViewportSize,
  asPageIndex,
  isRepairTextBlock,
  makeFontSupportSet,
  splitTextBySupportedFont,
  measureRuns,
  getFontDescentRatio,
  setPageFontWithStableKey,
  type RepairTextBlock,
  type RepairPageData,
} from './pdfSaverCore';

function remapBBoxMetaForPageOrder(
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

async function handleSavePdf(
  originalPdfBytes: Uint8Array,
  documentState: { pages: Record<number, SerializedPageData> },
  fontBytes: ArrayBuffer | undefined,
  fallbackFontBytes: ArrayBuffer[] = [],
  pageOrder?: number[],
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
  const originalPdfPageCount = pdfDoc.getPageCount();

  const isDefaultOrder =
    !pageOrder ||
    (pageOrder.length === originalPdfPageCount &&
      pageOrder.every((v, i) => v === i));
  if (!isDefaultOrder && pageOrder) {
    const copiedPages = await pdfDoc.copyPages(pdfDoc, pageOrder);
    for (let i = originalPdfPageCount - 1; i >= 0; i--) {
      pdfDoc.removePage(i);
    }
    for (const page of copiedPages) {
      pdfDoc.addPage(page);
    }
  }

  const pdfPageCount = pdfDoc.getPageCount();

  const pagesArray = Object.entries(documentState.pages) as Array<[string, SerializedPageData]>;
  const dirtyPages = pagesArray.filter(([, pageData]) => pageData.isDirty);
  const contentRefCounts = collectPageContentRefCounts(pdfDoc);
  const skippedChars = createSkippedTextCollector();

  const hadLegacyBBoxMeta = hasLegacyPecoToolBBoxInfo(pdfDoc);
  const rawExistingBBoxMeta = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
  const existingBBoxMeta = remapBBoxMetaForPageOrder(rawExistingBBoxMeta, pageOrder, isDefaultOrder);
  const hadExistingBBoxMeta = Object.keys(rawExistingBBoxMeta).length > 0;

  // Acrobat dirty-flag 回避 short-circuit (詳細は pdfSaver.ts 側参照)。
  if (
    isDefaultOrder &&
    dirtyPages.length === 0 &&
    !hadLegacyBBoxMeta &&
    !hadExistingBBoxMeta
  ) {
    return { savedBytes: originalPdfBytes, skippedChars: getSkippedTextChars(skippedChars) };
  }

  const bboxMeta: Record<string, unknown> = { ...existingBBoxMeta };
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
  // フルクリーンアップ対象に追加する。詳細は pdfSaver.ts 側コメント参照（同一ロジック）。
  //
  // 検知条件: (a) 未 dirty / (b) existingBBoxMeta にエントリ有 / (c) Pecotool 由来フォント
  // 辞書が BLOAT_THRESHOLD 個超 / (d) fontBytes (Japanese-capable) 有
  //
  // 副作用: pruneStalePecoToolResources + replacePageTextContentStreams + drawText 再描画
  //         により Meiryo subset 群が 1 個の PecoF subset に集約される。
  const BLOAT_DETECTION_FONT_THRESHOLD = 3;
  if (fontBytes) {
    for (let pi = 0; pi < pdfPageCount; pi++) {
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
      // PCT-052: pdfSaver.ts と同様に confidence を永続化する。
      // undefined でない場合のみキーを書き込む（後方互換: 欠如時は undefined 扱いのまま）。
      if (b.confidence !== undefined) entry.confidence = b.confidence;
      return entry;
    });
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { width: pageW, height: pageH } = page.getSize();
    // #71: 詳細コメントは pdfSaver.ts 側参照。viewport-space bbox を rotation 別 cm で描画する。
    const rotation = normalizeRotation(page.getRotation?.().angle ?? 0); // PCT-053: pdfSaver.ts と同様に optional chaining で統一
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
      '[pdf.worker]',
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

  if (metaChanged || hadExistingBBoxMeta || hadLegacyBBoxMeta) {
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, bboxMeta);
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
      '[pdf.worker#1]',
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
    const pageCount = pdfPageCount;
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
        const { documentState, fallbackFontBytes, fontBytes, pageOrder, options } = msg.data;
        const originalPdfBytes = await resolvePdfBytes(msg.data);
        const { savedBytes, skippedChars } = await handleSavePdf(originalPdfBytes, documentState, fontBytes, fallbackFontBytes, pageOrder, options);
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
