/**
 * LRU 退避境界を跨ぐ大規模保存の不変則テスト
 *
 * 検証観点:
 *   - 51 ページ（MAX_CACHED_PAGES+1: 境界直上）と 120 ページ（大幅超）の 2 水準
 *   - 全ページを updatePageData で dirty 化し LRU 退避を確実に発火させる
 *   - 保存再集約経路（waitForPendingIdbSaves → getAllTemporaryPageData → merge → dirtyOnly → savePDF）を再現
 *   - 保存後 PDF を reloadBBoxMetaViaPdfjs で再ロードし、1 件も欠落しないことを検証
 *   - メモリ在ページ・IDB 退避ページ両方がマーカー検証対象に含まれる
 *   - 2 サイクル耐久（保存→再ロード→再保存でマーカー総数・ブロック数が不変）
 *
 * CI 実行時間目標: 3 分以内（単体）
 * テストデータ: 合成のみ（実 PDF 不使用・コミット禁止 PDF ゼロ）
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ── in-memory IDB mock（lruIdbRoundtrip.test.ts と同じ方式）────────────────
const fakeIdb = new Map<string, unknown>();

vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(async (filePath: string, pageId: string, data: unknown) => {
    const key = `${filePath}:${pageId}`;
    const { thumbnail: _t, ...clean } = data as Record<string, unknown>;
    fakeIdb.set(key, clean);
  }),
  saveTemporaryPageDataBatch: vi.fn(
    async (entries: Array<{ filePath: string; pageId: string; data: unknown }>) => {
      for (const { filePath, pageId, data } of entries) {
        const key = `${filePath}:${pageId}`;
        const { thumbnail: _t, ...clean } = data as Record<string, unknown>;
        fakeIdb.set(key, clean);
      }
    },
  ),
  getTemporaryPageData: vi.fn(async (filePath: string, pageId: string) => {
    return fakeIdb.get(`${filePath}:${pageId}`) ?? null;
  }),
  getAllTemporaryPageData: vi.fn(async (filePath: string) => {
    const result = new Map<string, unknown>();
    const prefix = `${filePath}:`;
    for (const [key, value] of fakeIdb.entries()) {
      if (key.startsWith(prefix)) {
        result.set(key.slice(prefix.length), value);
      }
    }
    return result;
  }),
  clearTemporaryChanges: vi.fn(async (filePath: string) => {
    const prefix = `${filePath}:`;
    for (const key of Array.from(fakeIdb.keys())) {
      if (key.startsWith(prefix)) fakeIdb.delete(key);
    }
  }),
  clearTemporaryChangesForPages: vi.fn(async (filePath: string, pageIds: string[]) => {
    for (const pageId of pageIds) fakeIdb.delete(`${filePath}:${pageId}`);
  }),
  remapTemporaryPageEntries: vi.fn(async () => {}),
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import { usePecoStore, waitForPendingIdbSaves, MAX_CACHED_PAGES } from '../../store/pecoStore';
import { parsePageId } from '../../utils/pageOrder';
import type { PecoDocument, PageData, TextBlock } from '../../types';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
  buildLargeScale,
} from './helpers/goldenCorpus';
import { reloadBBoxMetaViaPdfjs } from './helpers/realPdfFixtures';

// ── 環境セットアップ ──────────────────────────────────────────────────────────

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 30_000);

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
  fakeIdb.clear();
  resetDeterministicCounter();
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
  } as Parameters<typeof usePecoStore.setState>[0]);
});

// ── 共通テストロジック ────────────────────────────────────────────────────────

/**
 * 指定ページ数で大規模 LRU 保存テストを実行する。
 *
 * 手順:
 *   1. buildLargeScale(pageCount) で合成コーパスを生成
 *   2. usePecoStore.setDocument でストアに載せる
 *   3. 全ページを updatePageData で dirty 化（LRU 退避を発火させる）
 *   4. waitForPendingIdbSaves → getAllTemporaryPageData → merge → dirtyOnly
 *   5. savePDF → reloadBBoxMetaViaPdfjs で再ロード
 *   6. マーカー全件一致アサート
 */
async function runLargeScaleTest(pageCount: number): Promise<void> {
  // コーパス生成
  const corpus = await buildLargeScale(pageCount);

  // ストアに初期ドキュメントをロード
  const initialDoc: PecoDocument = {
    ...corpus.doc,
    // setDocument は既存 pages を保持するが、テストでは手動で updatePageData を呼ぶ
    // ためまず textBlocks 空の PageData で初期化する
    pages: new Map(
      Array.from({ length: pageCount }, (_, i) => [
        i,
        {
          pageIndex: i,
          width: 595,
          height: 842,
          textBlocks: [],
          isDirty: false,
          thumbnail: null,
          isTextExtracted: true,
        } satisfies PageData,
      ]),
    ),
    totalPages: pageCount,
  };

  usePecoStore.getState().setDocument(initialDoc);

  // 全ページを順に updatePageData で dirty 化（LRU 退避を発火させる）
  // 各ページに一意マーカーを 3 ブロック埋め込む
  const store = usePecoStore.getState();
  const BLOCKS_PER_PAGE = 3;

  for (let pi = 0; pi < pageCount; pi++) {
    const blocks: TextBlock[] = Array.from({ length: BLOCKS_PER_PAGE }, (_, bi) => ({
      id: `p${pi}-b${bi}`,
      text: `L-${pi}-${bi}`,
      originalText: `L-${pi}-${bi}`,
      bbox: { x: 50, y: 50 + bi * 30, width: 200, height: 20 },
      writingMode: 'horizontal' as const,
      order: bi,
      isNew: false,
      isDirty: true,
    }));
    store.updatePageData(pi, { textBlocks: blocks, isDirty: true }, false);
  }

  // ── アサート 1: メモリ在ページ数が MAX_CACHED_PAGES 以下 ──────────────────
  const afterEditState = usePecoStore.getState();
  const memoryPageCount = afterEditState.document!.pages.size;
  expect(memoryPageCount, 'memory pages must not exceed MAX_CACHED_PAGES').toBeLessThanOrEqual(
    MAX_CACHED_PAGES,
  );

  // ── アサート 2: IDB 退避件数が (totalPages - memoryPageCount) 以上 ──────
  // MAX_CACHED_PAGES を超えた分は全て IDB に退避されているはず
  const expectedEvicted = pageCount - MAX_CACHED_PAGES;
  expect(fakeIdb.size, `IDB eviction count must be >= ${expectedEvicted}`).toBeGreaterThanOrEqual(
    expectedEvicted,
  );

  // ── 保存再集約経路を再現（useFileOperations._executeSave のコアと等価）──
  await waitForPendingIdbSaves();

  const { getAllTemporaryPageData } = await import('../../utils/pdfTemporaryStorage');
  const filePath = initialDoc.filePath;
  const tempPages = await getAllTemporaryPageData(filePath);

  // メモリ優先 merge（IDB エントリはメモリ在ページを上書きしない）
  const merged = new Map<number, PageData>(afterEditState.document!.pages);
  for (const [pageId, data] of tempPages.entries()) {
    const pageIndex = parsePageId(pageId);
    if (pageIndex === null) continue;
    if (!merged.has(pageIndex)) {
      merged.set(pageIndex, data as PageData);
    }
  }

  const dirtyOnly = new Map<number, PageData>(
    [...merged.entries()].filter(([, p]) => p.isDirty),
  );

  // ── アサート 3: メモリ在 + IDB 退避を merge した結果が全ページ分 ──────────
  expect(merged.size, `merged total must be ${pageCount}`).toBe(pageCount);

  // ── アサート 4: dirty ページが全ページ分（欠落なし）──────────────────────
  expect(dirtyOnly.size, `dirtyOnly must be ${pageCount}`).toBe(pageCount);

  // ── アサート 5: メモリ在 + IDB 退避の両方がカバーされていること ───────────
  // IDB 退避されたページ数（tempPages のうち merged に追加されたもの）
  let idbCoveredCount = 0;
  for (const [pageId] of tempPages.entries()) {
    const pageIndex = parsePageId(pageId);
    if (pageIndex !== null && !afterEditState.document!.pages.has(pageIndex)) {
      idbCoveredCount++;
    }
  }
  expect(
    idbCoveredCount,
    `IDB-covered page count must be >= ${expectedEvicted}`,
  ).toBeGreaterThanOrEqual(expectedEvicted);

  // ── サイクル 1: savePDF ───────────────────────────────────────────────────
  const docForSave: PecoDocument = { ...initialDoc, pages: dirtyOnly };
  const savedBytes = await savePDF(
    { bytes: corpus.inputBytes },
    docForSave,
    fontBytes,
  );

  // ── サイクル 1 再ロード検証 ────────────────────────────────────────────────
  const { meta: meta1, totalPages: reloadedTotal1 } = await reloadBBoxMetaViaPdfjs(savedBytes);

  expect(meta1, 'cycle 1: meta must not be null').not.toBeNull();
  expect(reloadedTotal1, `cycle 1: totalPages must be ${pageCount}`).toBe(pageCount);

  // ── アサート 6: ブロック総数の一致（1 件も欠落しない）───────────────────
  let totalSavedBlocks = 0;
  for (const blocks of Object.values(meta1!)) {
    totalSavedBlocks += blocks.length;
  }
  const expectedTotalBlocks = pageCount * BLOCKS_PER_PAGE;
  expect(totalSavedBlocks, `cycle 1: total saved blocks must be ${expectedTotalBlocks}`).toBe(
    expectedTotalBlocks,
  );

  // ── アサート 7: 一意マーカーが 1 件残らず存在する ────────────────────────
  const missingMarkers: string[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const pageKey = String(pi);
    const pageBlocks = meta1![pageKey];
    if (!pageBlocks) {
      for (let bi = 0; bi < BLOCKS_PER_PAGE; bi++) {
        missingMarkers.push(`L-${pi}-${bi}`);
      }
      continue;
    }
    const foundTexts = new Set(pageBlocks.map((b) => b.text));
    for (let bi = 0; bi < BLOCKS_PER_PAGE; bi++) {
      const marker = `L-${pi}-${bi}`;
      if (!foundTexts.has(marker)) {
        missingMarkers.push(marker);
      }
    }
  }
  expect(
    missingMarkers,
    `cycle 1: missing markers (first 20): ${JSON.stringify(missingMarkers.slice(0, 20))}`,
  ).toEqual([]);

  // ── サイクル 2 耐久: 再保存してマーカー総数・ブロック数が不変 ────────────
  const savedBytes2 = await savePDF(
    { bytes: savedBytes },
    docForSave,
    fontBytes,
  );
  const { meta: meta2, totalPages: reloadedTotal2 } = await reloadBBoxMetaViaPdfjs(savedBytes2);

  expect(meta2, 'cycle 2: meta must not be null').not.toBeNull();
  expect(reloadedTotal2, `cycle 2: totalPages must be ${pageCount}`).toBe(pageCount);

  let totalSavedBlocks2 = 0;
  for (const blocks of Object.values(meta2!)) {
    totalSavedBlocks2 += blocks.length;
  }
  expect(
    totalSavedBlocks2,
    `cycle 2: total saved blocks must still be ${expectedTotalBlocks}`,
  ).toBe(expectedTotalBlocks);

  const missingMarkers2: string[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const pageKey = String(pi);
    const pageBlocks = meta2![pageKey];
    if (!pageBlocks) {
      for (let bi = 0; bi < BLOCKS_PER_PAGE; bi++) {
        missingMarkers2.push(`L-${pi}-${bi}`);
      }
      continue;
    }
    const foundTexts = new Set(pageBlocks.map((b) => b.text));
    for (let bi = 0; bi < BLOCKS_PER_PAGE; bi++) {
      const marker = `L-${pi}-${bi}`;
      if (!foundTexts.has(marker)) {
        missingMarkers2.push(marker);
      }
    }
  }
  expect(
    missingMarkers2,
    `cycle 2: missing markers (first 20): ${JSON.stringify(missingMarkers2.slice(0, 20))}`,
  ).toEqual([]);
}

// ── 高密度テスト共通ロジック ─────────────────────────────────────────────────

/**
 * 高密度（1 ページに大量 BB）保存テストを実行する。
 *
 * LRU 退避は主眼でない（ページ数が少ないため退避は起きない）ので退避アサートは行わない。
 * 保存再集約経路を通して savePDF → reloadBBoxMetaViaPdfjs で再ロードし、
 * マーカー無欠落 + text/bbox/order/writingMode 一致 + 2 サイクル耐久を検証する。
 *
 * @param pageCount    ページ数
 * @param blocksPerPage 1 ページあたりのブロック数
 * @param saveTimeLimitMs  savePDF 1 回の所要時間上限（catastrophic 検知のみ・緩い閾値）
 */
async function runHighDensityTest(
  pageCount: number,
  blocksPerPage: number,
  saveTimeLimitMs: number,
): Promise<void> {
  // コーパス生成（格子配置・はみ出しなし）
  const corpus = await buildLargeScale(pageCount, blocksPerPage);

  // ストアに初期ドキュメントをロード（高密度でも LRU 退避しないページ数なのでそのまま使う）
  const initialDoc: PecoDocument = {
    ...corpus.doc,
    pages: new Map(
      Array.from({ length: pageCount }, (_, i) => [
        i,
        {
          pageIndex: i,
          width: 595,
          height: 842,
          textBlocks: [],
          isDirty: false,
          thumbnail: null,
          isTextExtracted: true,
        } satisfies PageData,
      ]),
    ),
    totalPages: pageCount,
  };

  usePecoStore.getState().setDocument(initialDoc);

  const store = usePecoStore.getState();

  // 全ページを dirty 化（corpus から blocks をそのまま使う）
  for (let pi = 0; pi < pageCount; pi++) {
    const pageData = corpus.doc.pages.get(pi);
    if (!pageData) throw new Error(`corpus page ${pi} missing`);
    const blocks: TextBlock[] = pageData.textBlocks.map((b) => ({
      ...b,
      isDirty: true,
    }));
    store.updatePageData(pi, { textBlocks: blocks, isDirty: true }, false);
  }

  await waitForPendingIdbSaves();

  // 高密度ケースはページ数が少ないので IDB 退避は起きない（merge は不要だが一貫性のため実行）
  const { getAllTemporaryPageData } = await import('../../utils/pdfTemporaryStorage');
  const filePath = initialDoc.filePath;
  const tempPages = await getAllTemporaryPageData(filePath);

  const afterEditState = usePecoStore.getState();
  const merged = new Map<number, PageData>(afterEditState.document!.pages);
  for (const [pageId, data] of tempPages.entries()) {
    const pageIndex = parsePageId(pageId);
    if (pageIndex === null) continue;
    if (!merged.has(pageIndex)) {
      merged.set(pageIndex, data as PageData);
    }
  }

  const dirtyOnly = new Map<number, PageData>(
    [...merged.entries()].filter(([, p]) => p.isDirty),
  );

  // ── アサート: 全ページが dirtyOnly に含まれる ──────────────────────────────
  expect(dirtyOnly.size, `dirtyOnly must be ${pageCount}`).toBe(pageCount);

  const docForSave: PecoDocument = { ...initialDoc, pages: dirtyOnly };

  // ── サイクル 1: savePDF（保存時間計測）──────────────────────────────────
  const t0 = performance.now();
  const savedBytes = await savePDF(
    { bytes: corpus.inputBytes },
    docForSave,
    fontBytes,
  );
  const saveMs = Math.round(performance.now() - t0);
  console.log(
    `[highDensity] ${pageCount}p×${blocksPerPage}BB: savePDF cycle1=${saveMs}ms, output=${(savedBytes.byteLength / 1024).toFixed(0)}KB`,
  );

  // ── 保存時間ガード（catastrophic 検知のみ・緩い上限）────────────────────
  expect(
    saveMs,
    `savePDF must complete within ${saveTimeLimitMs}ms (catastrophic guard). Actual: ${saveMs}ms`,
  ).toBeLessThan(saveTimeLimitMs);

  // ── サイクル 1 再ロード検証 ────────────────────────────────────────────────
  const { meta: meta1, totalPages: reloadedTotal1 } = await reloadBBoxMetaViaPdfjs(savedBytes);

  expect(meta1, 'cycle 1: meta must not be null').not.toBeNull();
  expect(reloadedTotal1, `cycle 1: totalPages must be ${pageCount}`).toBe(pageCount);

  const expectedTotalBlocks = pageCount * blocksPerPage;

  // ── アサート: ブロック総数の一致（件数無欠落）───────────────────────────
  let totalSavedBlocks = 0;
  for (const blocks of Object.values(meta1!)) {
    totalSavedBlocks += blocks.length;
  }
  expect(
    totalSavedBlocks,
    `cycle 1: total saved blocks must be ${expectedTotalBlocks}`,
  ).toBe(expectedTotalBlocks);

  // ── アサート: 一意マーカー全件存在 ───────────────────────────────────────
  const missingMarkers: string[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const pageKey = String(pi);
    const pageBlocks = meta1![pageKey];
    if (!pageBlocks) {
      for (let bi = 0; bi < blocksPerPage; bi++) {
        missingMarkers.push(`L-${pi}-${bi}`);
      }
      continue;
    }
    const foundTexts = new Set(pageBlocks.map((b) => b.text));
    for (let bi = 0; bi < blocksPerPage; bi++) {
      const marker = `L-${pi}-${bi}`;
      if (!foundTexts.has(marker)) {
        missingMarkers.push(marker);
      }
    }
  }
  expect(
    missingMarkers,
    `cycle 1: missing markers (first 20): ${JSON.stringify(missingMarkers.slice(0, 20))}`,
  ).toEqual([]);

  // ── アサート: text/bbox/order/writingMode 一致（assertMetaMatchesInput 相当）
  for (let pi = 0; pi < pageCount; pi++) {
    const pageKey = String(pi);
    const inputBlocks = corpus.doc.pages.get(pi)!.textBlocks.slice().sort((a, b) => a.order - b.order);
    const reloadedBlocks = meta1![pageKey];
    expect(reloadedBlocks, `page ${pi}: meta must exist`).toBeDefined();
    expect(reloadedBlocks.length, `page ${pi}: block count`).toBe(inputBlocks.length);

    for (let bi = 0; bi < inputBlocks.length; bi++) {
      const inp = inputBlocks[bi];
      const rel = reloadedBlocks[bi];
      expect(rel.text, `p${pi} b${bi}: text`).toBe(inp.text);
      expect(rel.writingMode, `p${pi} b${bi}: writingMode`).toBe(inp.writingMode);
      expect(rel.order, `p${pi} b${bi}: order`).toBe(bi);
      expect(rel.bbox.x, `p${pi} b${bi}: bbox.x`).toBeCloseTo(inp.bbox.x, 0);
      expect(rel.bbox.y, `p${pi} b${bi}: bbox.y`).toBeCloseTo(inp.bbox.y, 0);
      expect(rel.bbox.width, `p${pi} b${bi}: bbox.width`).toBeCloseTo(inp.bbox.width, 0);
      expect(rel.bbox.height, `p${pi} b${bi}: bbox.height`).toBeCloseTo(inp.bbox.height, 0);
    }
  }

  // ── サイクル 2 耐久: 再保存でマーカー総数・件数不変 ─────────────────────
  const t1 = performance.now();
  const savedBytes2 = await savePDF(
    { bytes: savedBytes },
    docForSave,
    fontBytes,
  );
  const saveMs2 = Math.round(performance.now() - t1);
  console.log(
    `[highDensity] ${pageCount}p×${blocksPerPage}BB: savePDF cycle2=${saveMs2}ms`,
  );

  const { meta: meta2, totalPages: reloadedTotal2 } = await reloadBBoxMetaViaPdfjs(savedBytes2);

  expect(meta2, 'cycle 2: meta must not be null').not.toBeNull();
  expect(reloadedTotal2, `cycle 2: totalPages must be ${pageCount}`).toBe(pageCount);

  let totalSavedBlocks2 = 0;
  for (const blocks of Object.values(meta2!)) {
    totalSavedBlocks2 += blocks.length;
  }
  expect(
    totalSavedBlocks2,
    `cycle 2: total saved blocks must still be ${expectedTotalBlocks}`,
  ).toBe(expectedTotalBlocks);

  const missingMarkers2: string[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const pageKey = String(pi);
    const pageBlocks = meta2![pageKey];
    if (!pageBlocks) {
      for (let bi = 0; bi < blocksPerPage; bi++) {
        missingMarkers2.push(`L-${pi}-${bi}`);
      }
      continue;
    }
    const foundTexts = new Set(pageBlocks.map((b) => b.text));
    for (let bi = 0; bi < blocksPerPage; bi++) {
      const marker = `L-${pi}-${bi}`;
      if (!foundTexts.has(marker)) {
        missingMarkers2.push(marker);
      }
    }
  }
  expect(
    missingMarkers2,
    `cycle 2: missing markers (first 20): ${JSON.stringify(missingMarkers2.slice(0, 20))}`,
  ).toEqual([]);
}

// ── テストスイート ───────────────────────────────────────────────────────────

describe('LRU 退避大規模保存 — ブロック無欠落不変則', () => {
  it(
    '51 ページ（境界直上: MAX_CACHED_PAGES+1）: 全ブロックが保存後に存在し、IDB 退避が発火している',
    async () => {
      await runLargeScaleTest(51);
    },
    // 51 ページ×3 ブロックの savePDF を 2 サイクル + pdfjs 再ロード 2 回
    // CI 環境基準で 120 秒以内を想定
    120_000,
  );

  it(
    '120 ページ（大幅超過: MAX_CACHED_PAGES×2.4）: 全ブロックが保存後に存在し、IDB 退避が発火している',
    async () => {
      await runLargeScaleTest(120);
    },
    // 120 ページは 51 より重い。CI 実行時間 3 分以内（180 秒）に収める
    180_000,
  );
});

// ── らでん監査指摘: 1000 ページ級の検証スケール回復 (env ガード・手動実行) ─────
//
// 9e4c627 で loadTest1000Pages.test.ts (env 無しで常時 skip・pdf-lib 直の
// generate/reload のみで実保存経路を通らない形骸テスト) が削除され、実経路
// (savePDF 等) を通す本ファイルの 51/120 ページテストへ統合された。
// らでん指摘: しかし後継は 120 ページどまりで、1000 ページ級の検証スケールが
// 縮小したまま回復していない。ここで runLargeScaleTest(1000) を、通常の
// test:critical / CI では重すぎるため PECO_LARGE_SCALE=1000 のときのみ実行する
// 形で復活させる（既定は skip・手動実行枠 = package.json の test:pdf:largescale）。
const LARGE_SCALE_1000_ENABLED = process.env.PECO_LARGE_SCALE === '1000';

if (!LARGE_SCALE_1000_ENABLED) {
  // なぜ skip されるかを明示する（"なぜskipか"を出力する要件）。
  // eslint-disable-next-line no-console
  console.log(
    '[goldenMasterLargeScale] 1000 ページテストは skip します。' +
      '実行するには環境変数 PECO_LARGE_SCALE=1000 を設定してください' +
      '（例: npm run test:pdf:largescale）。',
  );
}

describe('LRU 退避 1000 ページ規模 — 検証スケール回復 (env ガード・手動実行)', () => {
  it.skipIf(!LARGE_SCALE_1000_ENABLED)(
    '1000 ページ（大幅超過: MAX_CACHED_PAGES×20）: 全ブロックが保存後に存在し、IDB 退避が発火している',
    async () => {
      await runLargeScaleTest(1000);
    },
    // 1000 ページ×3 ブロックの savePDF を 2 サイクル + pdfjs 再ロード 2 回。
    // 120 ページの 180 秒上限からの外挿で余裕を持って 10 分に設定（手動実行前提のため厳しくしない）。
    600_000,
  );
});

describe('高密度 BB 保存 — 1 ページ大量ブロックの無欠落不変則', () => {
  it(
    '1 ページ × 1000 ブロック: 全マーカー保存後に存在・text/bbox/order 一致・2 サイクル耐久',
    async () => {
      // 保存時間上限: 10 秒（catastrophic 検知のみ）
      // 実測: cycle1=336〜486ms, cycle2=342〜448ms（ローカル環境）
      // 上限は実測最大値の約 20 倍マージン。CI 環境での遅延を考慮し 10 秒に設定。
      // 異常劣化（アルゴリズム退行・O(n^2) 等）だけを捕まえる。タイトな性能ゲートではない。
      await runHighDensityTest(1, 1000, 10_000);
    },
    60_000,
  );

  it(
    '3 ページ × 400 ブロック: 全マーカー保存後に存在・text/bbox/order 一致・2 サイクル耐久',
    async () => {
      // 保存時間上限: 10 秒（catastrophic 検知のみ）
      // 実測: cycle1=288〜289ms, cycle2=342〜395ms（ローカル環境）
      // 上限は実測最大値の約 25 倍マージン。CI 環境でのノイズを十分吸収できる。
      await runHighDensityTest(3, 400, 10_000);
    },
    60_000,
  );
});
