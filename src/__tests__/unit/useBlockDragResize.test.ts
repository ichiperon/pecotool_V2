/**
 * useBlockDragResize: BB ドラッグ移動・リサイズが page.isDirty を立てることを保証する回帰テスト。
 *
 * 背景: 以前は updateDragResize() 内の updatePageData 呼び出しが block.isDirty のみで
 *       page.isDirty を立てていなかった。保存フロー (useFileOperations._executeSave) の
 *       dirtyOnlyPages フィルタは page.isDirty のみを見るため、BB の位置だけ動かした
 *       変更が保存対象から落ちて「保存されない」症状が出ていた。
 *
 * issue #91: ドラッグ中に textBlocks.map による O(N) コピーが走るのを避けるため、
 *       updateDragResize 中は setDragPreviewBboxes のみ呼び、updatePageData は
 *       finishDragResize で 1 度だけ呼ぶ設計に変更した。
 *       既存の RAF coalesce (issue #10) と isDirty 伝播の意図は維持される。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlockDragResize } from '../../hooks/useBlockDragResize';
import type { PageData, TextBlock } from '../../types';

// updateDragResize は RAF で coalesce されるため、テストでは手動制御可能な
// requestAnimationFrame mock を入れて 1 フレーム進めるユーティリティを用意する。
type RafCallback = (t: number) => void;
let rafQueue: Array<{ id: number; cb: RafCallback }> = [];
let rafCounter = 0;

function installRafMock() {
  rafQueue = [];
  rafCounter = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafCounter;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => {
    rafQueue = rafQueue.filter((e) => e.id !== id);
  });
}

function flushRaf() {
  const queued = rafQueue;
  rafQueue = [];
  for (const { cb } of queued) cb(performance.now());
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'b1',
    text: 'text',
    originalText: 'text',
    bbox: { x: 100, y: 100, width: 80, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function makePage(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,         // ← 初期状態は page.isDirty=false
    thumbnail: null,
  };
}

describe('useBlockDragResize: page.isDirty 伝播 (finishDragResize で 1 回)', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('BB 移動: finishDragResize 時に page.isDirty:true を明示して updatePageData を呼ぶ', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const toggleSelection = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection,
        pushAction,
        setDragPreviewBboxes,
      })
    );

    // ブロック内クリック → move モードに入る
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // マウス移動 (RAF にスケジュール)
    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 });
    });
    act(() => {
      flushRaf();
    });

    // ドラッグ中は updatePageData は呼ばれない (issue #91)
    expect(updatePageData).not.toHaveBeenCalled();

    // mouseup で確定書き込み
    act(() => {
      result.current.finishDragResize();
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [pageIdx, partial, pushUndo] = updatePageData.mock.calls[0];
    expect(pageIdx).toBe(0);
    // 回帰対象: partial.isDirty が明示的に true でなければならない
    expect(partial.isDirty).toBe(true);
    expect(pushUndo).toBe(false);                       // undo は pushAction で別途積む
    expect(Array.isArray(partial.textBlocks)).toBe(true);
    expect(partial.textBlocks[0].isDirty).toBe(true);   // block 側も従来通り立っている
    expect(partial.textBlocks[0].bbox.x).toBe(block.bbox.x + 20); // dx = 130-110
    expect(partial.textBlocks[0].bbox.y).toBe(block.bbox.y + 10); // dy = 120-110
  });

  it('BB リサイズ (resize-se): finishDragResize 時に page.isDirty:true を明示する', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    // 右下ハンドル近傍 (x+w=180, y+h=120) をクリックして resize-se に入る
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 180, y: 120 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('resize-se');

    // マウス移動でサイズ変更
    act(() => {
      result.current.updateDragResize({ x: 200, y: 140 });
    });
    act(() => {
      flushRaf();
    });

    // ドラッグ中は updatePageData は呼ばれない
    expect(updatePageData).not.toHaveBeenCalled();

    // mouseup で確定
    act(() => {
      result.current.finishDragResize();
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [, partial] = updatePageData.mock.calls[0];
    expect(partial.isDirty).toBe(true);                 // 回帰対象
    expect(partial.textBlocks[0].isDirty).toBe(true);
    expect(partial.textBlocks[0].bbox.width).toBeGreaterThan(block.bbox.width);
  });
});

describe('useBlockDragResize: 修飾キー付きクリック (#6)', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  // 回帰対象: 以前は tryStartDragOrResize の「既選択ブロックを個別解除する」分岐が
  // ctrlKey/metaKey しか見ていなかったため、Shift+クリックで個別解除できなかった。
  // 修正後は shiftKey も同じ「個別トグル」扱いになり、toggleSelection(id, true) が
  // 呼ばれて既選択ブロックが外れる (move ドラッグに入らない)。
  it('Shift+クリックで既選択ブロックは toggleSelection(id, true) で外れ、drag に入らない', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const toggleSelection = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]), // すでに選択済み
        getPageData: () => pageData,
        updatePageData,
        toggleSelection,
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );

    let started = false;
    act(() => {
      started = result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: true }
      );
    });

    // 個別解除分岐で return true (ハンドル済み) になる
    expect(started).toBe(true);
    // multi=true で toggleSelection が呼ばれる → store 側で既存セットから id を削除
    expect(toggleSelection).toHaveBeenCalledWith(block.id, true);
    // move ドラッグには入らない (dragMode は "none" のまま)
    expect(result.current.dragMode).toBe('none');
    expect(result.current.draggedId).toBeNull();
    // ドラッグ用 page snapshot も走らない
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('Ctrl+クリックで既選択ブロックも従来どおり外れる (回帰防止)', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const toggleSelection = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData: vi.fn(),
        toggleSelection,
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: true, metaKey: false, shiftKey: false }
      );
    });

    expect(toggleSelection).toHaveBeenCalledWith(block.id, true);
    expect(result.current.dragMode).toBe('none');
  });
});

describe('useBlockDragResize: updateDragResize の RAF coalesce (perf #10)', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('同一フレーム内で複数 mousemove が発生しても setDragPreviewBboxes は 1 回しか呼ばれず、最新 pos が反映される', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    // ブロック内クリック → move モードに入る (この呼び出しは store 更新を行わない)
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // 同一フレーム内で複数 mousemove を発火 (RAF はまだ flush していない)
    act(() => {
      result.current.updateDragResize({ x: 115, y: 112 });
      result.current.updateDragResize({ x: 120, y: 115 });
      result.current.updateDragResize({ x: 130, y: 120 });
      result.current.updateDragResize({ x: 140, y: 125 });
    });

    // RAF flush 前: setDragPreviewBboxes はまだ呼ばれていない
    expect(setDragPreviewBboxes).not.toHaveBeenCalled();
    // 同一フレーム内に複数 updateDragResize が来ても RAF キューには 1 件しか積まれない
    expect(rafQueue.length).toBe(1);

    // RAF コールバックを 1 度だけ実行
    act(() => {
      flushRaf();
    });

    // setDragPreviewBboxes は 1 回しか呼ばれない (coalesce)
    expect(setDragPreviewBboxes).toHaveBeenCalledTimes(1);
    // 重要: issue #91 — ドラッグ中は textBlocks 配列を触らない (updatePageData 不呼出)
    expect(updatePageData).not.toHaveBeenCalled();

    // 最新の pos (140,125) が反映されている: dragStart=(110,110) なので dx=30, dy=15
    const map = setDragPreviewBboxes.mock.calls[0][0] as Map<string, { x: number; y: number; width: number; height: number }>;
    expect(map.size).toBe(1);
    const previewBbox = map.get(block.id)!;
    expect(previewBbox.x).toBe(block.bbox.x + 30);
    expect(previewBbox.y).toBe(block.bbox.y + 15);
  });

  it('複数フレームに分かれた mousemove はフレーム毎に 1 回 setDragPreviewBboxes を呼ぶ (updatePageData は呼ばれない)', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // フレーム 1
    act(() => {
      result.current.updateDragResize({ x: 115, y: 112 });
      result.current.updateDragResize({ x: 120, y: 115 });
    });
    act(() => { flushRaf(); });

    // フレーム 2
    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 });
      result.current.updateDragResize({ x: 140, y: 125 });
    });
    act(() => { flushRaf(); });

    // 2 フレーム = 2 回の setDragPreviewBboxes、updatePageData は依然 0 回
    expect(setDragPreviewBboxes).toHaveBeenCalledTimes(2);
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('finishDragResize は保留中の RAF をキャンセルしつつ最新 pos を flush し、updatePageData は 1 回・undo は 1 回だけ積む', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // mousemove → RAF 未 flush のまま mouseup
    act(() => {
      result.current.updateDragResize({ x: 150, y: 130 });
    });
    expect(rafQueue.length).toBe(1);
    expect(updatePageData).not.toHaveBeenCalled();

    act(() => {
      result.current.finishDragResize();
    });

    // finishDragResize で 1 回だけ confirm 書き込み (issue #91)
    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [, partial] = updatePageData.mock.calls[0];
    expect(partial.textBlocks[0].bbox.x).toBe(block.bbox.x + 40); // dx = 150-110
    expect(partial.textBlocks[0].bbox.y).toBe(block.bbox.y + 20); // dy = 130-110
    expect(partial.isDirty).toBe(true);

    // RAF はキャンセル済み (queue が空)
    expect(rafQueue.length).toBe(0);

    // undo は 1 回だけ
    expect(pushAction).toHaveBeenCalledTimes(1);

    // dragPreviewBboxes はクリアされる
    const lastCall = setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1];
    expect(lastCall[0]).toBeNull();

    // RAF を後から flush しても二重に updatePageData は呼ばれない
    act(() => { flushRaf(); });
    expect(updatePageData).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// issue #91: ドラッグ中の O(N) コピー回避
// ─────────────────────────────────────────────────────────────
describe('useBlockDragResize: issue #91 ドラッグ中は textBlocks を触らない', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('updateDragResize 中は updatePageData が呼ばれず setDragPreviewBboxes のみ呼ばれる', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // 10 フレームに分けてドラッグ
    for (let i = 0; i < 10; i++) {
      act(() => {
        result.current.updateDragResize({ x: 110 + i, y: 110 + i });
      });
      act(() => { flushRaf(); });
    }

    // ドラッグ中は updatePageData は呼ばれない (= textBlocks 配列は変更されない)
    expect(updatePageData).not.toHaveBeenCalled();
    // setDragPreviewBboxes は 10 フレーム分呼ばれる
    expect(setDragPreviewBboxes).toHaveBeenCalledTimes(10);
  });

  it('finishDragResize で 1 回だけ confirm 書き込み (1 ドラッグ = 1 Action)', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // 多数のフレームに分けてドラッグ
    for (let i = 0; i < 50; i++) {
      act(() => {
        result.current.updateDragResize({ x: 110 + i, y: 110 + i });
      });
      act(() => { flushRaf(); });
    }

    // ドラッグ完了
    act(() => {
      result.current.finishDragResize();
    });

    // 50 フレーム分の mousemove → updatePageData は 1 回・pushAction は 1 回
    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(pushAction).toHaveBeenCalledTimes(1);

    // pushAction に渡された Action は before/after が PageData であること
    const action = pushAction.mock.calls[0][0];
    expect(action.type).toBe('update_page');
    expect(action.before).toBeDefined();
    expect(action.after).toBeDefined();
  });

  it('複数選択時の move ドラッグ: setDragPreviewBboxes に選択 BB 全件の bbox が入る', () => {
    const b1 = makeBlock({ id: 'b1', bbox: { x: 100, y: 100, width: 50, height: 20 } });
    const b2 = makeBlock({ id: 'b2', bbox: { x: 200, y: 200, width: 50, height: 20 } });
    const b3 = makeBlock({ id: 'b3', bbox: { x: 300, y: 300, width: 50, height: 20 } });
    const pageData = makePage([b1, b2, b3]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([b1.id, b2.id]), // b3 は選択外
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    // b1 内をクリック → move
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('move');

    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 });
    });
    act(() => { flushRaf(); });

    // 選択された 2 件のみ preview Map に入っている (b3 は入らない)
    expect(setDragPreviewBboxes).toHaveBeenCalled();
    const lastMap = setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0] as Map<string, { x: number; y: number; width: number; height: number }>;
    expect(lastMap.size).toBe(2);
    expect(lastMap.has('b1')).toBe(true);
    expect(lastMap.has('b2')).toBe(true);
    expect(lastMap.has('b3')).toBe(false);

    // dx=20, dy=10 が両方に同じだけ反映される
    expect(lastMap.get('b1')!.x).toBe(120);
    expect(lastMap.get('b1')!.y).toBe(110);
    expect(lastMap.get('b2')!.x).toBe(220);
    expect(lastMap.get('b2')!.y).toBe(210);

    // ドラッグ中は updatePageData は呼ばれない
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('finishDragResize は dragPreviewBboxes を null にクリアする', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData: vi.fn(),
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 });
    });
    act(() => { flushRaf(); });

    // ドラッグ中の Map が書き込まれた
    expect(setDragPreviewBboxes).toHaveBeenCalled();
    const midCall = setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0];
    expect(midCall).not.toBeNull();

    // 確定後はクリアされる
    act(() => {
      result.current.finishDragResize();
    });
    const lastCall = setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0];
    expect(lastCall).toBeNull();
  });
});

describe('useBlockDragResize: H-01 確定時は現行 bbox を基準にする', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('move 確定前に現行 bbox が差し替わってもドラッグ開始時 bbox へ巻き戻さない', () => {
    const block = makeBlock();
    let currentPage: PageData = makePage([block]);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => currentPage,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    act(() => {
      result.current.updateDragResize({ x: 150, y: 130 });
    });
    act(() => {
      flushRaf();
    });

    currentPage = makePage([
      makeBlock({ bbox: { x: 500, y: 600, width: 80, height: 20 } }),
    ]);

    act(() => {
      result.current.finishDragResize();
    });

    const updatedBlock = (updatePageData.mock.calls[0][1].textBlocks as TextBlock[])[0];
    expect(updatedBlock.bbox).toEqual({ x: 540, y: 620, width: 80, height: 20 });
    expect(updatedBlock.bbox).not.toEqual({ x: 140, y: 120, width: 80, height: 20 });
  });

  it('resize 確定前に現行 bbox が差し替わってもドラッグ開始時 bbox へ巻き戻さない', () => {
    const block = makeBlock();
    let currentPage: PageData = makePage([block]);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => currentPage,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 180, y: 120 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('resize-se');
    act(() => {
      result.current.updateDragResize({ x: 200, y: 140 });
    });
    act(() => {
      flushRaf();
    });

    currentPage = makePage([
      makeBlock({ bbox: { x: 300, y: 400, width: 10, height: 10 } }),
    ]);

    act(() => {
      result.current.finishDragResize();
    });

    const updatedBlock = (updatePageData.mock.calls[0][1].textBlocks as TextBlock[])[0];
    expect(updatedBlock.bbox).toEqual({ x: 300, y: 400, width: 30, height: 30 });
    expect(updatedBlock.bbox).not.toEqual({ x: 100, y: 100, width: 100, height: 40 });
  });
});

// ─────────────────────────────────────────────────────────────
// issue #106: Redo が効かない (Action.after が before と同じ snapshot)
// ─────────────────────────────────────────────────────────────
//
// 背景: PdfCanvas.tsx の getPageData は以前 `document?.pages.get(pageIndex)` という
//       render 時点の state を closure 保持する形だった。finishDragResize 内で
//       updatePageData() 直後に getPageData() を呼ぶと、closure は古い snapshot を
//       返すため Action.after が before と同じになり Redo が無効化されていた。
//       本テストは「getPageData が常に最新 state を返す」ことを再現し、Action.after
//       がドラッグ後 bbox を正しく持つことを保証する。
// ─────────────────────────────────────────────────────────────
describe('useBlockDragResize: issue #106 Redo round-trip (Action.after が最新 state を持つ)', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('finishDragResize 後の pushAction.before と after は別の bbox を持つ (Redo が有効)', () => {
    const block = makeBlock();
    // 「最新 state」を保持する可変な参照。updatePageData が呼ばれたら更新する。
    let currentPage: PageData = makePage([block]);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });
    const pushAction = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        // 修正後の PdfCanvas.tsx と同様、最新 state を毎回返す getPageData
        getPageData: () => currentPage,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes,
      })
    );

    // ドラッグ開始
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    act(() => {
      result.current.updateDragResize({ x: 150, y: 130 });
    });
    act(() => { flushRaf(); });
    act(() => {
      result.current.finishDragResize();
    });

    expect(pushAction).toHaveBeenCalledTimes(1);
    const action = pushAction.mock.calls[0][0];
    expect(action.type).toBe('update_page');

    // before: ドラッグ前の bbox
    const beforeBbox = action.before.textBlocks[0].bbox;
    expect(beforeBbox.x).toBe(100);
    expect(beforeBbox.y).toBe(100);

    // after: ドラッグ後の bbox (dx=40, dy=20)
    const afterBbox = action.after.textBlocks[0].bbox;
    expect(afterBbox.x).toBe(140);
    expect(afterBbox.y).toBe(120);

    // 回帰防止の本命: before と after が「同じ snapshot」になっていないこと
    // (closure stale だと両方とも beforeBbox になり Redo が無効化される)
    expect(afterBbox.x).not.toBe(beforeBbox.x);
    expect(afterBbox.y).not.toBe(beforeBbox.y);
  });

  it('回帰防止: stale な getPageData (旧 closure 実装) を渡すと Redo が破綻する (バグ再現)', () => {
    // 旧 PdfCanvas.tsx の挙動を模擬: getPageData は render 時の snapshot 参照を
    // 常に返し、updatePageData では実 store を更新しない。
    // 期待: action.after.bbox が action.before.bbox と同じになり Redo が無効化される。
    // これは「修正前の振る舞いを保存し、もし将来 closure 化に戻ったら検知する」役割。
    const block = makeBlock();
    const staleSnapshot = makePage([block]);
    const updatePageData = vi.fn(); // 実 store 更新を再現しない
    const pushAction = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => staleSnapshot, // 常に同じ snapshot 参照を返す
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    act(() => {
      result.current.updateDragResize({ x: 150, y: 130 });
    });
    act(() => { flushRaf(); });
    act(() => {
      result.current.finishDragResize();
    });

    expect(pushAction).toHaveBeenCalledTimes(1);
    const action = pushAction.mock.calls[0][0];
    const beforeBbox = action.before.textBlocks[0].bbox;
    const afterBbox = action.after.textBlocks[0].bbox;

    // バグ再現: stale な getPageData では after が before と同じ snapshot になる。
    // これが Redo 無効化の根本原因。修正は PdfCanvas 側で getPageData を
    // usePecoStore.getState() 化し最新 state を返すこと (issue #106)。
    expect(afterBbox.x).toBe(beforeBbox.x);
    expect(afterBbox.y).toBe(beforeBbox.y);
  });
});

// ─────────────────────────────────────────────────────────────
// getHoverCursor: ホバー位置からカーソル種別を決める純粋座標計算。
// リサイズハンドル (4 隅, 許容半径 hs=10px) / 移動領域 / 描画・分割モードの
// 判定はすべて zoom スケールに依存するため、ここを誤ると「ハンドルを掴めない」
// 「掴めるはずのない位置で掴める」回帰につながる。本体に既存テストが無かった。
// ─────────────────────────────────────────────────────────────
describe('useBlockDragResize: getHoverCursor (ハンドル判定の座標計算)', () => {
  beforeEach(() => {
    installRafMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  function renderHover(opts: {
    block: TextBlock;
    selectedIds: Set<string>;
    zoom?: number;
  }) {
    const pageData = makePage([opts.block]);
    return renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: opts.zoom ?? 100,
        selectedIds: opts.selectedIds,
        getPageData: () => pageData,
        updatePageData: vi.fn(),
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );
  }

  const normalOpts = { isDrawingMode: false, isSplitMode: false };

  it('選択 BB の 4 隅でそれぞれ対応するリサイズカーソルを返す (zoom=100)', () => {
    // bbox = (100,100,80,20) → 隅は (100,100)(180,100)(100,120)(180,120)
    const block = makeBlock();
    const { result } = renderHover({ block, selectedIds: new Set([block.id]) });

    expect(result.current.getHoverCursor({ x: 100, y: 100 }, normalOpts)).toBe('nw-resize');
    expect(result.current.getHoverCursor({ x: 180, y: 100 }, normalOpts)).toBe('ne-resize');
    expect(result.current.getHoverCursor({ x: 100, y: 120 }, normalOpts)).toBe('sw-resize');
    expect(result.current.getHoverCursor({ x: 180, y: 120 }, normalOpts)).toBe('se-resize');
  });

  it('ハンドル許容半径 (hs=10px) の内外で判定が切り替わる', () => {
    const block = makeBlock();
    const { result } = renderHover({ block, selectedIds: new Set([block.id]) });

    // 隅 (100,100) から 9px ずれ → まだハンドル内 (Math.abs<10)
    expect(result.current.getHoverCursor({ x: 109, y: 100 }, normalOpts)).toBe('nw-resize');
    // 10px ちょうどは境界外 (< 10 が条件) → ハンドルではなく BB 内部なので 'move'
    expect(result.current.getHoverCursor({ x: 110, y: 100 }, normalOpts)).toBe('move');
  });

  it('BB 内部 (ハンドル外) は move、BB 完全外は default', () => {
    const block = makeBlock();
    const { result } = renderHover({ block, selectedIds: new Set([block.id]) });

    // 中央付近 = move
    expect(result.current.getHoverCursor({ x: 140, y: 110 }, normalOpts)).toBe('move');
    // BB から完全に離れた点 = default
    expect(result.current.getHoverCursor({ x: 400, y: 400 }, normalOpts)).toBe('default');
  });

  it('zoom=200 ではハンドル座標も 2 倍にスケールする', () => {
    // bbox=(100,100,80,20)。zoom=200 → scale=2 なので nw 隅は screen 座標 (200,200)。
    const block = makeBlock();
    const { result } = renderHover({ block, selectedIds: new Set([block.id]), zoom: 200 });

    // zoom=100 の座標 (100,100) ではもうハンドルではない (BB 自体が外)
    expect(result.current.getHoverCursor({ x: 100, y: 100 }, normalOpts)).toBe('default');
    // スケール後の nw 隅 (200,200) でハンドル検出
    expect(result.current.getHoverCursor({ x: 200, y: 200 }, normalOpts)).toBe('nw-resize');
    // スケール後の se 隅 ((100+80)*2, (100+20)*2) = (360,240)
    expect(result.current.getHoverCursor({ x: 360, y: 240 }, normalOpts)).toBe('se-resize');
  });

  it('未選択 BB のハンドル/内部ではカーソルは反応しない (ハンドルは選択中のみ, 内部は move)', () => {
    const block = makeBlock();
    // selectedIds 空: resize ハンドルループは回らない
    const { result } = renderHover({ block, selectedIds: new Set() });

    // 隅でも resize にならず、BB 内部扱いで move (未選択でも move 判定はする)
    expect(result.current.getHoverCursor({ x: 100, y: 100 }, normalOpts)).toBe('move');
    expect(result.current.getHoverCursor({ x: 140, y: 110 }, normalOpts)).toBe('move');
  });

  it('描画モードでは常に crosshair (BB 位置に依らない)', () => {
    const block = makeBlock();
    const { result } = renderHover({ block, selectedIds: new Set([block.id]) });

    expect(
      result.current.getHoverCursor({ x: 100, y: 100 }, { isDrawingMode: true, isSplitMode: false })
    ).toBe('crosshair');
    expect(
      result.current.getHoverCursor({ x: 999, y: 999 }, { isDrawingMode: true, isSplitMode: false })
    ).toBe('crosshair');
  });

  it('分割モード: 横書き BB 上は col-resize、縦書き BB 上は row-resize、BB 外は crosshair', () => {
    const horiz = makeBlock({ id: 'h', writingMode: 'horizontal', bbox: { x: 100, y: 100, width: 80, height: 20 } });
    const { result: rh } = renderHover({ block: horiz, selectedIds: new Set() });
    expect(
      rh.current.getHoverCursor({ x: 140, y: 110 }, { isDrawingMode: false, isSplitMode: true })
    ).toBe('col-resize');
    // BB 外は crosshair
    expect(
      rh.current.getHoverCursor({ x: 500, y: 500 }, { isDrawingMode: false, isSplitMode: true })
    ).toBe('crosshair');

    const vert = makeBlock({ id: 'v', writingMode: 'vertical', bbox: { x: 100, y: 100, width: 20, height: 80 } });
    const { result: rv } = renderHover({ block: vert, selectedIds: new Set() });
    expect(
      rv.current.getHoverCursor({ x: 110, y: 140 }, { isDrawingMode: false, isSplitMode: true })
    ).toBe('row-resize');
  });
});

// ─────────────────────────────────────────────────────────────
// リサイズ 4 方向の座標計算と最小サイズクランプ。
// 既存テストは resize-se の最小クランプのみ。nw/ne/sw は x/y の移動と
// width/height の符号 (start ± dx/dy) が方向ごとに異なるため、
// それぞれ独立した回帰対象になる。
// ─────────────────────────────────────────────────────────────
describe('useBlockDragResize: resize 4 方向の bbox 計算', () => {
  beforeEach(() => {
    installRafMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  /** 指定ハンドルから dx,dy 動かして finishDragResize し、確定 bbox を返す */
  function resizeAndGetBbox(opts: {
    block: TextBlock;
    handle: { x: number; y: number };
    move: { x: number; y: number };
    expectedMode: string;
  }) {
    const pageData = makePage([opts.block]);
    const updatePageData = vi.fn();
    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([opts.block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes: vi.fn(),
      })
    );
    act(() => {
      result.current.tryStartDragOrResize(opts.handle, { ctrlKey: false, metaKey: false, shiftKey: false });
    });
    expect(result.current.dragMode).toBe(opts.expectedMode);
    act(() => {
      result.current.updateDragResize(opts.move);
    });
    act(() => { flushRaf(); });
    act(() => {
      result.current.finishDragResize();
    });
    return updatePageData.mock.calls[0][1].textBlocks[0].bbox as {
      x: number; y: number; width: number; height: number;
    };
  }

  it('resize-nw: 左上ハンドルを左上へ動かすと x,y が減り width,height が増える', () => {
    // bbox=(100,100,80,20), nw 隅=(100,100)。(80,90) へ → dx=-20, dy=-10
    const bbox = resizeAndGetBbox({
      block: makeBlock(),
      handle: { x: 100, y: 100 },
      move: { x: 80, y: 90 },
      expectedMode: 'resize-nw',
    });
    expect(bbox.x).toBe(80);              // 100 + dx(-20)
    expect(bbox.y).toBe(90);              // 100 + dy(-10)
    expect(bbox.width).toBe(100);         // 80 - dx(-20)
    expect(bbox.height).toBe(30);         // 20 - dy(-10)
  });

  it('resize-ne: 右上ハンドルを右上へ動かすと y が減り width,height が増える (x は不変)', () => {
    // bbox=(100,100,80,20), ne 隅=(180,100)。(200,90) へ → dx=+20, dy=-10
    const bbox = resizeAndGetBbox({
      block: makeBlock(),
      handle: { x: 180, y: 100 },
      move: { x: 200, y: 90 },
      expectedMode: 'resize-ne',
    });
    expect(bbox.x).toBe(100);             // 不変
    expect(bbox.y).toBe(90);              // 100 + dy(-10)
    expect(bbox.width).toBe(100);         // 80 + dx(+20)
    expect(bbox.height).toBe(30);         // 20 - dy(-10)
  });

  it('resize-sw: 左下ハンドルを左下へ動かすと x が減り width,height が増える (y は不変)', () => {
    // bbox=(100,100,80,20), sw 隅=(100,120)。(80,140) へ → dx=-20, dy=+20
    const bbox = resizeAndGetBbox({
      block: makeBlock(),
      handle: { x: 100, y: 120 },
      move: { x: 80, y: 140 },
      expectedMode: 'resize-sw',
    });
    expect(bbox.x).toBe(80);              // 100 + dx(-20)
    expect(bbox.y).toBe(100);             // 不変
    expect(bbox.width).toBe(100);         // 80 - dx(-20)
    expect(bbox.height).toBe(40);         // 20 + dy(+20)
  });

  it('resize-nw を逆方向へ大きく動かしても width/height は 1 未満にならず x/y は反対辺-1 でクランプ', () => {
    // bbox=(100,100,80,20)。nw ハンドルを右下へ大きく動かす: (500,500) へ
    // → dx=+400, dy=+400。width=80-400 が負 → Math.max(1,...) で 1。
    //   x は Math.min(startX+width-1, startX+dx) = min(179, 500) = 179。
    const bbox = resizeAndGetBbox({
      block: makeBlock(),
      handle: { x: 100, y: 100 },
      move: { x: 500, y: 500 },
      expectedMode: 'resize-nw',
    });
    expect(bbox.width).toBe(1);
    expect(bbox.height).toBe(1);
    expect(bbox.x).toBe(179);             // 100 + 80 - 1
    expect(bbox.y).toBe(119);             // 100 + 20 - 1
  });
});

// ─────────────────────────────────────────────────────────────
// bug-hunt round3 Wave4 (HIGH): Space 押下 (disableDrawing) 中のドラッグ迷子化。
//
// 背景: PdfCanvas.tsx の handleMouseMove/Up は disableDrawing=true (Space 押下中の
//       パン操作) のとき早期 return するため、ドラッグ中に Space を押すと
//       finishDragResize が呼ばれず dragMode/draggedId が残留する。Space 解放後は
//       disableDrawing=false に戻る一方でドラッグ状態は残ったままなので、
//       ボタンを押していない mousemove でも BB がマウスに追従し続ける
//       「迷子ドラッグ」になる。
//
// 対策: (1) cancelDragResize でドラッグを開始前の状態へ巻き戻す (PdfCanvas 側で
//       disableDrawing の false→true 遷移時に呼ぶ)。(2) updateDragResize 冒頭で
//       event.buttons===0 を検知したら自動キャンセルする多層防御 (Space 以外の
//       取りこぼし、例: canvas 外での mouseup にも効く)。
// ─────────────────────────────────────────────────────────────
describe('useBlockDragResize: bug-hunt round3 Wave4 (Space 押下中のドラッグ迷子化対策)', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('cancelDragResize: ドラッグ中に呼ぶと commit せず preview をクリアし dragMode/draggedId を初期化する', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('move');

    // ドラッグ中 (プレビューが 1 度書き込まれた状態)
    act(() => {
      result.current.updateDragResize({ x: 150, y: 130 });
    });
    act(() => { flushRaf(); });
    expect(setDragPreviewBboxes).toHaveBeenCalled();
    expect(setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0]).not.toBeNull();

    // Space 押下相当: キャンセル
    act(() => {
      result.current.cancelDragResize();
    });

    // commit されない (updatePageData/pushAction は呼ばれない)
    expect(updatePageData).not.toHaveBeenCalled();
    expect(pushAction).not.toHaveBeenCalled();
    // プレビューはクリアされる
    expect(setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0]).toBeNull();
    // ドラッグ状態は初期化される
    expect(result.current.dragMode).toBe('none');
    expect(result.current.draggedId).toBeNull();
    // 保留中の RAF もキャンセルされている
    expect(rafQueue.length).toBe(0);

    // キャンセル後に RAF を無理やり flush しても何も起きない (保留 pos が残っていないこと)
    act(() => { flushRaf(); });
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('updateDragResize: buttons===0 で呼ばれると自動的にキャンセルされ false を返す (多層防御)', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('move');

    // 正常なドラッグ (buttons=1) で一度プレビューを書き込む
    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 }, 1);
    });
    act(() => { flushRaf(); });
    expect(setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0]).not.toBeNull();

    // ボタンが離れている (buttons=0) 状態で mousemove が来た場合、
    // ドラッグを継続せず即座にキャンセルする。戻り値は false (未処理扱い)。
    let handled = true;
    act(() => {
      handled = result.current.updateDragResize({ x: 300, y: 300 }, 0);
    });

    expect(handled).toBe(false);
    expect(result.current.dragMode).toBe('none');
    expect(result.current.draggedId).toBeNull();
    expect(setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0]).toBeNull();
    // buttons===0 の分岐は RAF をスケジュールしない
    expect(rafQueue.length).toBe(0);
    // commit もされない
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('updateDragResize: buttons 引数を渡さない (undefined) 場合は従来どおり動作する (呼び出し互換)', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const setDragPreviewBboxes = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData: vi.fn(),
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
        setDragPreviewBboxes,
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    let handled = false;
    act(() => {
      handled = result.current.updateDragResize({ x: 130, y: 120 });
    });
    act(() => { flushRaf(); });

    expect(handled).toBe(true);
    expect(result.current.dragMode).toBe('move'); // buttons 未指定ではキャンセルされない
    expect(setDragPreviewBboxes.mock.calls[setDragPreviewBboxes.mock.calls.length - 1][0]).not.toBeNull();
  });
});

describe('useBlockDragResize: 厳格化 - 複数選択と全リサイズハンドル', () => {
  beforeEach(() => {
    installRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rafQueue = [];
  });

  it('複数選択BBのmove確定は選択BBだけを同じdx/dyで更新し、1 ActionでUndo/Redo可能なafterを積む', () => {
    const b1 = makeBlock({ id: 'b1', bbox: { x: 100, y: 100, width: 50, height: 20 } });
    const b2 = makeBlock({ id: 'b2', bbox: { x: 200, y: 200, width: 60, height: 25 } });
    const b3 = makeBlock({ id: 'b3', bbox: { x: 300, y: 300, width: 70, height: 30 } });
    let currentPage = makePage([b1, b2, b3]);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });
    const pushAction = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set(['b1', 'b2']),
        getPageData: () => currentPage,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes: vi.fn(),
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        { x: 125, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    act(() => {
      result.current.updateDragResize({ x: 155, y: 130 });
    });
    act(() => {
      flushRaf();
    });
    act(() => {
      result.current.finishDragResize();
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(pushAction).toHaveBeenCalledTimes(1);
    const updatedBlocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    expect(updatedBlocks.find((b) => b.id === 'b1')!.bbox).toEqual({ x: 130, y: 120, width: 50, height: 20 });
    expect(updatedBlocks.find((b) => b.id === 'b2')!.bbox).toEqual({ x: 230, y: 220, width: 60, height: 25 });
    expect(updatedBlocks.find((b) => b.id === 'b3')!.bbox).toEqual(b3.bbox);

    const action = pushAction.mock.calls[0][0];
    expect(action.before.textBlocks.find((b: TextBlock) => b.id === 'b1')!.bbox).toEqual(b1.bbox);
    expect(action.after.textBlocks.find((b: TextBlock) => b.id === 'b1')!.bbox).toEqual({ x: 130, y: 120, width: 50, height: 20 });
    expect(action.after.textBlocks.find((b: TextBlock) => b.id === 'b2')!.bbox).toEqual({ x: 230, y: 220, width: 60, height: 25 });
    expect(action.after.textBlocks.find((b: TextBlock) => b.id === 'b3')!.bbox).toEqual(b3.bbox);
  });

  it.each([
    {
      label: 'resize-nw',
      start: { x: 100, y: 100 },
      end: { x: 250, y: 140 },
      expected: { x: 179, y: 119, width: 1, height: 1 },
    },
    {
      label: 'resize-ne',
      start: { x: 180, y: 100 },
      end: { x: 200, y: 140 },
      expected: { x: 100, y: 119, width: 100, height: 1 },
    },
    {
      label: 'resize-sw',
      start: { x: 100, y: 120 },
      end: { x: 190, y: 140 },
      expected: { x: 179, y: 100, width: 1, height: 40 },
    },
  ])('$label は反対角を越えてもwidth/heightを1以上に保って1 Actionだけ積む', ({ label, start, end, expected }) => {
    const block = makeBlock();
    let currentPage = makePage([block]);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });
    const pushAction = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => currentPage,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction,
        setDragPreviewBboxes: vi.fn(),
      })
    );

    act(() => {
      result.current.tryStartDragOrResize(
        start,
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe(label);

    act(() => {
      result.current.updateDragResize(end);
    });
    act(() => {
      flushRaf();
    });
    act(() => {
      result.current.finishDragResize();
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(pushAction).toHaveBeenCalledTimes(1);
    const updatedBlock = (updatePageData.mock.calls[0][1].textBlocks as TextBlock[])[0];
    expect(updatedBlock.bbox).toEqual(expected);
    expect(updatedBlock.bbox.width).toBeGreaterThanOrEqual(1);
    expect(updatedBlock.bbox.height).toBeGreaterThanOrEqual(1);
    expect(updatePageData.mock.calls[0][1].isDirty).toBe(true);
  });
});
