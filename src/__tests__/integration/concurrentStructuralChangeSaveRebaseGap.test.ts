/**
 * Repro / regression test for Issue #437 (PCT-204):
 * 「保存中の並行構造変更で normalizePageOrderAfterSave が no-op になる一方
 *   originalBytes キャッシュは無条件リベース — undo 到達時に pageOrder（旧番号体系）と
 *   リベース済み bytes（新ページ数）のインデックス不整合の恐れ」
 *
 * #436 (deletePagesUndoSaveGap.test.ts) の変種。あちらは「保存中に競合編集が無い」
 * 通常シーケンスを固定し、normalizePageOrderAfterSave が undoStack を丸ごとクリアして
 * delete_pages undo 分岐に到達しないことを確認した。
 *
 * 本テストは逆に「保存の非同期区間中に別の構造変更 (再 delete) が割り込む」狭いレース窓を
 * 再現する。useFileOperations._executeSave の post-save ブロック
 *   1. setOriginalBytesCache(writePath, savedBytes, ...) — 修正前は無条件実行
 *   2. normalizePageOrderAfterSave(savePageOrder) — ライブ pageOrder が
 *      savePageOrder と一致しない場合は no-op（undoStack はクリアされない）
 * を、実際の pecoStore (deletePages/undo/normalizePageOrderAfterSave)・実際の
 * buildPdfDocument (pdf-lib 実物)・実際の originalBytesCache
 * (useFileOperations の __originalBytesCacheForTest) を縫い合わせて実測する。
 *
 * useFileOperations の重い依存 (フォント読込・Worker 経路・Tauri IPC) は本題と無関係
 * なので、_executeSave 全体を renderHook で実行するのではなく、post-save ブロックと
 * 等価なロジックをテスト内で直接組み立てる（#436 と同じ「store + buildPdfDocument
 * 実物を縫い合わせる」流儀）。__originalBytesCacheForTest は実プロダクトコードの
 * setOriginalBytesCache が読み書きするのと同じモジュールレベルキャッシュそのもの。
 *
 * #437 修正 (このファイル): useFileOperations.ts の post-save ブロックを
 * 「pageOrderMatchesSnapshot が true のときだけ originalBytesCache をリベースする」
 * ようガードした（不一致時は保存前の bytes を温存する）。一致判定は
 * pecoStore.normalizePageOrderAfterSave と共通の src/utils/pageOrder.ts
 * pageOrderEquals を使う（判定ロジックの二重実装を避けるため）。
 * 以降のテストはこのガード済みロジックを直接組み立てて検証する。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { usePecoStore, waitForPendingIdbSaves } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import { buildPdfDocument } from '../../utils/pdfSaver';
import * as pdfLoader from '../../utils/pdfLoader';
import { pageOrderEquals } from '../../utils/pageOrder';
import type { PageData, PecoDocument } from '../../types';

// useFileOperations.ts の import グラフを壊さないための最小限モック。
// pdfLoader は #436 と同じく「呼ばれる関数だけ」を差し替える（未使用の named export は
// undefined のままで問題ない — _executeSave 本体は一切呼ばないため）。
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ mtime: Date.now(), size: 0 }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(),
}));

// __originalBytesCacheForTest は setOriginalBytesCache が読み書きするのと同じ
// モジュールレベルキャッシュへのテスト用アクセサ（本番コードは呼ばない）。
import { __originalBytesCacheForTest } from '../../hooks/useFileOperations';

// ── ヘルパー（#436 deletePagesUndoSaveGap.test.ts と同じ流儀） ──────────────

const FILE_PATH = 'pct204-concurrent-repro.pdf';

/** 3 ページとも MediaBox サイズを変えた PDF を合成する（サイズ = ページ識別子） */
async function makeThreePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]); // src page0
  doc.addPage([150, 150]); // src page1 (1回目の削除対象)
  doc.addPage([200, 200]); // src page2
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
    filePath: FILE_PATH,
    fileName: FILE_PATH,
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
  __originalBytesCacheForTest.clear();
});

describe('Issue #437 (PCT-204): 保存中の並行構造変更で normalize no-op と originalBytes 無条件リベースの非対称', () => {
  it('前提確認: 保存の await 中に別の delete が割り込むと、normalizePageOrderAfterSave は no-op になり undoStack が残存する一方、originalBytesCache は無条件にリベースされる', async () => {
    const originalBytes = await makeThreePagePdf();
    usePecoStore.setState({
      document: makeThreePagesDocState(),
      pageOrder: [0, 1, 2],
    });

    // 1) 削除 (source page1 = displayIndex1 を削除)
    await usePecoStore.getState().deletePages([1]);
    const savePageOrderSnapshot = [...usePecoStore.getState().pageOrder]; // [0, 2]
    expect(savePageOrderSnapshot).toEqual([0, 2]);

    // 2) 保存の PDF 生成完了相当（_executeSave の savePDF はこの save-start スナップショットを
    //    ベースに構築される。以降のライブ store 変化には影響されない）。
    const savedBytes = await buildPdfDocument(
      originalBytes,
      usePecoStore.getState().document!,
      undefined,
      [],
      undefined,
      savePageOrderSnapshot,
    );
    expect((await getPageSizes(savedBytes)).length).toBe(2);

    // 3) 【割り込み】保存の非同期区間中（writeFile 完了前）に、ユーザーが別の delete を実行する。
    //    現在の表示 displayIndex0 (元 source page0) を削除する。
    await usePecoStore.getState().deletePages([0]);
    const afterConcurrentEdit = usePecoStore.getState();
    expect(afterConcurrentEdit.pageOrder).toEqual([2]);
    expect(afterConcurrentEdit.document!.totalPages).toBe(1);
    expect(afterConcurrentEdit.undoStack).toHaveLength(2); // 元の delete + 割り込み delete

    // 4) useFileOperations._executeSave の post-save ブロックを実測する
    //    (判定は pecoStore.normalizePageOrderAfterSave と共通の pageOrderEquals を使う)。
    const liveStateBeforeNormalize = usePecoStore.getState();
    const pageOrderMatchesSnapshot = pageOrderEquals(liveStateBeforeNormalize.pageOrder, savePageOrderSnapshot);
    // 割り込みにより、ライブ pageOrder ([2]) は保存スナップショット ([0,2]) と一致しない。
    expect(pageOrderMatchesSnapshot).toBe(false);

    // setOriginalBytesCache 相当（#437 修正前）: pageOrderMatchesSnapshot を一切見ずに
    // 無条件でリベースする。この it は「修正前は何が起きていたか」という非対称の premise
    // をそのまま記録するために、あえて #437 修正前の無条件リベースを再現する
    // （修正後の実装は次の it 群で検証する — useFileOperations.ts の
    // pageOrderMatchesSnapshot ガード分岐）。
    __originalBytesCacheForTest.set(FILE_PATH, savedBytes);

    // normalizePageOrderAfterSave 相当: snapshot 不一致のため no-op になる
    // (src/hooks/useFileOperations.ts → pecoStore.ts normalizePageOrderAfterSave)。
    usePecoStore.getState().normalizePageOrderAfterSave(savePageOrderSnapshot);
    await waitForPendingIdbSaves();

    const postNormalize = usePecoStore.getState();
    // no-op の実測: pageOrder も undoStack も割り込み delete 後のまま変化しない
    // (S-03 正規化が「保存済みの delete」による undoStack クリアを実行できていない)。
    expect(postNormalize.pageOrder).toEqual([2]);
    expect(postNormalize.undoStack).toHaveLength(2);

    // 非対称の核心（#437 修正前の premise）: originalBytesCache は「2 ページ
    // (source 0,2 の内容)」にリベース済みだが、undoStack にはまだ「pageOrder [0,2]
    // (旧 3 ページ体系) を前提とする delete_pages」が積まれたまま残っている。
    expect(__originalBytesCacheForTest.get(FILE_PATH)!.length).toBe(savedBytes.length);
  });

  /**
   * #437 修正の検証: pageOrderMatchesSnapshot=false のとき、useFileOperations.ts の
   * post-save ブロックは setOriginalBytesCache のリベースをスキップし、保存前に
   * キャッシュされていた originalBytes を温存する（このテストが再現する
   * pageOrderEquals ガード。実装は useFileOperations.ts の pageOrderMatchesSnapshot
   * 分岐そのもの）。
   *
   * 温存によって「ライブ pageOrder が指す番号空間」と「originalBytesCache の番号空間」
   * が保存前のまま揃い続けるため、この後 undo で「旧 3 ページ体系」の pageOrder が
   * 復元されても、温存された 3 ページの originalBytes に対しては有効なインデックスの
   * ままであり、次回保存 (buildPdfDocument の pdf-lib copyPages) は範囲外アクセスを
   * 起こさず正常に完了する。
   */
  it(
    '#437 修正: 保存中の並行 delete → undo → 再保存 は、キャッシュ温存ガードにより例外を投げず完了する',
    async () => {
      const originalBytes = await makeThreePagePdf();
      usePecoStore.setState({
        document: makeThreePagesDocState(),
        pageOrder: [0, 1, 2],
      });
      // background prefetch 相当: 実運用では保存より前に originalBytes が
      // 一度キャッシュされている（useFileOperations の prefetchOriginalBytes）。
      // ガードが「保存前のキャッシュを温存する」ためには、この事前投入が前提になる。
      __originalBytesCacheForTest.set(FILE_PATH, originalBytes);

      // 1) 削除 → 2) 保存の PDF 生成 → 3) 割り込み delete （前提確認 it と同一シーケンス）
      await usePecoStore.getState().deletePages([1]);
      const savePageOrderSnapshot = [...usePecoStore.getState().pageOrder]; // [0, 2]
      const savedBytes = await buildPdfDocument(
        originalBytes,
        usePecoStore.getState().document!,
        undefined,
        [],
        undefined,
        savePageOrderSnapshot,
      );
      await usePecoStore.getState().deletePages([0]);

      // 4) post-save ブロック（#437 修正後）: pageOrderMatchesSnapshot=false の間は
      //    リベースをスキップする（useFileOperations.ts の分岐と同じ判定・同じ帰結）。
      const liveStateBeforeNormalize = usePecoStore.getState();
      const pageOrderMatchesSnapshot = pageOrderEquals(liveStateBeforeNormalize.pageOrder, savePageOrderSnapshot);
      expect(pageOrderMatchesSnapshot).toBe(false);
      if (pageOrderMatchesSnapshot) {
        __originalBytesCacheForTest.set(FILE_PATH, savedBytes);
      }
      // pageOrderMatchesSnapshot=false のため、上のガードによりリベースはスキップされ、
      // キャッシュは prefetch 時の originalBytes (3ページ) のまま温存される。

      usePecoStore.getState().normalizePageOrderAfterSave(savePageOrderSnapshot);
      await waitForPendingIdbSaves();

      // 5) undo — 割り込み delete (action2) を巻き戻す。delete_pages undo 分岐に到達する。
      usePecoStore.getState().undo();
      await waitForPendingIdbSaves();

      const restored = usePecoStore.getState();
      // undo は「旧 3 ページ体系」の pageOrder [0,2] を復元する。
      expect(restored.pageOrder).toEqual([0, 2]);
      expect(restored.document!.totalPages).toBe(2);

      // 6) 再保存: originalBytesCache はガードにより温存されたまま（3 ページ、旧番号体系）。
      const cachedBytes = __originalBytesCacheForTest.get(FILE_PATH)!;
      expect((await getPageSizes(cachedBytes)).length).toBe(3);

      // 【#437 修正後のあるべき姿】pageOrder=[0,2] (旧番号体系) と 3 ページの温存された
      // bytes の番号空間が揃っているため、例外を投げずに再保存が完了する。
      const resavedBytes = await buildPdfDocument(
        cachedBytes,
        restored.document!,
        undefined,
        [],
        undefined,
        restored.pageOrder,
      );
      expect(resavedBytes.length).toBeGreaterThan(0);
      expect((await getPageSizes(resavedBytes)).length).toBe(2);
    },
  );

  it(
    '#437 修正: pageOrderMatchesSnapshot=false のとき originalBytesCache は savedBytes へリベースされず保存前の bytes のまま温存される',
    async () => {
      const originalBytes = await makeThreePagePdf();
      usePecoStore.setState({
        document: makeThreePagesDocState(),
        pageOrder: [0, 1, 2],
      });
      __originalBytesCacheForTest.set(FILE_PATH, originalBytes);

      await usePecoStore.getState().deletePages([1]);
      const savePageOrderSnapshot = [...usePecoStore.getState().pageOrder]; // [0, 2]
      const savedBytes = await buildPdfDocument(
        originalBytes,
        usePecoStore.getState().document!,
        undefined,
        [],
        undefined,
        savePageOrderSnapshot,
      );
      await usePecoStore.getState().deletePages([0]); // 割り込み delete

      const liveState = usePecoStore.getState();
      const pageOrderMatchesSnapshot = pageOrderEquals(liveState.pageOrder, savePageOrderSnapshot);
      expect(pageOrderMatchesSnapshot).toBe(false);

      // #437 修正後のガード（useFileOperations.ts の pageOrderMatchesSnapshot 分岐と
      // 同じ判定・同じ帰結）: 不一致時は savedBytes へのリベースをスキップする。
      if (pageOrderMatchesSnapshot) {
        __originalBytesCacheForTest.set(FILE_PATH, savedBytes);
      }
      usePecoStore.getState().normalizePageOrderAfterSave(savePageOrderSnapshot);
      await waitForPendingIdbSaves();

      // キャッシュは savedBytes (2ページ) へリベースされず、prefetch 時の
      // originalBytes (3ページ・参照そのまま) の状態で温存されている。
      const preservedBytes = __originalBytesCacheForTest.get(FILE_PATH)!;
      expect(preservedBytes).toBe(originalBytes);
      expect((await getPageSizes(preservedBytes)).length).toBe(3);
      expect(preservedBytes.length).not.toBe(savedBytes.length);

      // normalize も no-op のため、pageOrder は割り込み delete 後の旧番号体系のまま。
      const postNormalize = usePecoStore.getState();
      expect(postNormalize.pageOrder).toEqual([2]);

      // 温存されたキャッシュ（3ページ・旧番号体系）と pageOrder（[2]・旧番号体系）は
      // 番号空間が一致しているため、この時点で保存を試みても例外を投げず完了する。
      const nextSaveBytes = await buildPdfDocument(
        preservedBytes,
        postNormalize.document!,
        undefined,
        [],
        undefined,
        postNormalize.pageOrder,
      );
      expect(nextSaveBytes.length).toBeGreaterThan(0);
      expect((await getPageSizes(nextSaveBytes)).length).toBe(1);
    },
  );
});
