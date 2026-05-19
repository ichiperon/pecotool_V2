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
