/**
 * Regression / repro test for Issue #436 (PCT-203):
 * 「delete_pages の undo が beforePages を verbatim 復元し isDirty=false のまま —
 *   削除→保存→undo→再保存で復元ページが保存フィルタから漏れる疑い」
 *
 * 本テストの目的:
 *   1. 「削除 → 保存 → undo → 再保存」という Issue 記載のシーケンスを、実際の
 *      pecoStore (deletePages/undo/normalizePageOrderAfterSave) と実際の
 *      buildPdfDocument（pdf-lib 実物）を組み合わせて再現し、復元ページが本当に
 *      保存 PDF から欠落するかを実測する。
 *   2. S-03（docs/invariants.md）「保存後 pageOrder 正規化」が useFileOperations の
 *      _executeSave で呼ぶ normalizePageOrderAfterSave() により、保存直後に
 *      undoStack ごと巻き戻し不能にすることを固定回帰化する。
 *      これが効いている限り、delete_pages の undo 分岐（isDirty 未強制のまま
 *      beforePages を復元する経路）には「保存済みの delete」を通じて到達できない。
 *
 * 検証戦略: ページごとに異なる MediaBox サイズ（100x100 / 150x150 / 200x200）を
 * 割り当て、保存後 PDF の各ページサイズで「どの物理ページが生き残ったか」を判別する
 * （テキスト抽出に依存しない、pdfSaverOffsetAllPages.test.ts 等と同じ pdf-lib 実物流儀）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { usePecoStore, waitForPendingIdbSaves } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import { buildPdfDocument } from '../../utils/pdfSaver';
import * as pdfLoader from '../../utils/pdfLoader';
import type { PageData, PecoDocument } from '../../types';

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

// ── ヘルパー ──────────────────────────────────────────────────

/** 3 ページとも MediaBox サイズを変えた PDF を合成する（サイズ = ページ識別子） */
async function makeThreePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]); // page0
  doc.addPage([150, 150]); // page1 (削除対象)
  doc.addPage([200, 200]); // page2
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

async function getPageSizes(bytes: Uint8Array): Promise<Array<{ w: number; h: number }>> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const sizes: Array<{ w: number; h: number }> = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const { width, height } = doc.getPage(i).getSize();
    sizes.push({ w: width, h: height });
  }
  return sizes;
}

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 100,
    height: 100,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  };
}

function makeThreePagesDocState(): PecoDocument {
  return {
    filePath: 'delete-undo-save-gap.pdf',
    fileName: 'delete-undo-save-gap.pdf',
    totalPages: 3,
    metadata: {},
    pages: new Map([
      [0, makePage({ pageIndex: 0, width: 100, height: 100 })],
      [1, makePage({ pageIndex: 1, width: 150, height: 150 })],
      [2, makePage({ pageIndex: 2, width: 200, height: 200 })],
    ]),
  };
}

const INFRA_INITIAL_STATE = {
  documentEpoch: 0,
  pageAccessOrder: [] as number[],
  pendingRestoration: null,
  lastIdbError: null,
  currentPageProxy: null,
  currentPageProxyKey: null,
} as const;

beforeEach(() => {
  vi.mocked(pdfLoader.saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined);
  vi.mocked(pdfLoader.clearTemporaryChanges).mockReset().mockResolvedValue(undefined);
  vi.mocked(pdfLoader.getAllTemporaryPageData).mockReset().mockResolvedValue(new Map());
  vi.mocked(pdfLoader.deleteTemporaryPageKeys).mockReset().mockResolvedValue(undefined);

  usePecoStore.setState({
    document: null,
    pageOrder: [],
    currentPageIndex: 0,
    isDirty: false,
    lastSavedActionIndex: 0,
    selectedIds: new Set(),
    lastSelectedId: null,
    clipboard: [],
    undoStack: [],
    redoStack: [],
  });
  useInfraStore.setState({ ...INFRA_INITIAL_STATE });
});

describe('Issue #436 (PCT-203): delete_pages undo と保存フィルタの相互作用', () => {
  it('削除→保存で物理ページが正しく落ちる（前提確認）', async () => {
    const originalBytes = await makeThreePagePdf();
    usePecoStore.setState({
      document: makeThreePagesDocState(),
      pageOrder: [0, 1, 2],
    });

    await usePecoStore.getState().deletePages([1]);
    const afterDelete = usePecoStore.getState();
    expect(afterDelete.pageOrder).toEqual([0, 2]);
    expect(afterDelete.document!.pages.size).toBe(2);

    const savedBytes = await buildPdfDocument(
      originalBytes,
      afterDelete.document!,
      undefined,
      [],
      undefined,
      afterDelete.pageOrder,
    );

    const sizes = await getPageSizes(savedBytes);
    expect(sizes).toEqual([{ w: 100, h: 100 }, { w: 200, h: 200 }]);
  });

  it('削除→保存→undo (S-03 正規化あり): undo は no-op になり、削除ページは復活しない (delete_pages undo 分岐に到達しない)', async () => {
    const originalBytes = await makeThreePagePdf();
    usePecoStore.setState({
      document: makeThreePagesDocState(),
      pageOrder: [0, 1, 2],
    });

    // 1) 削除
    await usePecoStore.getState().deletePages([1]);
    const savePageOrderSnapshot = [...usePecoStore.getState().pageOrder]; // [0, 2]

    // 2) 保存（実際の buildPdfDocument で物理的にページを落とす）
    const savedBytes = await buildPdfDocument(
      originalBytes,
      usePecoStore.getState().document!,
      undefined,
      [],
      undefined,
      savePageOrderSnapshot,
    );
    expect((await getPageSizes(savedBytes)).length).toBe(2);

    // 3) useFileOperations._executeSave が保存成功後に必ず呼ぶ後処理
    //    (S-03: docs/invariants.md)。pageOrderMatchesSnapshot が成立する
    //    (保存中に競合編集が無い) 通常シーケンスをそのまま再現する。
    usePecoStore.getState().normalizePageOrderAfterSave(savePageOrderSnapshot);
    await waitForPendingIdbSaves();

    const postNormalize = usePecoStore.getState();
    // S-03: pageOrder は identity に正規化され、undoStack は丸ごとクリアされる。
    expect(postNormalize.pageOrder).toEqual([0, 1]);
    expect(postNormalize.undoStack).toHaveLength(0);

    // 4) undo — undoStack が空なので no-op（delete_pages の undo 分岐(*)には
    //    到達しない）。(*) src/store/pecoStore.ts の undo() 内 'delete_pages' 分岐。
    usePecoStore.getState().undo();
    await waitForPendingIdbSaves();

    const afterUndo = usePecoStore.getState();
    expect(afterUndo.document!.pages.size).toBe(2); // 削除ページは復活していない
    expect(afterUndo.pageOrder).toEqual([0, 1]);

    // 5) 「再保存」しても、保存対象は 2 ページのまま（Issue が懸念した「復元ページの
    //    喪失」は起こりようがない — そもそも undo で復元されていないため）。
    const resavedBytes = await buildPdfDocument(
      savedBytes,
      afterUndo.document!,
      undefined,
      [],
      undefined,
      afterUndo.pageOrder,
    );
    const finalSizes = await getPageSizes(resavedBytes);
    expect(finalSizes).toEqual([{ w: 100, h: 100 }, { w: 200, h: 200 }]);
  });

  it('(参考) delete_pages undo 分岐が到達できたと仮定しても、ページの物理存在は isDirty でなく pageOrder 復元で決まる', async () => {
    // S-03 のクリアが効かない状況を意図的に作り、delete_pages undo 分岐だけを
    // 単体で検証する（#367/PCT-144 回帰テストと同型のセットアップ）。
    // 目的: Issue が疑った「isDirty=false だと保存フィルタから漏れてページ実体が
    // 消える」という前提が pdfSaverCore の実装と一致するかを確認する。
    const originalBytes = await makeThreePagePdf();
    const beforePages = new Map([
      [0, makePage({ pageIndex: 0, width: 100, height: 100 })],
      [1, makePage({ pageIndex: 1, width: 150, height: 150, isDirty: false })],
      [2, makePage({ pageIndex: 2, width: 200, height: 200 })],
    ]);
    const afterPages = new Map([
      [0, makePage({ pageIndex: 0, width: 100, height: 100 })],
      [1, makePage({ pageIndex: 1, width: 200, height: 200 })],
    ]);

    usePecoStore.setState({
      document: {
        filePath: 'delete-undo-save-gap.pdf',
        fileName: 'delete-undo-save-gap.pdf',
        totalPages: 2,
        metadata: {},
        pages: afterPages,
      },
      pageOrder: [0, 2],
      undoStack: [{
        type: 'delete_pages',
        beforePages,
        afterPages,
        beforeOrder: [0, 1, 2],
        afterOrder: [0, 2],
        beforeCurrentPageIndex: 0,
        afterCurrentPageIndex: 0,
        beforeTotalPages: 3,
        afterTotalPages: 2,
        deletedPageIndices: [1],
      }],
      redoStack: [],
    });

    usePecoStore.getState().undo();
    await waitForPendingIdbSaves();

    const restored = usePecoStore.getState();
    expect(restored.pageOrder).toEqual([0, 1, 2]);
    const restoredPage1 = restored.document!.pages.get(1);
    // Issue の指摘どおり isDirty は false のまま (verbatim 復元)。
    expect(restoredPage1?.isDirty).toBe(false);

    // pageOrder が正しく [0,1,2] に復元されていれば、buildPdfDocument の
    // 物理ページ再構成 (copyPages by pageOrder) は isDirty を一切見ずに
    // 3 ページとも saved 出力へ含める。dirtyPages フィルタ (isDirty) は
    // 「テキスト編集を content stream に焼き直すか」だけを左右し、
    // 「ページを出力に含めるか」は左右しない。
    const resavedBytes = await buildPdfDocument(
      originalBytes, // まだ最初の delete を保存していない前提の originalBytes (3ページ)
      restored.document!,
      undefined,
      [],
      undefined,
      restored.pageOrder,
    );
    const sizes = await getPageSizes(resavedBytes);
    expect(sizes).toEqual([{ w: 100, h: 100 }, { w: 150, h: 150 }, { w: 200, h: 200 }]);
  });
});
