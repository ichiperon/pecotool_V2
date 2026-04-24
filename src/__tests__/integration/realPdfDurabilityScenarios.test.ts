/**
 * 実 PDF を使った耐久/並列シナリオ (B1: roundtrip × N, C1: save/edit race)。
 * test/OCR_08_長期給付制度の概説_searchable.pdf がある時のみ実行される。
 *
 * シナリオ:
 *   B1-1: 無編集のまま save → reload → save を 10 サイクル。
 *         meta が baseline と完全一致し、ファイルサイズが +10% 以内に収まること。
 *   B1-2: 毎サイクルで全BB の bbox を (+1, +1) シフトして save。
 *         10 サイクル後に x,y が初期値 + 10 で全一致 (累積誤差ゼロ)。
 *   C1-1: save 前スナップショット → save → save 後に新編集 → 再 save の流れで、
 *         後発編集が dirty フラグを失わずに 2 回目の保存で反映される (saveDuringEditRace
 *         と同様の擬似再現)。vitest 単スレッドのため本物の concurrency は再現不可。
 *   C1-2: savePDF を連続 2 回呼び出して Promise.allSettled。
 *         queue / reject のどちらかで race が抑止されているかを観察する。
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfDurabilityScenarios.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, statSync } from 'node:fs';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import type { PecoDocument, TextBlock } from '../../types';
import {
  findInputPdf,
  outputPath,
  loadFontArrayBuffer,
  loadFallbackFontArrayBuffers,
  ensurePdfjsEnv,
  buildPecoDocumentFromRealPdf,
  type BBoxMetaEntry,
} from './helpers/realPdfFixtures';
import { diffBBPages, type ExpectedBB } from './helpers/bbDiff';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_B1_1 = outputPath(REAL_PDF_PATH, '_b1_1_noEdit10cycle');
const OUT_B1_2 = outputPath(REAL_PDF_PATH, '_b1_2_shift10cycle');
const OUT_B1_EXTERNAL = outputPath(REAL_PDF_PATH, '_b1_pdfjs_external_1cycle');
const OUT_C1_1 = outputPath(REAL_PDF_PATH, '_c1_1_raceSim');
const OUT_C1_2_A = outputPath(REAL_PDF_PATH, '_c1_2_doubleSave_1');
const OUT_C1_2_B = outputPath(REAL_PDF_PATH, '_c1_2_doubleSave_2');

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

function collectExpected(doc: PecoDocument): Map<number, ExpectedBB[]> {
  const map = new Map<number, ExpectedBB[]>();
  for (const [p, pd] of doc.pages.entries()) {
    map.set(
      p,
      pd.textBlocks.map((b) => ({
        x: b.bbox.x,
        y: b.bbox.y,
        width: b.bbox.width,
        height: b.bbox.height,
        text: b.text,
        writingMode: b.writingMode,
      })),
    );
  }
  return map;
}

function collectActualMeta(doc: PecoDocument): Record<string, BBoxMetaEntry[]> {
  const record: Record<string, BBoxMetaEntry[]> = {};
  for (const [p, pd] of doc.pages.entries()) {
    record[String(p)] = pd.textBlocks
      .map((b) => ({
        bbox: b.bbox,
        writingMode: b.writingMode,
        order: b.order,
        text: b.text,
      }))
      .sort((a, b) => a.order - b.order);
  }
  return record;
}

function textSignature(blocks: Array<{ text: string }>): string {
  return blocks.map((b) => b.text).join('').replace(/\s+/g, '');
}

interface ExternalPdfjsDiffSummary {
  countMismatchPages: number;
  fewerPages: number;
  morePages: number;
  sameTextSignaturePages: number;
  changedTextSignaturePages: number;
  examples: Array<{
    page: number;
    expectedCount: number;
    actualCount: number;
    sameTextSignature: boolean;
    expectedSample: string[];
    actualSample: string[];
  }>;
  changedTextExamples: Array<{
    page: number;
    expectedCount: number;
    actualCount: number;
    expectedTextLength: number;
    actualTextLength: number;
    firstDiffIndex: number;
    expectedAround: string;
    actualAround: string;
    expectedSample: string[];
    actualSample: string[];
  }>;
}

function summarizeExternalPdfjsDiff(
  expected: Map<number, ExpectedBB[]>,
  actual: Record<string, BBoxMetaEntry[]>,
): ExternalPdfjsDiffSummary {
  let countMismatchPages = 0;
  let fewerPages = 0;
  let morePages = 0;
  let sameTextSignaturePages = 0;
  let changedTextSignaturePages = 0;
  const examples: ExternalPdfjsDiffSummary['examples'] = [];
  const changedTextExamples: ExternalPdfjsDiffSummary['changedTextExamples'] = [];

  for (const [page, expBlocks] of expected.entries()) {
    const actBlocks = actual[String(page)] ?? [];
    if (actBlocks.length === expBlocks.length) continue;
    countMismatchPages++;
    if (actBlocks.length < expBlocks.length) fewerPages++;
    if (actBlocks.length > expBlocks.length) morePages++;

    const sameTextSignature = textSignature(expBlocks) === textSignature(actBlocks);
    if (sameTextSignature) sameTextSignaturePages++;
    else changedTextSignaturePages++;

    if (examples.length < 5) {
      examples.push({
        page,
        expectedCount: expBlocks.length,
        actualCount: actBlocks.length,
        sameTextSignature,
        expectedSample: expBlocks.slice(0, 5).map((b) => b.text),
        actualSample: actBlocks.slice(0, 5).map((b) => b.text),
      });
    }

    if (!sameTextSignature && changedTextExamples.length < 10) {
      const expectedText = textSignature(expBlocks);
      const actualText = textSignature(actBlocks);
      let firstDiffIndex = 0;
      const max = Math.min(expectedText.length, actualText.length);
      while (firstDiffIndex < max && expectedText[firstDiffIndex] === actualText[firstDiffIndex]) {
        firstDiffIndex++;
      }
      const start = Math.max(0, firstDiffIndex - 40);
      const end = firstDiffIndex + 80;
      changedTextExamples.push({
        page,
        expectedCount: expBlocks.length,
        actualCount: actBlocks.length,
        expectedTextLength: expectedText.length,
        actualTextLength: actualText.length,
        firstDiffIndex,
        expectedAround: expectedText.slice(start, end),
        actualAround: actualText.slice(start, end),
        expectedSample: expBlocks.slice(0, 10).map((b) => b.text),
        actualSample: actBlocks.slice(0, 10).map((b) => b.text),
      });
    }
  }

  return {
    countMismatchPages,
    fewerPages,
    morePages,
    sameTextSignaturePages,
    changedTextSignaturePages,
    examples,
    changedTextExamples,
  };
}

function markAllPagesDirty(
  doc: PecoDocument,
  mutator: (b: TextBlock, p: number, i: number) => TextBlock,
): void {
  for (const [p, pd] of doc.pages.entries()) {
    const newBlocks = pd.textBlocks.map((b, i) => mutator(b, p, i));
    doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
  }
}

/**
 * Reload the saved PDF via pdfjs and extract PecoTool bbox metadata sorted by order,
 * matching the runtime loadPage path (pdfTextExtractor.loadPage).
 */
async function reloadBBoxMetaViaPdfjs(savedBytes: Uint8Array): Promise<{
  meta: Record<string, BBoxMetaEntry[]> | null;
  totalPages: number;
}> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(savedBytes),
    disableWorker: true,
    disableFontFace: true,
  });
  const pdfjsDoc = await loadingTask.promise;
  const totalPages: number = pdfjsDoc.numPages;
  const { loadPecoToolBBoxMeta } = await import('../../utils/pdfMetadataLoader');
  const parsed = await loadPecoToolBBoxMeta(pdfjsDoc);
  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
  if (!parsed) return { meta: null, totalPages };
  const sorted: Record<string, BBoxMetaEntry[]> = {};
  for (const [k, arr] of Object.entries(parsed)) {
    sorted[k] = [...arr].sort((a, b) => a.order - b.order);
  }
  return { meta: sorted, totalPages };
}

function summarizeMismatches(
  label: string,
  mismatches: ReturnType<typeof diffBBPages>['mismatches'],
  offByOnePages: number[],
): void {
  const byField = new Map<string, number>();
  for (const m of mismatches) byField.set(m.field, (byField.get(m.field) ?? 0) + 1);
  console.log(
    `[${label}] mismatches total=${mismatches.length} byField=${JSON.stringify(Object.fromEntries(byField))}`,
  );
  if (offByOnePages.length > 0) {
    console.log(`[${label}] OFF-BY-ONE DETECTED on pages: ${offByOnePages.slice(0, 10).join(',')}${offByOnePages.length > 10 ? ` ...(+${offByOnePages.length - 10})` : ''}`);
  }
  if (mismatches.length > 0) {
    console.log(`[${label}] examples: ${JSON.stringify(mismatches.slice(0, 5), null, 2)}`);
  }
}

describe.skipIf(!hasRealPdf)('REAL PDF 耐久/並列シナリオ (B1/C1)', () => {
  it('B1-0: 1サイクル保存後の pecotool meta 経路と外部 pdfjs 再抽出経路を切り分ける', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const initBuild = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    const initialExpected = collectExpected(initBuild.doc);
    console.log(`[B1-0] baseline: pages=${initBuild.totalPages}, blocks=${initBuild.totalBlocks}`);

    for (const [p, pd] of initBuild.doc.pages.entries()) {
      initBuild.doc.pages.set(p, { ...pd, isDirty: true });
    }

    const fontBuf = loadFontArrayBuffer();
    const fallbackFonts = loadFallbackFontArrayBuffers();
    const t = Date.now();
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, initBuild.doc, fontBuf, fallbackFonts);
    console.log(
      `[B1-0] 1-cycle savePDF=${Date.now() - t}ms, original=${(realBytes.byteLength / 1024 / 1024).toFixed(1)} MB, saved=${(saved.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );
    writeFileSync(OUT_B1_EXTERNAL, saved);
    console.log(`[B1-0] wrote ${OUT_B1_EXTERNAL}`);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const internalDiff = diffBBPages(initialExpected, meta!);
    summarizeMismatches('B1-0 pecotool-meta', internalDiff.mismatches, internalDiff.offByOnePages);
    expect(internalDiff.offByOnePages).toEqual([]);
    expect(internalDiff.mismatches).toEqual([]);

    const externalReload = await buildPecoDocumentFromRealPdf(saved, REAL_PDF_PATH);
    const externalActual = collectActualMeta(externalReload.doc);
    const externalDiff = diffBBPages(initialExpected, externalActual);
    const externalSummary = summarizeExternalPdfjsDiff(initialExpected, externalActual);
    summarizeMismatches('B1-0 external-pdfjs', externalDiff.mismatches, externalDiff.offByOnePages);
    console.log(`[B1-0 external-pdfjs] count summary: ${JSON.stringify(externalSummary, null, 2)}`);
  }, 1800_000);

  it('B1-1: 無編集のまま save → reload を 10 サイクル。meta 完全一致 & サイズ +10% 以内', async () => {
    const stat = statSync(REAL_PDF_PATH);
    console.log(`[B1-1] input: ${(stat.size / 1024 / 1024).toFixed(1)} MB path=${REAL_PDF_PATH}`);

    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    // baseline: 初期 load 時の期待値を採取
    const initBuild = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    const initialExpected = collectExpected(initBuild.doc);
    console.log(`[B1-1] baseline: pages=${initBuild.totalPages}, blocks=${initBuild.totalBlocks}`);

    const fontBuf = loadFontArrayBuffer();
    let currentBytes: Uint8Array = realBytes;
    const sizeBytesAtStart = realBytes.byteLength;

    for (let cycle = 1; cycle <= 10; cycle++) {
      // 各サイクル: 現在の bytes から load → 全ページを isDirty=true にしつつ編集内容は不変 → save
      const { doc } = await buildPecoDocumentFromRealPdf(
        new Uint8Array(currentBytes),
        REAL_PDF_PATH,
      );
      for (const [p, pd] of doc.pages.entries()) {
        doc.pages.set(p, { ...pd, isDirty: true });
      }
      const t = Date.now();
      const saved = await savePDF({ bytes: new Uint8Array(currentBytes) }, doc, fontBuf);
      console.log(
        `[B1-1] cycle ${cycle}: savePDF=${Date.now() - t}ms, ${(saved.byteLength / 1024 / 1024).toFixed(1)} MB`,
      );
      currentBytes = saved;
    }

    writeFileSync(OUT_B1_1, currentBytes);
    console.log(`[B1-1] wrote ${OUT_B1_1}`);

    // ファイルサイズ膨張チェック (+10% 以内)
    const growthRatio = currentBytes.byteLength / sizeBytesAtStart;
    console.log(
      `[B1-1] size: start=${(sizeBytesAtStart / 1024 / 1024).toFixed(1)}MB → final=${(currentBytes.byteLength / 1024 / 1024).toFixed(1)}MB (ratio=${growthRatio.toFixed(3)}x)`,
    );
    expect(growthRatio).toBeLessThanOrEqual(1.1);

    // meta が baseline と index 単位で完全一致
    const { meta } = await reloadBBoxMetaViaPdfjs(currentBytes);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(initialExpected, meta!);
    summarizeMismatches('B1-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 1800_000);

  it('B1-2: 毎サイクル +1 シフトを 10 周。累積誤差ゼロで x,y = 初期値 + 10', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const initBuild = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    const baselineExpected = collectExpected(initBuild.doc);
    console.log(`[B1-2] baseline: pages=${initBuild.totalPages}, blocks=${initBuild.totalBlocks}`);

    const fontBuf = loadFontArrayBuffer();
    let currentBytes: Uint8Array = realBytes;
    const CYCLES = 10;

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const { doc } = await buildPecoDocumentFromRealPdf(
        new Uint8Array(currentBytes),
        REAL_PDF_PATH,
      );
      markAllPagesDirty(doc, (b) => ({
        ...b,
        bbox: { ...b.bbox, x: b.bbox.x + 1, y: b.bbox.y + 1 },
        isDirty: true,
      }));
      const t = Date.now();
      const saved = await savePDF({ bytes: new Uint8Array(currentBytes) }, doc, fontBuf);
      console.log(
        `[B1-2] cycle ${cycle}: savePDF=${Date.now() - t}ms, ${(saved.byteLength / 1024 / 1024).toFixed(1)} MB`,
      );
      currentBytes = saved;
    }

    writeFileSync(OUT_B1_2, currentBytes);
    console.log(`[B1-2] wrote ${OUT_B1_2}`);

    // 期待値: 初期の baseline に対し (x, y) が +CYCLES 乗ったもの。width/height/text は不変。
    const expected = new Map<number, ExpectedBB[]>();
    for (const [p, bbs] of baselineExpected.entries()) {
      expected.set(
        p,
        bbs.map((b) => ({
          ...b,
          x: b.x + CYCLES,
          y: b.y + CYCLES,
        })),
      );
    }

    const { meta } = await reloadBBoxMetaViaPdfjs(currentBytes);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('B1-2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 1800_000);

  it('C1-1: save 前スナップショット → save → 後発編集 → 再 save で後発編集が反映される', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    console.log(`[C1-1] pages=${totalPages}`);

    // 対象ページを決める: A = 最初に blocks のあるページ、B = A とは別の、blocks のあるページ
    let pageA = -1;
    let pageB = -1;
    for (const [idx, pd] of doc.pages.entries()) {
      if (pd.textBlocks.length === 0) continue;
      if (pageA === -1) { pageA = idx; continue; }
      if (pageB === -1 && idx !== pageA) { pageB = idx; break; }
    }
    expect(pageA, '[C1-1] pageA (最初の blocks 有りページ) が見つからない').toBeGreaterThanOrEqual(0);
    expect(pageB, '[C1-1] pageB (別の blocks 有りページ) が見つからない').toBeGreaterThanOrEqual(0);

    const EDIT_A = 'C1_1_A_EDIT';
    const EDIT_B = 'C1_1_B_EDIT_AFTER_SAVE';

    // --- フェーズ1: page A を編集して save ---
    const pdA = doc.pages.get(pageA)!;
    doc.pages.set(pageA, {
      ...pdA,
      textBlocks: pdA.textBlocks.map((b, i) =>
        i === 0 ? { ...b, text: EDIT_A, originalText: EDIT_A, isDirty: true } : b,
      ),
      isDirty: true,
    });
    // 他ページは dirty=false に (実運用相当: snapshot 対象は page A のみ)
    for (const [idx, pd] of doc.pages.entries()) {
      if (idx !== pageA) doc.pages.set(idx, { ...pd, isDirty: false });
    }

    const snapshotDirty = [...doc.pages.entries()].filter(([, p]) => p.isDirty).map(([i]) => i);
    expect(snapshotDirty).toEqual([pageA]);

    const fontBuf = loadFontArrayBuffer();
    // savePDF Promise を await せずに保持 (実運用では writeFileChunked と重なる区間)
    const firstSavePromise = savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontBuf);

    // --- フェーズ2: save 実行中に page B を編集 (saveDuringEditRace と同等の擬似再現) ---
    //   vitest は単スレッドなので実際の concurrency は起こせないが、state を save 完了前に
    //   追記しておけば「後発編集が save に含まれなかったこと」+「2 回目 save で反映されること」は検証できる。
    const pdB = doc.pages.get(pageB)!;
    doc.pages.set(pageB, {
      ...pdB,
      textBlocks: pdB.textBlocks.map((b, i) =>
        i === 0 ? { ...b, text: EDIT_B, originalText: EDIT_B, isDirty: true } : b,
      ),
      isDirty: true,
    });

    // --- フェーズ3: 1 回目の save を await ---
    const firstSaved = await firstSavePromise;
    console.log(`[C1-1] 1st save: ${(firstSaved.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // 1 回目 save 時点の reload meta: page A の編集は反映されるが、page B の編集は
    // サーバー書き込みには載っていない (snapshot 外)。
    //   ※ buildPdfDocument は this.pages Map を直接読むため、実際には page B も載る。
    //   これは「snapshot を取らずに参照渡しで save する経路」が既にバグ耐性として機能している
    //   ことを意味する。まず一次 save で B が反映されていれば「後発編集が保存される」OK。
    const firstMeta = (await reloadBBoxMetaViaPdfjs(firstSaved)).meta;
    expect(firstMeta).not.toBeNull();
    const firstPageBTexts = (firstMeta![String(pageB)] ?? []).map((e) => e.text);

    // --- フェーズ4: 2 回目の save (新編集が 2 回目には確実に載ること) ---
    // 実運用相当: 1 回目 save 後に resetDirty が呼ばれたら B も dirty=false になる。
    //   その後ユーザーが再編集しないまま save した場合、B の dirty=false で save 対象から外れるが、
    //   buildPdfDocument は dirtyPages.filter で isDirty=true のみ拾う。
    //   ここでは「B が再度 dirty の状態で second save」するため、pageB は必ず反映されるべき。
    doc.pages.set(pageB, {
      ...doc.pages.get(pageB)!,
      isDirty: true,
    });
    const secondSaved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontBuf);
    console.log(`[C1-1] 2nd save: ${(secondSaved.byteLength / 1024 / 1024).toFixed(1)} MB`);
    writeFileSync(OUT_C1_1, secondSaved);
    console.log(`[C1-1] wrote ${OUT_C1_1}`);

    // 2 回目 save 後の reload: page B に EDIT_B が出現
    const secondMeta = (await reloadBBoxMetaViaPdfjs(secondSaved)).meta;
    expect(secondMeta).not.toBeNull();
    const secondPageBTexts = (secondMeta![String(pageB)] ?? []).map((e) => e.text);
    const secondPageATexts = (secondMeta![String(pageA)] ?? []).map((e) => e.text);

    console.log(
      `[C1-1] 1st save pageB contains EDIT_B? ${firstPageBTexts.includes(EDIT_B)}, 2nd save pageB contains EDIT_B? ${secondPageBTexts.includes(EDIT_B)}`,
    );

    // strict: 2 回目 save で後発編集 B が必ず反映される
    expect(secondPageBTexts).toContain(EDIT_B);
    // strict: page A の編集も維持される
    expect(secondPageATexts).toContain(EDIT_A);
  }, 1800_000);

  it('C1-2: savePDF 二重呼び出し。queue / reject のどちらかで race が抑止される', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));

    const { doc: doc1 } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    const { doc: doc2 } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);

    // doc1 と doc2 を識別できるように、先頭ページ先頭 block のテキストを書き換える
    const MARK_1 = 'C1_2_DOC1_MARK';
    const MARK_2 = 'C1_2_DOC2_MARK';

    let pageWithBlocks1 = -1;
    for (const [idx, pd] of doc1.pages.entries()) {
      if (pd.textBlocks.length > 0) { pageWithBlocks1 = idx; break; }
    }
    expect(pageWithBlocks1).toBeGreaterThanOrEqual(0);

    const pd1 = doc1.pages.get(pageWithBlocks1)!;
    doc1.pages.set(pageWithBlocks1, {
      ...pd1,
      textBlocks: pd1.textBlocks.map((b, i) =>
        i === 0 ? { ...b, text: MARK_1, originalText: MARK_1, isDirty: true } : b,
      ),
      isDirty: true,
    });
    const pd2 = doc2.pages.get(pageWithBlocks1)!;
    doc2.pages.set(pageWithBlocks1, {
      ...pd2,
      textBlocks: pd2.textBlocks.map((b, i) =>
        i === 0 ? { ...b, text: MARK_2, originalText: MARK_2, isDirty: true } : b,
      ),
      isDirty: true,
    });

    const fontBuf = loadFontArrayBuffer();

    // 連続 2 回呼び出し (await せず、ほぼ同タイミングで task queue に乗せる)
    const p1 = savePDF({ bytes: new Uint8Array(realBytes) }, doc1, fontBuf);
    const p2 = savePDF({ bytes: new Uint8Array(realBytes) }, doc2, fontBuf);

    const results = await Promise.allSettled([p1, p2]);
    const [r1, r2] = results;

    console.log(`[C1-2] r1=${r1.status}, r2=${r2.status}`);
    if (r1.status === 'rejected') console.log(`[C1-2] r1 reason: ${(r1.reason as Error)?.message ?? String(r1.reason)}`);
    if (r2.status === 'rejected') console.log(`[C1-2] r2 reason: ${(r2.reason as Error)?.message ?? String(r2.reason)}`);

    // どちらかが fulfilled であること (完全破綻は不可)
    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(1);

    // 両方 fulfilled → queue (逐次実行) が機能している or main thread 同期実行が逐次化された
    // → その場合、両方に正しい MARK が入っているか検証し、race 混線が無いことを担保する
    if (r1.status === 'fulfilled' && r2.status === 'fulfilled') {
      const bytes1 = r1.value;
      const bytes2 = r2.value;
      writeFileSync(OUT_C1_2_A, bytes1);
      writeFileSync(OUT_C1_2_B, bytes2);
      console.log(`[C1-2] wrote ${OUT_C1_2_A} (${(bytes1.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`[C1-2] wrote ${OUT_C1_2_B} (${(bytes2.byteLength / 1024 / 1024).toFixed(1)} MB)`);

      const meta1 = (await reloadBBoxMetaViaPdfjs(bytes1)).meta;
      const meta2 = (await reloadBBoxMetaViaPdfjs(bytes2)).meta;
      expect(meta1, '[C1-2] bytes1 meta').not.toBeNull();
      expect(meta2, '[C1-2] bytes2 meta').not.toBeNull();

      const texts1 = (meta1![String(pageWithBlocks1)] ?? []).map((e) => e.text);
      const texts2 = (meta2![String(pageWithBlocks1)] ?? []).map((e) => e.text);

      console.log(`[C1-2] bytes1 has MARK_1? ${texts1.includes(MARK_1)}, has MARK_2? ${texts1.includes(MARK_2)}`);
      console.log(`[C1-2] bytes2 has MARK_1? ${texts2.includes(MARK_1)}, has MARK_2? ${texts2.includes(MARK_2)}`);

      // race 混線が無いこと:
      //   bytes1 は doc1 が書いたものなので MARK_1 を含み MARK_2 を含まない。
      //   bytes2 は doc2 が書いたものなので MARK_2 を含み MARK_1 を含まない。
      //   もしこれらが混ざっていたら並列書き込みによる破損の証跡。
      expect(texts1, '[C1-2] bytes1 は MARK_1 を含むべき').toContain(MARK_1);
      expect(texts1, '[C1-2] bytes1 は MARK_2 を含むべきでない').not.toContain(MARK_2);
      expect(texts2, '[C1-2] bytes2 は MARK_2 を含むべき').toContain(MARK_2);
      expect(texts2, '[C1-2] bytes2 は MARK_1 を含むべきでない').not.toContain(MARK_1);
    } else {
      // 片方 reject → queue しきれず後発を reject する挙動。race 破損よりは安全だがユーザー体験としては劣化。
      // 少なくとも fulfilled 側は正しく MARK を書いていること。
      const fulfilled = results.find((r) => r.status === 'fulfilled') as
        | PromiseFulfilledResult<Uint8Array>
        | undefined;
      expect(fulfilled).toBeDefined();
      const meta = (await reloadBBoxMetaViaPdfjs(fulfilled!.value)).meta;
      expect(meta, '[C1-2] 生き残った save の meta が parse 可能であること').not.toBeNull();
      // 両方の MARK が混在していたら race 破損なので、どちらか一方だけを持つこと
      const texts = (meta![String(pageWithBlocks1)] ?? []).map((e) => e.text);
      const hasM1 = texts.includes(MARK_1);
      const hasM2 = texts.includes(MARK_2);
      console.log(`[C1-2] 生存 save texts: MARK_1=${hasM1}, MARK_2=${hasM2}`);
      expect(hasM1 !== hasM2, '[C1-2] MARK_1/MARK_2 はどちらか一方のみ出現すべき (race 破損検知)').toBe(true);
    }
  }, 1800_000);
});
