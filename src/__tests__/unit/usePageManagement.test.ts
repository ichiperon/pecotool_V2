/**
 * Phase 5 Wave 2: usePageManagement テスト
 * Cases: U-PM2-01, U-PM2-02, U-PM2-03
 *
 * usePageManagement は pecoStore.deletePages / movePage を呼び出したあと、
 * IDB I/O (deleteTemporaryPageKeys / renameTemporaryPageKeys) を副作用として実行する hook。
 * ここでは IDB 副作用層と store 連携の双方を検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePecoStore, waitForPendingIdbSaves } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import type { PageData, PecoDocument } from '../../types';

// ── IDB ヘルパのモック ──────────────────────────────────────────
// usePageManagement は pdfTemporaryStorage から deleteTemporaryPageKeys / renameTemporaryPageKeys をインポートする
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
  renameTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
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
  renameTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

import {
  deleteTemporaryPageKeys,
  renameTemporaryPageKeys,
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
  vi.mocked(renameTemporaryPageKeys).mockReset().mockResolvedValue(undefined);
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
    expect(renameTemporaryPageKeys).not.toHaveBeenCalled();
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

  it('削除後に IDB 副作用が非同期で実行される', async () => {
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

    // deleteTemporaryPageKeys または renameTemporaryPageKeys のいずれかが呼ばれる
    // (実際の呼び出しは IDB callback 内の void chain なので、少なくとも一方が呼ばれることを確認)
    expect(
      vi.mocked(deleteTemporaryPageKeys).mock.calls.length +
      vi.mocked(renameTemporaryPageKeys).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it('PCT-029: hook-side delete/rename IDB work が waitForPendingIdbSaves に追跡される', async () => {
    const deleteWork = deferredVoid();
    const renameWork = deferredVoid();
    vi.mocked(deleteTemporaryPageKeys).mockReturnValueOnce(deleteWork.promise);
    vi.mocked(renameTemporaryPageKeys).mockReturnValueOnce(renameWork.promise);

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
      await Promise.resolve();
      await Promise.resolve();
      expect(renameTemporaryPageKeys).toHaveBeenCalled();
      expect(waitResolved).toBe(false);

      renameWork.resolve();
      await waitPromise;
      expect(waitResolved).toBe(true);
    } finally {
      deleteWork.resolve();
      renameWork.resolve();
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
      expect(renameTemporaryPageKeys).not.toHaveBeenCalled();
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
    // IDB 副作用は呼ばれない
    expect(renameTemporaryPageKeys).not.toHaveBeenCalled();
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
  });

  it('IDB エラー時に lastIdbError が設定される', async () => {
    const idbError = new Error('IDB rename failed');
    vi.mocked(renameTemporaryPageKeys).mockRejectedValueOnce(idbError);
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
        await result.current.handleMovePage(0, 2);
      });
      await waitForPendingIdbSaves();

      expect(useInfraStore.getState().lastIdbError).toBe(idbError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('PCT-029: hook-side move rename IDB work が waitForPendingIdbSaves に追跡される', async () => {
    const renameWork = deferredVoid();
    vi.mocked(renameTemporaryPageKeys).mockReturnValueOnce(renameWork.promise);

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

    let waitResolved = false;
    const waitPromise = waitForPendingIdbSaves().then(() => {
      waitResolved = true;
    });

    try {
      await Promise.resolve();
      expect(waitResolved).toBe(false);

      renameWork.resolve();
      await waitPromise;
      expect(waitResolved).toBe(true);
    } finally {
      renameWork.resolve();
      await waitPromise;
    }
  });

  it('PCT-031: 同一 tick の move 連打では先行 rename 完了まで次の rename を開始しない', async () => {
    const firstRename = deferredVoid();
    const secondRename = deferredVoid();
    vi.mocked(renameTemporaryPageKeys)
      .mockReturnValueOnce(firstRename.promise)
      .mockReturnValueOnce(secondRename.promise);

    const doc = makeDoc(4);
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2, 3],
      currentPageIndex: 0,
    });

    const { result } = renderHook(() => usePageManagement());
    let firstPromise: Promise<void> = Promise.resolve();
    let secondPromise: Promise<void> = Promise.resolve();
    let secondResolved = false;

    await act(async () => {
      firstPromise = result.current.handleMovePage(0, 3);
      secondPromise = result.current.handleMovePage(0, 2).then(() => {
        secondResolved = true;
      });
      await flushMicrotasks();
    });

    try {
      expect(renameTemporaryPageKeys).toHaveBeenCalledTimes(1);
      expect(secondResolved).toBe(false);

      firstRename.resolve();
      await act(async () => {
        await flushMicrotasks();
      });

      expect(renameTemporaryPageKeys).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.all([firstPromise, secondPromise]);
      });
      expect(secondResolved).toBe(true);
    } finally {
      firstRename.resolve();
      secondRename.resolve();
      await Promise.allSettled([firstPromise, secondPromise]);
      await waitForPendingIdbSaves();
    }
  });

  it('PCT-031: move 中に始まった delete は先行 rename 完了まで IDB delete を開始しない', async () => {
    const moveRename = deferredVoid();
    vi.mocked(renameTemporaryPageKeys).mockReturnValueOnce(moveRename.promise);

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
      expect(renameTemporaryPageKeys).toHaveBeenCalledTimes(1);
      expect(deleteTemporaryPageKeys).not.toHaveBeenCalled();

      moveRename.resolve();
      await act(async () => {
        await flushMicrotasks();
      });

      expect(deleteTemporaryPageKeys).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.all([movePromise, deletePromise]);
      });
    } finally {
      moveRename.resolve();
      await Promise.allSettled([movePromise, deletePromise]);
      await waitForPendingIdbSaves();
    }
  });
});
