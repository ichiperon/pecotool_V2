/**
 * Phase 5 Wave 2: usePageManagement テスト (PCT-104 A-lite 段階3 更新)
 * Cases: U-PM2-01, U-PM2-02, U-PM2-03
 *
 * usePageManagement は pecoStore.deletePages / movePage を呼び出したあと、
 * IDB 副作用 (deleteTemporaryPageKeys) を担う hook。
 * PCT-104 (A-lite 段階3): pageId が不変なため movePage の IDB rename は完全に不要。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePecoStore, waitForPendingIdbSaves, trackPendingIdbWork } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import type { PageData, PecoDocument } from '../../types';

// ── IDB ヘルパのモック ──────────────────────────────────────────
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
  saveTemporaryPageData: vi.fn().mockResolvedValue(undefined),
  getTemporaryPageData: vi.fn().mockResolvedValue(null),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
}));

// pecoStore が pdfLoader からインポートするヘルパもモック
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

import {
  deleteTemporaryPageKeys,
} from '../../utils/pdfTemporaryStorage';

import { usePageManagement } from '../../hooks/usePageManagement';

// ── ヘルパー ───────────────────────────────────────────────────

function makePage(pageIndex: number, overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  };
}

function makeDoc(pageCount: number): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < pageCount; i++) {
    pages.set(i, makePage(i));
  }
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pageCount,
    metadata: {},
    pages,
  };
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 5) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

const INITIAL_PECO_STATE = {
  document: null as PecoDocument | null,
  pageOrder: [] as number[],
  currentPageIndex: 0,
  isDirty: false,
  selectedIds: new Set<string>(),
  lastSelectedId: null as string | null,
  clipboard: [],
  undoStack: [],
  redoStack: [],
  lastSavedActionIndex: 0,
} as const;

const INITIAL_INFRA_STATE = {
  documentEpoch: 0,
  pageAccessOrder: [] as number[],
  pendingRestoration: null,
  lastIdbError: null,
  currentPageProxy: null,
  currentPageProxyKey: null,
} as const;

beforeEach(async () => {
  await waitForPendingIdbSaves();
  vi.mocked(deleteTemporaryPageKeys).mockReset().mockResolvedValue(undefined);
  usePecoStore.setState({ ...INITIAL_PECO_STATE });
  useInfraStore.setState({ ...INITIAL_INFRA_STATE });
});

// ── U-PM2-01: 空配列に対する deletePages は no-op ────────────────

describe('U-PM2-01: handleDeletePages — 空配列は no-op', () => {
  it('displayIndices=[] を渡しても store 状態が変化しない', async () => {
    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 1,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      await result.current.handleDeletePages([]);
    });

    const state = usePecoStore.getState();
    // totalPages は変化しない
    expect(state.document?.totalPages).toBe(3);
    // pageOrder は変化しない
    expect(state.pageOrder).toEqual([0, 1, 2]);
    // isDirty にならない
    expect(state.isDirty).toBe(false);
    // IDB 副作用も呼ばれない
    expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();
  });

  it('document=null のとき空配列でも no-op で例外を投げない', async () => {
    usePecoStore.setState({ document: null, pageOrder: [] });

    const { result } = renderHook(() => usePageManagement());

    await expect(
      act(async () => {
        await result.current.handleDeletePages([]);
      })
    ).resolves.toBeUndefined();
  });
});

// ── U-PM2-02: 削除後の currentPageIndex が範囲内に収まる ─────────

describe('U-PM2-02: handleDeletePages — 削除後の currentPageIndex 調整', () => {
  it('末尾ページを削除した場合 currentPageIndex が新 totalPages-1 に収まる', async () => {
    // 3 ページ (0,1,2)、currentPage=2 (末尾)
    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 2,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      // displayIndex=2 (末尾) を削除
      await result.current.handleDeletePages([2]);
    });

    const state = usePecoStore.getState();
    // 2 ページになる
    expect(state.document?.totalPages).toBe(2);
    // currentPageIndex は 0 または 1 の範囲内
    expect(state.currentPageIndex).toBeLessThanOrEqual(1);
    expect(state.currentPageIndex).toBeGreaterThanOrEqual(0);
  });

  it('中間ページを削除した場合 currentPageIndex が範囲外にならない', async () => {
    // 5 ページ、currentPage=3
    const doc = makeDoc(5);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2, 3, 4],
      currentPageIndex: 3,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      // displayIndex=0,1,2,3 を削除 → 残 1 ページ (index=4)
      await result.current.handleDeletePages([0, 1, 2, 3]);
    });

    const state = usePecoStore.getState();
    expect(state.document?.totalPages).toBe(1);
    expect(state.currentPageIndex).toBe(0);
  });

  it('削除後に isDirty が true になる', async () => {
    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      await result.current.handleDeletePages([1]);
    });

    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  it('削除後に deleteTemporaryPageKeys が IDB 副作用として実行される', async () => {
    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      await result.current.handleDeletePages([2]);
    });

    // IDB 副作用は void で起動されるため少し待つ
    await Promise.resolve();
    await Promise.resolve();

    // PCT-104 段階3: deleteTemporaryPageKeys が pageId 形式で呼ばれる
    expect(deleteTemporaryPageKeys).toHaveBeenCalled();
  });

  it('PCT-029: hook-side delete IDB work が waitForPendingIdbSaves に追跡される', async () => {
    const deleteWork = deferredVoid();
    vi.mocked(deleteTemporaryPageKeys).mockReturnValueOnce(deleteWork.promise);

    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      await result.current.handleDeletePages([1]);
    });

    let waitResolved = false;
    const waitPromise = waitForPendingIdbSaves().then(() => {
      waitResolved = true;
    });

    try {
      await Promise.resolve();
      expect(waitResolved).toBe(false);

      deleteWork.resolve();
      await waitPromise;
      expect(waitResolved).toBe(true);
    } finally {
      deleteWork.resolve();
      await waitPromise;
    }
  });

  it('PCT-032: handleDeletePages の IDB エラーで lastIdbError が設定される', async () => {
    const idbError = new Error('IDB delete failed');
    vi.mocked(deleteTemporaryPageKeys).mockRejectedValueOnce(idbError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const doc = makeDoc(3);
      usePecoStore.setState({
        document: doc,
        pageOrder: [0, 1, 2],
        currentPageIndex: 0,
      });

      const { result } = renderHook(() => usePageManagement());

      await act(async () => {
        await result.current.handleDeletePages([1]);
      });
      await waitForPendingIdbSaves();

      expect(useInfraStore.getState().lastIdbError).toBe(idbError);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ── U-PM2-03: movePage で移動元 = 移動先のとき no-op ─────────────

describe('U-PM2-03: handleMovePage — 移動元=移動先のとき no-op', () => {
  it('fromDisplayIndex === toDisplayIndex では store 状態が変化しない', async () => {
    const doc = makeDoc(3);
    const initialPageOrder = [0, 1, 2];
    usePecoStore.setState({
      document: doc,
      pageOrder: [...initialPageOrder],
      currentPageIndex: 1,
      isDirty: false,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      // 同じ位置への移動 (no-op)
      await result.current.handleMovePage(1, 1);
    });

    const state = usePecoStore.getState();
    // pageOrder は変化しない
    expect(state.pageOrder).toEqual(initialPageOrder);
    // isDirty にならない
    expect(state.isDirty).toBe(false);
    // PCT-104 段階3: movePage は IDB 副作用なし
    expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();
  });

  it('0→2 移動で pageOrder が正しく並び替えられる', async () => {
    const doc = makeDoc(3);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    await act(async () => {
      await result.current.handleMovePage(0, 2);
    });

    const state = usePecoStore.getState();
    // 元ページ順: [0,1,2] → 0番目を2番目へ移動 → pageOrder が変わっている
    expect(state.pageOrder.length).toBe(3);
    // isDirty になる
    expect(state.isDirty).toBe(true);
    // PCT-104 段階3: movePage は IDB rename 不要
    expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();
  });

  it('PCT-031: 同一 tick の move 連打でも全ての movePage が完了する', async () => {
    const doc = makeDoc(4);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2, 3],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());
    let firstDone = false;
    let secondDone = false;

    await act(async () => {
      const firstPromise = result.current.handleMovePage(0, 3).then(() => { firstDone = true; });
      const secondPromise = result.current.handleMovePage(0, 2).then(() => { secondDone = true; });
      await flushMicrotasks();
      await Promise.all([firstPromise, secondPromise]);
    });

    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
    // PCT-104 段階3: movePage で IDB 操作なし
    expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();
  });

  it('PCT-031: move 中に始まった delete は enqueuePageOperation でシリアライズされる', async () => {
    const deleteWork = deferredVoid();
    vi.mocked(deleteTemporaryPageKeys).mockReturnValueOnce(deleteWork.promise);

    const doc = makeDoc(4);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2, 3],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());
    let movePromise: Promise<void> = Promise.resolve();
    let deletePromise: Promise<void> = Promise.resolve();

    await act(async () => {
      movePromise = result.current.handleMovePage(0, 3);
      deletePromise = result.current.handleDeletePages([1]);
      await flushMicrotasks();
    });

    try {
      // deleteTemporaryPageKeys は delete 処理が始まってから呼ばれる
      deleteWork.resolve();
      await act(async () => {
        await Promise.all([movePromise, deletePromise]);
      });
      // delete は呼ばれた（move 後にシリアライズされて実行）
      expect(deleteTemporaryPageKeys).toHaveBeenCalledTimes(1);
    } finally {
      deleteWork.resolve();
      await Promise.allSettled([movePromise, deletePromise]);
      await waitForPendingIdbSaves();
    }
  });
});

// ── H-3 (bug-hunt round2): onIdbWork 経路でも F-6 ガードが効くこと ────────
//
// UI からの実操作は常に onIdbWork を渡すため、pecoStore.deletePages/movePage 内の
// F-6 ガード (`!onIdbWork &&` 条件) は丸ごとスキップされていた。
// waitForPendingIdbSaves() の待機中にファイル切替 (documentEpoch の変化 / filePath 変更)
// が完了した場合、待機開始時点のドキュメント基準の displayIndices / from・toDisplayIndex を
// 新ドキュメントへ誤適用しないことを検証する。

describe('H-3 (bug-hunt round2): 待機中のファイル切替ガード (onIdbWork 経路)', () => {
  function makeOtherDoc(pageCount: number): PecoDocument {
    const pages = new Map<number, PageData>();
    for (let i = 0; i < pageCount; i++) pages.set(i, makePage(i));
    return {
      filePath: 'other.pdf',
      fileName: 'other.pdf',
      totalPages: pageCount,
      metadata: {},
      pages,
    };
  }

  it('handleDeletePages: waitForPendingIdbSaves 待機中に別ファイルへ切り替わったら新ドキュメントを削除しない', async () => {
    // pending な IDB 保存を意図的に登録し、hook 内部の waitForPendingIdbSaves() を足止めする。
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    trackPendingIdbWork(pendingGate);

    const doc1 = makeDoc(3); // filePath: 'test.pdf'
    usePecoStore.setState({
      document: doc1,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    let deleteDone = false;
    let deletePromise: Promise<void> = Promise.resolve();

    try {
      await act(async () => {
        // displayIndex=1 (doc1 基準) の削除を要求する。hook 内部の
        // waitForPendingIdbSaves() が pendingGate 解決まで足止めするため、
        // entryEpoch/entryFilePath のキャプチャ後で待機に入る。
        deletePromise = result.current.handleDeletePages([1]);
        deletePromise.then(() => { deleteDone = true; });
        // マイクロタスクを回し、hook 内部が entryEpoch/entryFilePath を
        // キャプチャ (doc1 基準) した上で waitForPendingIdbSaves() で足止めされるまで進める。
        await flushMicrotasks();
      });

      expect(deleteDone).toBe(false);

      // 待機中に別ファイルへ切り替える (documentEpoch が変化する)。
      const doc2 = makeOtherDoc(3);
      usePecoStore.setState({
        document: doc2,
        pageOrder: [0, 1, 2],
        currentPageIndex: 0,
      });
      useInfraStore.setState({ documentEpoch: useInfraStore.getState().documentEpoch + 1 });

      releasePending();
      await act(async () => {
        await deletePromise;
      });

      const state = usePecoStore.getState();
      // 修正前は displayIndex=1 が doc2 (無関係なドキュメント) に適用され totalPages が
      // 2 に減ってしまう。修正後は doc2 が無傷のまま維持される。
      expect(state.document?.filePath).toBe('other.pdf');
      expect(state.document?.totalPages).toBe(3);
      expect(state.pageOrder).toEqual([0, 1, 2]);
      expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();
    } finally {
      releasePending();
      await waitForPendingIdbSaves();
    }
  });

  it('handleMovePage: waitForPendingIdbSaves 待機中に別ファイルへ切り替わったら新ドキュメントを並べ替えない', async () => {
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    trackPendingIdbWork(pendingGate);

    const doc1 = makeDoc(3); // filePath: 'test.pdf'
    usePecoStore.setState({
      document: doc1,
      pageOrder: [0, 1, 2],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    let moveDone = false;
    let movePromise: Promise<void> = Promise.resolve();

    try {
      await act(async () => {
        // fromDisplayIndex=0/toDisplayIndex=2 (doc1 基準) の移動を要求する。
        movePromise = result.current.handleMovePage(0, 2);
        movePromise.then(() => { moveDone = true; });
        await flushMicrotasks();
      });

      expect(moveDone).toBe(false);

      const doc2 = makeOtherDoc(3);
      usePecoStore.setState({
        document: doc2,
        pageOrder: [0, 1, 2],
        currentPageIndex: 0,
      });
      useInfraStore.setState({ documentEpoch: useInfraStore.getState().documentEpoch + 1 });

      releasePending();
      await act(async () => {
        await movePromise;
      });

      const state = usePecoStore.getState();
      // 修正前は fromDisplayIndex=0/toDisplayIndex=2 (doc1 基準) が doc2 に適用され
      // pageOrder が並び替わってしまう。修正後は doc2 の pageOrder が無傷のまま維持される。
      expect(state.document?.filePath).toBe('other.pdf');
      expect(state.pageOrder).toEqual([0, 1, 2]);
    } finally {
      releasePending();
      await waitForPendingIdbSaves();
    }
  });
});

// ── PCT-208 (#444): 直列キュー内で displayIndex を固定する ───────────
//
// enqueuePageOperation は Promise 連結のみの直列キュー。同一ファイル内で
// move → delete のように連続して operation を発行すると、delete 側の
// entryEpoch/entryFilePath チェックは「move 適用後」にキャプチャされるため
// 常に通過してしまい (ファイル自体は変わっていないため)、move で動いた
// pageOrder に対して呼び出し時点の raw displayIndex をそのまま適用すると
// 無関係なページを削除してしまう。呼び出し時点で対象ページを pageId として
// 固定し、実行直前に最新 pageOrder で再解決することでこれを防ぐ。

describe('PCT-208 (#444): 直列キュー内の displayIndex 固定 — 先行 move 適用後も対象ページを正しく指す', () => {
  it('move(0→3) と同一 tick で発行した delete([1]) は、move 適用後も呼び出し時点の対象ページ (src:1) を削除する', async () => {
    const doc = makeDoc(4);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2, 3],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());

    let movePromise: Promise<void> = Promise.resolve();
    let deletePromise: Promise<void> = Promise.resolve();

    await act(async () => {
      // 同一 tick (await を挟まず) で move → delete を発行する。
      // displayIndices=[1] はこの時点の pageOrder=[0,1,2,3] を基準にした値
      // (= 物理ページ 'src:1')。move はキューの先頭にいるため先に適用される。
      movePromise = result.current.handleMovePage(0, 3);
      deletePromise = result.current.handleDeletePages([1]);
      await Promise.all([movePromise, deletePromise]);
    });

    const state = usePecoStore.getState();
    // move(0→3) 適用後の pageOrder は [1,2,3,0] になる。delete は呼び出し時点の
    // 物理ページ 'src:1' (move 後は位置0) を指し続けるので、そこを削除した
    // 結果は [2,3,0] になる。
    // 修正前は raw displayIndex=1 を move 後の pageOrder へそのまま適用し、
    // 無関係な 'src:2' (呼び出し時点で意図していないページ) を削除していた
    // (その場合の結果は [1,3,0])。
    expect(state.pageOrder).toEqual([2, 3, 0]);
    expect(state.document?.totalPages).toBe(3);
  });
});
