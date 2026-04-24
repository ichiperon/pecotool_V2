/**
 * 実 PDF を使った全 BB 負荷シナリオ。test/OCR_08_長期給付制度の概説_searchable.pdf が
 * ある時のみ実行される（findInputPdf で検出、派生ファイルは除外済）。
 *
 * シナリオ:
 *   T1: 全BB の位置のみ (+30, +30) 移動 → 別名保存 → 差分 + 再読込 meta 一致
 *   T2: 全BB のテキストを決定論的に書換 → 保存 → 差分 + 再読込 meta 一致
 *   T3: T1+T2 同時 → 保存 → 差分 + 再読込 meta 一致
 *   T4: 全BB を ratio=0.5 で垂直分割 (n → 2n) → 保存 → 再読込 meta 一致
 *   T5: T4 の結果を再度全分割 (2n → 4n) → 保存 → 再読込 meta 一致
 *   R1: 各シナリオの保存物に対し、ツール側ローダ相当 (pdfjs + loadPecoToolBBoxMeta)
 *       で order/text/bbox が index 単位で一致することを確認、off-by-one 検知
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfFullBBScenarios.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { PDFDocument } from '@cantoo/pdf-lib';

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
import { splitBlockAtRatio } from '../../utils/splitBlock';
import type { PecoDocument, TextBlock } from '../../types';
import {
  findInputPdf,
  outputPath,
  loadFontArrayBuffer,
  ensurePdfjsEnv,
  buildPecoDocumentFromRealPdf,
  diffPageContents,
  readBBoxMeta,
  type BBoxMetaEntry,
} from './helpers/realPdfFixtures';
import { diffBBPages, type ExpectedBB } from './helpers/bbDiff';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_T1 = outputPath(REAL_PDF_PATH, '_t1_move');
const OUT_T2 = outputPath(REAL_PDF_PATH, '_t2_edited');
const OUT_T3 = outputPath(REAL_PDF_PATH, '_t3_both');
const OUT_T4 = outputPath(REAL_PDF_PATH, '_t4_split_all_x1');
const OUT_T5 = outputPath(REAL_PDF_PATH, '_t5_split_all_x2');

const VISIBLE_SHIFT = { dx: 30, dy: 30 };
const TEXT_EDIT = (orig: string, pageIdx: number, blockIdx: number): string =>
  `${orig}#E${pageIdx}-${blockIdx}`;

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

function markAllPagesDirty(doc: PecoDocument, mutator: (b: TextBlock, p: number, i: number) => TextBlock): void {
  for (const [p, pd] of doc.pages.entries()) {
    const newBlocks = pd.textBlocks.map((b, i) => mutator(b, p, i));
    doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
  }
}

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

function blockCountMap(doc: PecoDocument): Map<number, number> {
  const m = new Map<number, number>();
  for (const [p, pd] of doc.pages.entries()) {
    m.set(p, pd.textBlocks.length);
  }
  return m;
}

async function saveAndWrite(
  realBytes: Uint8Array,
  doc: PecoDocument,
  fontBuf: ArrayBuffer,
  outputFile: string,
  label: string,
): Promise<Uint8Array> {
  const t = Date.now();
  const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontBuf);
  console.log(
    `[${label}] savePDF: ${Date.now() - t}ms, ${(saved.byteLength / 1024 / 1024).toFixed(1)} MB`,
  );
  writeFileSync(outputFile, saved);
  console.log(`[${label}] wrote ${outputFile}`);
  return saved;
}

/**
 * Reload via the tool's path-equivalent: pdfjs opens the saved PDF, then
 * loadPecoToolBBoxMeta extracts the JSON metadata and we sort entries by
 * `order` (same as pdfTextExtractor.loadPage does when meta is present).
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

describe.skipIf(!hasRealPdf)('REAL PDF 全BB 負荷シナリオ (T1-T5 + R1)', () => {
  it('T1: 全BB の位置を (+30, +30) 移動 → 保存 → byte 差分 & reload meta が期待一致', async () => {
    const stat = statSync(REAL_PDF_PATH);
    console.log(`[T1] input: ${(stat.size / 1024 / 1024).toFixed(1)} MB path=${REAL_PDF_PATH}`);
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[T1] pages=${totalPages}, blocks=${totalBlocks}`);

    markAllPagesDirty(doc, (b) => ({
      ...b,
      bbox: { ...b.bbox, x: b.bbox.x + VISIBLE_SHIFT.dx, y: b.bbox.y + VISIBLE_SHIFT.dy },
      isDirty: true,
    }));
    const expected = collectExpected(doc);
    const counts = blockCountMap(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_T1, 'T1');

    // byte 差分: ブロック有りページは全て差分あり
    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, counts);
    console.log(`[T1] unchanged-with-blocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    // reload meta が期待通り
    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('T1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('T2: 全BB のテキストを決定論的に書換 → 保存 → byte 差分 & reload meta が期待一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[T2] pages=${totalPages}, blocks=${totalBlocks}`);

    markAllPagesDirty(doc, (b, p, i) => {
      const newText = TEXT_EDIT(b.text, p, i);
      return {
        ...b,
        text: newText,
        originalText: newText,
        isDirty: true,
      };
    });
    const expected = collectExpected(doc);
    const counts = blockCountMap(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_T2, 'T2');

    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, counts);
    console.log(`[T2] unchanged-with-blocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('T2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('T3: 全BB を (+30, +30) 移動 & テキスト書換 → 保存 → byte 差分 & reload meta が期待一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[T3] pages=${totalPages}, blocks=${totalBlocks}`);

    markAllPagesDirty(doc, (b, p, i) => {
      const newText = TEXT_EDIT(b.text, p, i);
      return {
        ...b,
        text: newText,
        originalText: newText,
        bbox: { ...b.bbox, x: b.bbox.x + VISIBLE_SHIFT.dx, y: b.bbox.y + VISIBLE_SHIFT.dy },
        isDirty: true,
      };
    });
    const expected = collectExpected(doc);
    const counts = blockCountMap(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_T3, 'T3');

    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, counts);
    console.log(`[T3] unchanged-with-blocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('T3', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  /**
   * 全BB を ratio=0.5 で分割。
   * - text.length < 2 のブロックは分割不能なのでそのまま残す (splitBlockAtRatio が null を返す)。
   * - 分割後の textBlocks 配列は order 0..N-1 で再採番する。
   * - 期待BB数: sum_over_pages(sum_over_blocks(block.text.length < 2 ? 1 : 2)).
   */
  function applySplitOnce(doc: PecoDocument): { expectedByPage: Map<number, ExpectedBB[]>; newTotalBlocks: number } {
    const expectedByPage = new Map<number, ExpectedBB[]>();
    let newTotalBlocks = 0;
    for (const [p, pd] of doc.pages.entries()) {
      const newBlocks: TextBlock[] = [];
      for (const b of pd.textBlocks) {
        const res = splitBlockAtRatio(b, 0.5);
        if (!res) {
          newBlocks.push({ ...b, isDirty: true });
        } else {
          newBlocks.push(res.b1, res.b2);
        }
      }
      const reordered = newBlocks.map((b, idx) => ({ ...b, order: idx }));
      doc.pages.set(p, { ...pd, textBlocks: reordered, isDirty: true });
      newTotalBlocks += reordered.length;
      expectedByPage.set(
        p,
        reordered.map((b) => ({
          x: b.bbox.x, y: b.bbox.y, width: b.bbox.width, height: b.bbox.height,
          text: b.text, writingMode: b.writingMode,
        })),
      );
    }
    return { expectedByPage, newTotalBlocks };
  }

  it('T4: 全BB を ratio=0.5 で分割 1 回 (n → ~2n) → 保存 → reload meta が期待一致 (off-by-one 検知)', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[T4] orig pages=${totalPages}, blocks=${totalBlocks}`);

    const { expectedByPage, newTotalBlocks } = applySplitOnce(doc);
    console.log(`[T4] after split1: blocks=${newTotalBlocks} (ratio vs orig = ${(newTotalBlocks / totalBlocks).toFixed(2)}x)`);

    const counts = blockCountMap(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_T4, 'T4');

    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, counts);
    console.log(`[T4] unchanged-with-blocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expectedByPage, meta!);
    summarizeMismatches('T4', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 1200_000);

  it('T5: T4 の結果に対し再度 ratio=0.5 で分割 (2n → ~4n) → 保存 → reload meta が期待一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[T5] orig pages=${totalPages}, blocks=${totalBlocks}`);

    const pass1 = applySplitOnce(doc);
    console.log(`[T5] after split1: blocks=${pass1.newTotalBlocks}`);
    const pass2 = applySplitOnce(doc);
    console.log(`[T5] after split2: blocks=${pass2.newTotalBlocks} (${(pass2.newTotalBlocks / totalBlocks).toFixed(2)}x orig)`);

    const counts = blockCountMap(doc);
    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_T5, 'T5');

    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, counts);
    console.log(`[T5] unchanged-with-blocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(pass2.expectedByPage, meta!);
    summarizeMismatches('T5', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 1500_000);

  /**
   * R1: 全シナリオの保存物を改めて開き直し、pdfTextExtractor.loadPage と同等の
   * ロード経路（pdfjs + PecoToolBBoxes meta 読出）で order 通りに並べたブロックが、
   * ツール側で「何もズレず、何も落とさず」復元されることを確認する。
   *
   * これは以前の「分割後に再オープンすると OCR 位置が 1つずつ後ろにズレる」バグの
   * 再発検知を目的にする。
   */
  it('R1: T1-T5 の全保存物を再オープンして order/text/bbox 全一致 (off-by-one ゼロ)', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));

    // T1-T3 は baseline に mutation を適用した期待値でよい。
    // T4-T5 は split 後の期待値を再計算する必要がある (T4 の docと T5 の doc は別インスタンス)。
    const scenarios: Array<{
      label: string;
      file: string;
      buildExpected: () => Promise<Map<number, ExpectedBB[]>>;
    }> = [
      {
        label: 'R1/T1',
        file: OUT_T1,
        buildExpected: async () => {
          const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
          markAllPagesDirty(doc, (b) => ({
            ...b,
            bbox: { ...b.bbox, x: b.bbox.x + VISIBLE_SHIFT.dx, y: b.bbox.y + VISIBLE_SHIFT.dy },
            isDirty: true,
          }));
          return collectExpected(doc);
        },
      },
      {
        label: 'R1/T2',
        file: OUT_T2,
        buildExpected: async () => {
          const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
          markAllPagesDirty(doc, (b, p, i) => {
            const t = TEXT_EDIT(b.text, p, i);
            return { ...b, text: t, originalText: t, isDirty: true };
          });
          return collectExpected(doc);
        },
      },
      {
        label: 'R1/T3',
        file: OUT_T3,
        buildExpected: async () => {
          const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
          markAllPagesDirty(doc, (b, p, i) => {
            const t = TEXT_EDIT(b.text, p, i);
            return {
              ...b,
              text: t,
              originalText: t,
              bbox: { ...b.bbox, x: b.bbox.x + VISIBLE_SHIFT.dx, y: b.bbox.y + VISIBLE_SHIFT.dy },
              isDirty: true,
            };
          });
          return collectExpected(doc);
        },
      },
      {
        label: 'R1/T4',
        file: OUT_T4,
        buildExpected: async () => {
          const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
          return applySplitOnce(doc).expectedByPage;
        },
      },
      {
        label: 'R1/T5',
        file: OUT_T5,
        buildExpected: async () => {
          const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
          applySplitOnce(doc);
          return applySplitOnce(doc).expectedByPage;
        },
      },
    ];

    const aggregated: Array<{ label: string; mismatches: number; offByOne: number }> = [];
    for (const s of scenarios) {
      console.log(`[${s.label}] reading ${s.file}`);
      const savedBytes = new Uint8Array(readFileSync(s.file));
      const expected = await s.buildExpected();
      const { meta } = await reloadBBoxMetaViaPdfjs(savedBytes);
      expect(meta, `${s.label}: meta missing`).not.toBeNull();
      const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
      summarizeMismatches(s.label, mismatches, offByOnePages);
      aggregated.push({
        label: s.label,
        mismatches: mismatches.length,
        offByOne: offByOnePages.length,
      });
      expect(offByOnePages, `${s.label}: off-by-one detected`).toEqual([]);
      expect(mismatches.length, `${s.label}: BB mismatches`).toBe(0);
    }

    console.log(`[R1] summary: ${JSON.stringify(aggregated, null, 2)}`);
  }, 1500_000);
});

