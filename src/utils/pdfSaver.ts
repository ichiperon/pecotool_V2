import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale,
  PDFName,
  PDFDict, PDFHexString
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import {
  stripTextBlocks,
} from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion, stripCatalogVersion } from './pdfVersion';
import {
  isPecoToolFontKey,
} from './pdfPecoToolMarkers';
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
  SavePdfSource,
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
  SkippedPdfTextChar,
} from './pdfWorkerTypes';
import type { SaveDialogOptions } from '../hooks/useFileOperations';
import {
  createSkippedTextCollector,
  getSkippedTextChars,
  sanitizeTextForPdfCopy,
  stripUnsafePdfCopyChars,
} from './pdfSkippedTextChars';
import type { PDFObject, PDFFont } from '@cantoo/pdf-lib';

// テスト互換のため再輸出（src/__tests__/unit/pdfSaver.stripTextBlocks.repro.test.ts 等）
export { stripTextBlocks };
// テスト互換のため再輸出（src/__tests__/unit/pdfSaverDescentRatio.test.ts）
export { getFontDescentRatio } from './pdfSaverCore';


/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
 * Sweeps unreachable indirect objects before save (issue #96)
 *   so that re-loading and re-saving a bloated PDF converges to a normal size.
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

export async function buildPdfDocument(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer,
  fallbackFontBytes: ArrayBuffer[] = [],
  onSkippedChars?: (chars: SkippedPdfTextChar[]) => void,
  pageOrder?: number[],
  options?: SaveDialogOptions,
): Promise<Uint8Array> {
  const originalPdfBytes = await resolveBuildPdfSource(source);
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

  const dirtyPages = Array.from(documentState.pages.entries()).filter(([, pageData]) => pageData.isDirty);
  const contentRefCounts = collectPageContentRefCounts(pdfDoc);
  const skippedChars = createSkippedTextCollector();

  const hadLegacyBBoxMeta = hasLegacyPecoToolBBoxInfo(pdfDoc);
  const rawExistingBBoxMeta = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
  const existingBBoxMeta = remapBBoxMetaForPageOrder(rawExistingBBoxMeta, pageOrder, isDefaultOrder);
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
  if (
    isDefaultOrder &&
    dirtyPages.length === 0 &&
    !hadLegacyBBoxMeta &&
    !hadExistingBBoxMeta
  ) {
    const earlySweep = sweepUnreachableObjects(pdfDoc);
    if (earlySweep.dropped === 0) {
      return originalPdfBytes;
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
            out.curve = (block as { curve: import('../types').CurveDefinition }).curve;
          }
          // NOTE: confidence は repair 経路で引き継がない。次回保存時に bboxMeta 経由で再永続化されるため
          // 一時的欠落に留まる（PCT-047 設計上の許容）。
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
      '[pdfSaver]',
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
          console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (zero font metrics) text="${block.text.slice(0, 20)}"`);
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
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx_outer} sy=${sy_outer}) text="${block.text.slice(0, 20)}"`);
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
              translate(baselineX_run, baselineY_run),
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
          // issue #100: 横書きと同じく invisible スペース (U+0020) を 1 文字、最後の run の続きに
          // 描画して Acrobat の word-break heuristic を成立させる (Ctrl+A コピペで隣接 BB が
          // 連結されるのを回避)。縦書きは run ごとに独立した GS フレームを持つため、空白用の
          // フレームをもう 1 つ push する。U+0020 は writingMode に依らず word break として機能する。
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

          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
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
          // issue #100: Acrobat の text extraction は座標と文字幅の heuristic で隣接 BB を連結する
          // (BT...ET 境界を無視)。各 BB の末尾に invisible スペース (U+0020) を 1 文字描画して
          // Acrobat の word-break heuristic を成立させ、Ctrl+A → コピペで「あいう」「えお」が
          // 「あいうえお」に連結されるのを回避する。renderMode 3 (invisible) なので画面表示や
          // 印刷は完全に同等。最後の run のフォントで描画 (U+0020 は全 Latin/CJK フォントで対応)。
          if (lastRunFont) {
            page.drawText(' ', { x: offset, y: 0, size: fontSize, renderMode: 3 });
          }
          page.pushOperators(popGraphicsState());
        }
      } catch(e) {
        console.warn(`[buildPdfDocument] Page ${pageIndex} block error:`, e);
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
      '[pdfSaver#1]',
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
      `[buildPdfDocument] GC: dropped ${sweepResult.dropped} unreachable objects`,
    );
  }
  // sweep が 1 件も dropped を出していなければ indirect 番号に gap は発生しないので
  // compact (全 indirect object の再走査+再 assign) を丸ごとスキップできる。
  if (sweepResult.dropped > 0) {
    compactIndirectObjectNumbers(pdfDoc);
  }

  let savedBytes = await pdfDoc.save(saveOptions);
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
          `[buildPdfDocument] WARN: Avg page size ${(avgPerPage / 1024 / 1024).toFixed(2)} MB exceeds 2MB threshold (issue #96 regression?)`,
        );
      }
    }
  }

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
  pageOrder?: number[],
  options?: SaveDialogOptions,
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
        buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars, pageOrder, options)
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
        if (typeof err?.preventDefault === 'function') err.preventDefault();
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
      // TODO(#184): 現状 save worker を毎回 spawn するため、保存のたびに
      // フォントバイト列 (Meiryo ~3MB + fallbacks 数MB) を slice() で full copy
      // して transfer している。本来は save worker をシングルトン化して
      // 初回 LOAD で 1 度だけフォントを送り、以降は ArrayBuffer をプールから
      // 再利用したい。要・別 enhancement issue で対応。当面は安全側で
      // 都度 clone のまま維持 (worker への transfer はメインヒープを破壊するため
      // 短命 worker と心中させる現方針が事故率は低い)。
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
          pageOrder,
          options,
        },
      };
      activeWorker.postMessage(request, transferables);
    } catch (err) {
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      if (activeSaveWorker === worker) activeSaveWorker = null;
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars, pageOrder, options)
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

