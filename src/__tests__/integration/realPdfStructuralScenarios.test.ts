/**
 * 実 PDF を使った構造系 (order / writingMode / text エッジ) 負荷シナリオ。
 * test/ 直下に input となる PDF がある時のみ実行される。
 *
 * シナリオ:
 *   A4-1: 各ページの textBlocks.reverse() + order 再採番 → 保存 → reload で逆順が保持される
 *   A4-2: order に欠番/重複/飛び値を設定 → 保存 → reload で「strict に期待通り」か観察
 *         (壊れた order がどう復元されるかを index-by-index で検知)
 *   A5-1: 全BB を writingMode='vertical' に統一 (bbox は width↔height swap) → 保存 → reload で保持
 *   A5-2: 各ページ偶数index vertical / 奇数index horizontal 混在 → 保存 → reload で各BB一致
 *   A6-1: 全BB の text/originalText を "" に設定 → 保存が throw しない / reload で "" 保持 / 順序保持
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfStructuralScenarios.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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
import type { PecoDocument, TextBlock, WritingMode } from '../../types';
import {
  findInputPdf,
  outputPath,
  loadFontArrayBuffer,
  ensurePdfjsEnv,
  buildPecoDocumentFromRealPdf,
  type BBoxMetaEntry,
} from './helpers/realPdfFixtures';
import { diffBBPages, type ExpectedBB } from './helpers/bbDiff';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_A4_1 = outputPath(REAL_PDF_PATH, '_a4_1_reverse');
const OUT_A4_2 = outputPath(REAL_PDF_PATH, '_a4_2_orderBroken');
const OUT_A5_1 = outputPath(REAL_PDF_PATH, '_a5_1_vertical');
const OUT_A5_2 = outputPath(REAL_PDF_PATH, '_a5_2_mixed');
const OUT_A6_1 = outputPath(REAL_PDF_PATH, '_a6_1_emptyAll');

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

/**
 * ツール本体のロード経路相当: pdfjs で開いて loadPecoToolBBoxMeta を取り、
 * order でソートして返す。これは pdfTextExtractor.loadPage() の並びを再現する。
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
    console.log(
      `[${label}] OFF-BY-ONE DETECTED on pages: ${offByOnePages.slice(0, 10).join(',')}${offByOnePages.length > 10 ? ` ...(+${offByOnePages.length - 10})` : ''}`,
    );
  }
  if (mismatches.length > 0) {
    console.log(`[${label}] examples: ${JSON.stringify(mismatches.slice(0, 5), null, 2)}`);
  }
}

/**
 * 縦書きに切替える際の bbox 変形: width と height を swap する。
 * 元が横長なら縦長に、正方形ならそのまま維持される。
 */
function swapBBoxDims<T extends { bbox: TextBlock['bbox'] }>(b: T): T {
  return {
    ...b,
    bbox: {
      x: b.bbox.x,
      y: b.bbox.y,
      width: b.bbox.height,
      height: b.bbox.width,
    },
  };
}

describe.skipIf(!hasRealPdf)('REAL PDF 構造系シナリオ (A4/A5/A6)', () => {
  it('A4-1: 各ページ textBlocks を reverse + order 再採番 → 保存 → reload で逆順保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A4-1] pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const reversed = [...pd.textBlocks].reverse().map((b, idx) => ({
        ...b,
        order: idx,
        isDirty: true,
      }));
      doc.pages.set(p, { ...pd, textBlocks: reversed, isDirty: true });
    }

    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A4_1, 'A4-1');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A4-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A4-2: order に欠番 / 重複 / 飛び値 → 保存 → reload で期待順序が保たれる', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A4-2] pages=${totalPages}, blocks=${totalBlocks}`);

    /**
     * order を壊す:
     *   - index 0,1,2: order=0 重複
     *   - index 3..7: order=100,200,300,400,500 (飛び値、本来なら先頭に並ぶ値ではない)
     *   - index 8..  : order=i (そのまま連番)
     *
     * ツール側が order-sort を行うと、重複 0 群と連番 8.. は並び替わる可能性がある。
     * ただし「安定ソート」であれば、元の textBlocks 配列での挿入順は保たれるはず。
     * 期待: reload 後 order-sort した配列が、元の textBlocks 配列と index 単位で完全一致する
     *       (重複 order の中では挿入順が保たれる = 安定ソート)。
     *
     * 具体的に「期待される最終順序」は以下:
     *   order 値の昇順安定ソート:
     *     [0(idx0), 0(idx1), 0(idx2),
     *      8,9,10,...,N-1 (idx 8..N-1 連番),
     *      100(idx3), 200(idx4), 300(idx5), 400(idx6), 500(idx7)]
     */
    for (const [p, pd] of doc.pages.entries()) {
      const n = pd.textBlocks.length;
      const reassigned: TextBlock[] = pd.textBlocks.map((b, i) => {
        let newOrder: number;
        if (i < 3) newOrder = 0;
        else if (i < 8) newOrder = (i - 2) * 100; // i=3→100, i=4→200, ... i=7→500
        else newOrder = i;
        return { ...b, order: newOrder, isDirty: true };
      });
      doc.pages.set(p, { ...pd, textBlocks: reassigned, isDirty: true });

      // 安定ソート (Array.prototype.sort は V8/Node で stable) で期待順序を構築
      const expectedOrdered = [...reassigned]
        .map((b, origIdx) => ({ b, origIdx }))
        .sort((a, z) => {
          if (a.b.order !== z.b.order) return a.b.order - z.b.order;
          return a.origIdx - z.origIdx;
        })
        .map(({ b }) => b);
      // 後で比較するために doc の textBlocks を expectedOrdered に「再並べ替え」するのではなく、
      // 期待値 Map を直接作る方針。保存側には「壊れた order の配列」を渡し、reload 側は
      // order-sort 後の並びを返してくると想定する。
      void n;
    }

    // expected は「order-sort 安定版」で作る
    const expected = new Map<number, ExpectedBB[]>();
    for (const [p, pd] of doc.pages.entries()) {
      const ordered = [...pd.textBlocks]
        .map((b, origIdx) => ({ b, origIdx }))
        .sort((a, z) => {
          if (a.b.order !== z.b.order) return a.b.order - z.b.order;
          return a.origIdx - z.origIdx;
        })
        .map(({ b }) => ({
          x: b.bbox.x,
          y: b.bbox.y,
          width: b.bbox.width,
          height: b.bbox.height,
          text: b.text,
          writingMode: b.writingMode,
        }));
      expected.set(p, ordered);
    }

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A4_2, 'A4-2');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A4-2', mismatches, offByOnePages);
    // strict: 壊れた order でも order-sort 安定ソートで期待通り復元されるはず。
    // もしここで落ちれば「保存/ロードで order 壊れる」= バグとして検知される。
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A5-1: 全BB を writingMode=vertical に一括変換 (bbox width↔height swap) → reload で保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A5-1] pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const converted = pd.textBlocks.map((b) => {
        const swapped = swapBBoxDims(b);
        return {
          ...swapped,
          writingMode: 'vertical' as WritingMode,
          isDirty: true,
        };
      });
      doc.pages.set(p, { ...pd, textBlocks: converted, isDirty: true });
    }

    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A5_1, 'A5-1');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A5-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);

    // すべての BB が vertical で復元されていることを別経路でも確認
    for (const [, arr] of Object.entries(meta!)) {
      for (const entry of arr) {
        expect(entry.writingMode).toBe('vertical');
      }
    }
  }, 900_000);

  it('A5-2: 偶数index vertical / 奇数index horizontal 混在 → reload で各BB 一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A5-2] pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const mixed = pd.textBlocks.map((b, i) => {
        if (i % 2 === 0) {
          const swapped = swapBBoxDims(b);
          return {
            ...swapped,
            writingMode: 'vertical' as WritingMode,
            isDirty: true,
          };
        }
        return {
          ...b,
          writingMode: 'horizontal' as WritingMode,
          isDirty: true,
        };
      });
      doc.pages.set(p, { ...pd, textBlocks: mixed, isDirty: true });
    }

    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A5_2, 'A5-2');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A5-2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);

    // 各ページで偶数index vertical / 奇数index horizontal が保たれていることを別途確認
    for (const [pageKey, arr] of Object.entries(meta!)) {
      for (let i = 0; i < arr.length; i++) {
        const expectedMode = i % 2 === 0 ? 'vertical' : 'horizontal';
        expect(
          arr[i].writingMode,
          `page=${pageKey} idx=${i} expected writingMode=${expectedMode}`,
        ).toBe(expectedMode);
      }
    }
  }, 900_000);

  it('A6-1: 全BB の text / originalText を "" にする → 保存成功 / reload で "" 保持 / 順序保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A6-1] pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const blanked = pd.textBlocks.map((b) => ({
        ...b,
        text: '',
        originalText: '',
        isDirty: true,
      }));
      doc.pages.set(p, { ...pd, textBlocks: blanked, isDirty: true });
    }

    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    // throw しないことを確認 (明示的に try/catch せず、throw 時は it が失敗する)
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A6_1, 'A6-1');

    // pdf-lib でも開ける (壊れた PDF を出力していない)
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(savedDoc.getPages().length).toBe(totalPages);

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    // 全 BB が "" で復元され、bbox/順序は変わっていない
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A6-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);

    // 念のため全 text が "" であることを直接検証
    let nonEmptyCount = 0;
    for (const [, arr] of Object.entries(meta!)) {
      for (const entry of arr) {
        if (entry.text !== '') nonEmptyCount++;
      }
    }
    expect(nonEmptyCount).toBe(0);
  }, 900_000);
});
