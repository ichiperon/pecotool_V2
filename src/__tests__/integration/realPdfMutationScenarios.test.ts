/**
 * 実 PDF に対する BB 変形シナリオ (削除・リサイズ・追加) のラウンドトリップ検証。
 *
 * シナリオ:
 *   A1-1: 全ページ全BB削除
 *   A1-2: 奇数index間引き (残すのは偶数index)
 *   A1-3: 先頭/末尾BB 削除
 *   A1-4: 空text BB を各ページ 100 件追加
 *   A2-1: 偶数index 0.5x / 奇数index 2x の交互リサイズ
 *   A2-2: width=0 / height=0 の退化BB
 *   A2-3: ページ外はみ出し (負座標)
 *   A3-1: 各ページに新規10件 (isNew=true) 追加
 *   A3-2: 最初のページに 1000 件追加
 *   A3-3: 既存BB[0] と同座標で新規BB 追加
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfMutationScenarios.test.ts
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
import type { PecoDocument, TextBlock } from '../../types';
import {
  findInputPdf,
  outputPath,
  loadFontArrayBuffer,
  ensurePdfjsEnv,
  buildPecoDocumentFromRealPdf,
  diffPageContents,
  reloadBBoxMetaViaPdfjs,
} from './helpers/realPdfFixtures';
import { diffBBPages, type ExpectedBB } from './helpers/bbDiff';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_A1_1 = outputPath(REAL_PDF_PATH, '_a1_1_deleteAll');
const OUT_A1_2 = outputPath(REAL_PDF_PATH, '_a1_2_halfRemove');
const OUT_A1_3 = outputPath(REAL_PDF_PATH, '_a1_3_firstLastRemove');
const OUT_A1_4 = outputPath(REAL_PDF_PATH, '_a1_4_emptyBBAdd');
const OUT_A2_1 = outputPath(REAL_PDF_PATH, '_a2_1_altResize');
const OUT_A2_2 = outputPath(REAL_PDF_PATH, '_a2_2_degenerate');
const OUT_A2_3 = outputPath(REAL_PDF_PATH, '_a2_3_offpage');
const OUT_A3_1 = outputPath(REAL_PDF_PATH, '_a3_1_add10');
const OUT_A3_2 = outputPath(REAL_PDF_PATH, '_a3_2_add1000');
const OUT_A3_3 = outputPath(REAL_PDF_PATH, '_a3_3_dupCoord');

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

function makeNewBlock(
  pageIdx: number,
  order: number,
  bbox: { x: number; y: number; width: number; height: number },
  text: string,
): TextBlock {
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? `new-p${pageIdx}-o${order}-${Math.random().toString(16).slice(2)}`) as string,
    text,
    originalText: text,
    bbox,
    writingMode: 'horizontal',
    order,
    isNew: true,
    isDirty: true,
  };
}

describe.skipIf(!hasRealPdf)('REAL PDF BB 変形シナリオ (A1 削除 / A2 リサイズ / A3 追加)', () => {
  it('A1-1: 全ページ全BB削除 → 保存 → reload で meta 全ページ空', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A1-1] orig pages=${totalPages}, blocks=${totalBlocks}`);

    // 削除前の元ページ content のコピーを持っておく (byte 差分比較のため)
    const origBlockCounts = blockCountMap(doc);

    for (const [p, pd] of doc.pages.entries()) {
      doc.pages.set(p, { ...pd, textBlocks: [], isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A1_1, 'A1-1');

    // byte 差分: 元々ブロックが有ったページは「削除後」は必ず変化する想定
    // (Tj op が激減するので unchangedPagesWithBlocks が 0 であることを要求するのは
    //  「元doc側で block を持っていたページに対する saved 側の content が一致しないこと」と等価)
    const origDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const { unchangedPagesWithBlocks } = diffPageContents(origDoc, savedDoc, origBlockCounts);
    console.log(`[A1-1] unchanged-with-origBlocks pages: ${unchangedPagesWithBlocks.length}`);
    expect(unchangedPagesWithBlocks).toEqual([]);

    // reload meta: 各ページで空配列 (meta 自体は存在し、各ページが []
    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();
    // 全ページについて meta[p]=[] or undefined のどちらでも expected は空なので
    // diffBBPages で count mismatch にならない。念のため明示検証:
    for (let p = 0; p < totalPages; p++) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: expected 0 blocks after full delete, got ${arr.length}`).toBe(0);
    }
    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A1-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A1-2: 各ページ奇数index間引き (残すのは偶数index) → 保存 → reload で order 再採番 & text 一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A1-2] orig pages=${totalPages}, blocks=${totalBlocks}`);

    // 削減前 index=偶数 の text を期待値として保持 (後の一致検証)
    const evenIndexTexts = new Map<number, string[]>();
    for (const [p, pd] of doc.pages.entries()) {
      evenIndexTexts.set(p, pd.textBlocks.filter((_, i) => i % 2 === 0).map((b) => b.text));
    }

    for (const [p, pd] of doc.pages.entries()) {
      const kept = pd.textBlocks.filter((_, i) => i % 2 === 0);
      // order を 0..N-1 に再採番
      const reordered = kept.map((b, idx) => ({ ...b, order: idx, isDirty: true }));
      doc.pages.set(p, { ...pd, textBlocks: reordered, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A1_2, 'A1-2');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    // 各ページで BB 数が ceil(orig/2) と一致
    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: halved count`).toBe(pd.textBlocks.length);
      // order は 0..N-1
      for (let i = 0; i < arr.length; i++) {
        expect(arr[i].order, `page ${p} idx ${i}: order re-numbered`).toBe(i);
      }
      // 残った text が元の偶数indexと同じ
      const origEven = evenIndexTexts.get(p) ?? [];
      for (let i = 0; i < arr.length; i++) {
        expect(arr[i].text, `page ${p} idx ${i}: even-index text preserved`).toBe(origEven[i]);
      }
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A1-2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A1-3: 各ページの先頭/末尾BBを削除 → 保存 → reload で中間BB は完全保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A1-3] orig pages=${totalPages}, blocks=${totalBlocks}`);

    // 中間BB群 (先頭末尾除く) の text を期待値として保持
    const middleTexts = new Map<number, string[]>();
    const origLens = new Map<number, number>();
    for (const [p, pd] of doc.pages.entries()) {
      origLens.set(p, pd.textBlocks.length);
      const len = pd.textBlocks.length;
      if (len <= 1) {
        middleTexts.set(p, []);
      } else if (len === 2) {
        middleTexts.set(p, []);
      } else {
        middleTexts.set(p, pd.textBlocks.slice(1, -1).map((b) => b.text));
      }
    }

    for (const [p, pd] of doc.pages.entries()) {
      const len = pd.textBlocks.length;
      let kept: TextBlock[];
      if (len <= 1) {
        kept = [];
      } else if (len === 2) {
        kept = [];
      } else {
        kept = pd.textBlocks.slice(1, -1);
      }
      const reordered = kept.map((b, idx) => ({ ...b, order: idx, isDirty: true }));
      doc.pages.set(p, { ...pd, textBlocks: reordered, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A1_3, 'A1-3');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      const origLen = origLens.get(p) ?? 0;
      // 期待BB数
      let expectedCount: number;
      if (origLen <= 1) expectedCount = 0;
      else if (origLen === 2) expectedCount = 0;
      else expectedCount = origLen - 2;
      expect(arr.length, `page ${p}: count after first/last removal (orig=${origLen})`).toBe(expectedCount);
      // 中間 text が元の中間と同順
      const origMid = middleTexts.get(p) ?? [];
      for (let i = 0; i < arr.length; i++) {
        expect(arr[i].text, `page ${p} idx ${i}: middle text preserved`).toBe(origMid[i]);
      }
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A1-3', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A1-4: 各ページに text="" の空BB を 100件追加 → 保存 → reload で空BB保持 (drawText スキップでもズレなし)', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A1-4] orig pages=${totalPages}, blocks=${totalBlocks}`);

    const EMPTY_PER_PAGE = 100;
    for (const [p, pd] of doc.pages.entries()) {
      const newBlocks: TextBlock[] = [...pd.textBlocks];
      const baseOrder = newBlocks.length;
      for (let k = 0; k < EMPTY_PER_PAGE; k++) {
        newBlocks.push(
          makeNewBlock(p, baseOrder + k, { x: 10 + k, y: 10 + k, width: 20, height: 12 }, ''),
        );
      }
      doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A1_4, 'A1-4');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: orig + ${EMPTY_PER_PAGE} empty`).toBe(pd.textBlocks.length);
      // 末尾の 100 件が text="" で保持されていること
      const tail = arr.slice(-EMPTY_PER_PAGE);
      for (let i = 0; i < tail.length; i++) {
        expect(tail[i].text, `page ${p} tail idx ${i}: empty text preserved`).toBe('');
      }
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A1-4', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A2-1: 偶数index 0.5x / 奇数index 2x の交互リサイズ → 保存 → reload で寸法一致', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A2-1] orig pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const resized = pd.textBlocks.map((b, i) => {
        const scale = i % 2 === 0 ? 0.5 : 2;
        return {
          ...b,
          bbox: { ...b.bbox, width: b.bbox.width * scale, height: b.bbox.height * scale },
          isDirty: true,
        };
      });
      doc.pages.set(p, { ...pd, textBlocks: resized, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A2_1, 'A2-1');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A2-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A2-2: 退化BB (width=0 / height=0) → 保存 throw せず reload で meta に保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A2-2] orig pages=${totalPages}, blocks=${totalBlocks}`);

    // 各ページで 1つ目 BB を width=0 に、2つ目 BB を height=0 に
    for (const [p, pd] of doc.pages.entries()) {
      const newBlocks = pd.textBlocks.map((b, i) => {
        if (i === 0) return { ...b, bbox: { ...b.bbox, width: 0 }, isDirty: true };
        if (i === 1) return { ...b, bbox: { ...b.bbox, height: 0 }, isDirty: true };
        return b;
      });
      doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    // 保存が throw しないこと
    let saved: Uint8Array | null = null;
    await expect(
      (async () => {
        saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A2_2, 'A2-2');
      })(),
    ).resolves.not.toThrow();
    expect(saved).not.toBeNull();

    const { meta } = await reloadBBoxMetaViaPdfjs(saved!);
    expect(meta).not.toBeNull();

    // reload 後の BB 数が元と同じ(退化BBも drop されていない)
    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: degenerate BBs preserved (not dropped)`).toBe(pd.textBlocks.length);
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A2-2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A2-3: ページ外はみ出し (負座標) → 保存成功 & reload で座標クリップされない', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A2-3] orig pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      const newBlocks = pd.textBlocks.map((b, i) => {
        if (i === 0) return { ...b, bbox: { ...b.bbox, x: -100, y: -100 }, isDirty: true };
        return b;
      });
      doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A2_3, 'A2-3');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    // 各ページで先頭BBが負座標そのまま保持されていること
    for (const [p, pd] of doc.pages.entries()) {
      if (pd.textBlocks.length === 0) continue;
      const arr = meta![String(p)] ?? [];
      expect(arr.length).toBeGreaterThan(0);
      expect(arr[0].bbox.x, `page ${p}: first BB x preserved as -100 (not clipped)`).toBe(-100);
      expect(arr[0].bbox.y, `page ${p}: first BB y preserved as -100 (not clipped)`).toBe(-100);
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A2-3', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A3-1: 各ページに新規 10件 (isNew=true) 追加 → 保存 → reload で追加BB保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A3-1] orig pages=${totalPages}, blocks=${totalBlocks}`);

    const ADD_PER_PAGE = 10;
    for (const [p, pd] of doc.pages.entries()) {
      const newBlocks: TextBlock[] = [...pd.textBlocks];
      const baseOrder = newBlocks.length;
      for (let k = 0; k < ADD_PER_PAGE; k++) {
        newBlocks.push(
          makeNewBlock(
            p,
            baseOrder + k,
            { x: 50 + k * 5, y: 50 + k * 5, width: 40, height: 12 },
            `new-p${p}-k${k}`,
          ),
        );
      }
      doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A3_1, 'A3-1');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    let totalAdded = 0;
    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: orig + ${ADD_PER_PAGE} new`).toBe(pd.textBlocks.length);
      // 末尾の ADD_PER_PAGE 件が new-p{p}-k* で保持されていること
      const tail = arr.slice(-ADD_PER_PAGE);
      for (let k = 0; k < tail.length; k++) {
        expect(tail[k].text, `page ${p} new k${k}`).toBe(`new-p${p}-k${k}`);
      }
      totalAdded += ADD_PER_PAGE;
    }
    expect(totalAdded).toBe(totalPages * ADD_PER_PAGE);

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A3-1', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A3-2: 最初のページに 1000件追加 → save 成功 & reload で 1000件すべて復元', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A3-2] orig pages=${totalPages}, blocks=${totalBlocks}`);

    const ADD_COUNT = 1000;
    const firstPage = doc.pages.get(0);
    expect(firstPage, 'first page must exist').toBeTruthy();
    if (!firstPage) return;
    const baseOrder = firstPage.textBlocks.length;
    const newBlocks: TextBlock[] = [...firstPage.textBlocks];
    for (let k = 0; k < ADD_COUNT; k++) {
      // grid 状に配置: 50 列 x 20 行
      const col = k % 50;
      const row = Math.floor(k / 50);
      newBlocks.push(
        makeNewBlock(
          0,
          baseOrder + k,
          { x: 10 + col * 10, y: 10 + row * 15, width: 8, height: 10 },
          `bulk-k${k}`,
        ),
      );
    }
    doc.pages.set(0, { ...firstPage, textBlocks: newBlocks, isDirty: true });
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A3_2, 'A3-2');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    const page0Arr = meta!['0'] ?? [];
    expect(page0Arr.length, 'first page: orig + 1000').toBe(baseOrder + ADD_COUNT);
    // 末尾 1000 件が bulk-k0..bulk-k999 の順で保持されていること
    const tail = page0Arr.slice(-ADD_COUNT);
    for (let k = 0; k < tail.length; k++) {
      expect(tail[k].text, `bulk k${k}`).toBe(`bulk-k${k}`);
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A3-2', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it('A3-3: 既存BB[0] と同座標で新規BB 追加 → 重複で壊れず reload で両方保持', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      realBytes, REAL_PDF_PATH,
    );
    console.log(`[A3-3] orig pages=${totalPages}, blocks=${totalBlocks}`);

    for (const [p, pd] of doc.pages.entries()) {
      if (pd.textBlocks.length === 0) continue;
      const first = pd.textBlocks[0];
      const baseOrder = pd.textBlocks.length;
      const dup = makeNewBlock(
        p,
        baseOrder,
        { x: first.bbox.x, y: first.bbox.y, width: first.bbox.width, height: first.bbox.height },
        `dup-p${p}`,
      );
      const newBlocks = [...pd.textBlocks, dup];
      doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
    }
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await saveAndWrite(realBytes, doc, fontBuf, OUT_A3_3, 'A3-3');

    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta).not.toBeNull();

    for (const [p, pd] of doc.pages.entries()) {
      const arr = meta![String(p)] ?? [];
      expect(arr.length, `page ${p}: orig + 1 duplicate-coord`).toBe(pd.textBlocks.length);
      if (pd.textBlocks.length >= 2) {
        // 両方 (元BB[0] と 末尾の dup) が bbox 一致で共存していること
        const first = arr[0];
        const last = arr[arr.length - 1];
        expect(last.text, `page ${p}: dup text`).toBe(`dup-p${p}`);
        expect(Math.abs(last.bbox.x - first.bbox.x)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(last.bbox.y - first.bbox.y)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(last.bbox.width - first.bbox.width)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(last.bbox.height - first.bbox.height)).toBeLessThanOrEqual(1e-6);
      }
    }

    const { mismatches, offByOnePages } = diffBBPages(expected, meta!);
    summarizeMismatches('A3-3', mismatches, offByOnePages);
    expect(offByOnePages).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 900_000);
});
