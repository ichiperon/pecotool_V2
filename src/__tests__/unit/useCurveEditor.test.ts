/**
 * Integration tests for useCurveEditor hook (test gap fill wave 6)
 *
 * Coverage scenarios:
 *   1. canvasToViewport coordinate conversion
 *   2. arc 3-click creation flow: 1st/2nd click collects points, 3rd click creates arc
 *   3. arc 3-click: collinear 3 points → arc not created, points reset
 *   4. polyline creation: double-click starts draft, subsequent clicks add points,
 *      second double-click confirms polyline
 *   5. polyline creation: Enter key confirms, Escape key cancels
 *   6. hitTestCurveHandle: hit and miss scenarios
 *   7. handle drag (mouseDown + mouseMove + mouseUp lifecycle)
 *   8. isCurveMode=false → handlers return false without side effects
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject, MutableRefObject } from 'react';
import { useCurveEditor } from '../../hooks/useCurveEditor';
import type { UseCurveEditorParams } from '../../hooks/useCurveEditor';
import type { PageData, TextBlock, CurveDefinition } from '../../types';

// #431 FB-5: curve handle drag の mousemove は RAF に coalesce されるため、
// テストでは手動制御可能な requestAnimationFrame mock を入れて 1 フレーム進める
// ユーティリティを用意する (useBlockDragResize.test.ts と同じパターン)。
type RafCallback = (t: number) => void;
let rafQueue: Array<{ id: number; cb: RafCallback }> = [];
let rafCounter = 0;

function installRafMock() {
  rafQueue = [];
  rafCounter = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafCounter;
    rafQueue.push({ id, cb: cb as RafCallback });
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

beforeEach(() => {
  installRafMock();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, curve?: CurveDefinition): TextBlock {
  return {
    id,
    text: 'hello',
    originalText: 'hello',
    bbox: { x: 10, y: 10, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    curve,
  };
}

function makePageData(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  };
}

function makeParams(
  overrides: Partial<UseCurveEditorParams> = {},
): UseCurveEditorParams {
  const getPageData = vi.fn(() => undefined as PageData | undefined);
  const updatePageData = vi.fn();
  const pushAction = vi.fn();

  const overlayCanvasRef: RefObject<HTMLCanvasElement | null> = {
    current: {
      style: { cursor: '' },
    } as unknown as HTMLCanvasElement,
  };
  const renderOverlaysRef: RefObject<(() => void) | null> = { current: null };
  const overlayRafRef: MutableRefObject<number | null> = { current: null };

  return {
    pageIndex: 0,
    zoom: 100,
    isCurveMode: true,
    selectedIds: new Set(['block1']),
    currentTextBlocksById: new Map([['block1', makeTextBlock('block1')]]),
    getPageData,
    updatePageData,
    pushAction,
    overlayCanvasRef,
    renderOverlaysRef,
    overlayRafRef,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useCurveEditor — canvasToViewport', () => {
  it('divides by zoom scale (zoom=200 → coordinates halved)', () => {
    const params = makeParams({ zoom: 200 });
    const { result } = renderHook(() => useCurveEditor(params));
    const vp = result.current.canvasToViewport({ x: 100, y: 80 });
    expect(vp).toEqual({ x: 50, y: 40 });
  });

  it('identity when zoom=100', () => {
    const params = makeParams({ zoom: 100 });
    const { result } = renderHook(() => useCurveEditor(params));
    expect(result.current.canvasToViewport({ x: 50, y: 30 })).toEqual({ x: 50, y: 30 });
  });

  it('multiplies by inverse scale when zoom=50 (coordinates doubled)', () => {
    const params = makeParams({ zoom: 50 });
    const { result } = renderHook(() => useCurveEditor(params));
    expect(result.current.canvasToViewport({ x: 50, y: 75 })).toEqual({ x: 100, y: 150 });
  });

  it('divides by scale when zoom=150 (non-integer scale factor)', () => {
    const params = makeParams({ zoom: 150 });
    const { result } = renderHook(() => useCurveEditor(params));
    const vp = result.current.canvasToViewport({ x: 150, y: 300 });
    expect(vp.x).toBeCloseTo(100);
    expect(vp.y).toBeCloseTo(200);
  });

  it('round-trips through pdfToCanvas-equivalent scale for zoom!=100', () => {
    // canvasToViewport(pos, zoom) is the inverse of `pos * (zoom/100)`.
    // Applying the forward scale then canvasToViewport must return the original point.
    const params = makeParams({ zoom: 220 });
    const { result } = renderHook(() => useCurveEditor(params));
    const original = { x: 123.456, y: 789.012 };
    const scale = 220 / 100;
    const canvasPos = { x: original.x * scale, y: original.y * scale };
    const back = result.current.canvasToViewport(canvasPos);
    expect(back.x).toBeCloseTo(original.x, 5);
    expect(back.y).toBeCloseTo(original.y, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — arc 3-click creation', () => {
  it('first click adds to curveClickPoints, returns true', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = false;
    act(() => {
      handled = result.current.handleMouseDownCurve({ x: 10, y: 20 });
    });

    expect(handled).toBe(true);
    expect(result.current.curveClickPoints).toHaveLength(1);
    expect(result.current.curveClickPoints[0]).toEqual({ x: 10, y: 20 });
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('second click adds second point', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    // Each click must be in a separate act so React state flushes between calls
    act(() => { result.current.handleMouseDownCurve({ x: 10, y: 20 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 50, y: 10 }); });

    expect(result.current.curveClickPoints).toHaveLength(2);
  });

  it('third click with non-collinear points creates arc and resets click points', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    // 3 points forming a non-collinear triangle — separate acts so state flushes
    act(() => { result.current.handleMouseDownCurve({ x: 0, y: 0 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 50, y: 50 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 100, y: 0 }); });

    // Arc created → click points reset
    expect(result.current.curveClickPoints).toHaveLength(0);
    // updatePageData called with new arc curve
    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [, partial, pushUndo] = updatePageData.mock.calls[0];
    expect(pushUndo).toBe(true);
    const newBlock = partial.textBlocks?.find((b: TextBlock) => b.id === 'block1');
    expect(newBlock?.curve?.type).toBe('arc');
  });

  it('third click with collinear points resets without creating arc', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    // 3 collinear points — separate acts so state flushes
    act(() => { result.current.handleMouseDownCurve({ x: 0, y: 0 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 10, y: 10 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 20, y: 20 }); });

    // Points reset, no arc created
    expect(result.current.curveClickPoints).toHaveLength(0);
    expect(updatePageData).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — polyline creation flow', () => {
  it('double-click starts polyline draft with first point', () => {
    const params = makeParams();
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = false;
    act(() => {
      handled = result.current.handleDoubleClickCurve({ x: 30, y: 40 });
    });

    expect(handled).toBe(true);
    expect(result.current.polylineDraftActive).toBe(true);
    expect(result.current.polylineDraftPoints).toHaveLength(1);
  });

  it('subsequent clicks during draft add points', () => {
    const params = makeParams();
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 30, y: 40 });
    });
    // Advance lastDoubleClickTimeRef timestamp to bypass 300ms guard
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 60, y: 70 });
    });

    expect(result.current.polylineDraftPoints).toHaveLength(2);
  });

  it('double-click at zoom=200 records viewport-scale point, not raw canvas coords (#409 regression guard)', () => {
    // Regression guard for issue #409 (PCT-178): polyline draft points must be
    // stored in viewport (zoom-independent) space via canvasToViewport, so that
    // a curve created while zoomed reproduces the same PDF-space geometry as
    // one created at zoom=100. If the scale division regresses (e.g. dropped
    // or inverted), this assertion catches it directly on the production hook.
    const params = makeParams({ zoom: 200 });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 200, y: 400 });
    });

    expect(result.current.polylineDraftPoints).toHaveLength(1);
    expect(result.current.polylineDraftPoints[0]).toEqual({ x: 100, y: 200 });
  });

  it('polyline confirmed at zoom=50 stores viewport-scale points in the curve definition (#409 regression guard)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ zoom: 50, getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 50, y: 75 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 100, y: 150 });
    });
    act(() => {
      result.current.handleDoubleClickCurve({ x: 150, y: 225 });
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [, partial] = updatePageData.mock.calls[0];
    const newBlock = partial.textBlocks?.find((b: TextBlock) => b.id === 'block1');
    expect(newBlock?.curve).toEqual({
      type: 'polyline',
      points: [
        { x: 100, y: 150 },
        { x: 200, y: 300 },
      ],
    });
  });

  it('second double-click confirms polyline draft', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 30, y: 40 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 80, y: 90 });
    });
    // Second double-click confirms
    act(() => {
      result.current.handleDoubleClickCurve({ x: 100, y: 110 });
    });

    expect(result.current.polylineDraftActive).toBe(false);
    expect(result.current.polylineDraftPoints).toHaveLength(0);
    expect(updatePageData).toHaveBeenCalledTimes(1);
    const [, partial] = updatePageData.mock.calls[0];
    const newBlock = partial.textBlocks?.find((b: TextBlock) => b.id === 'block1');
    expect(newBlock?.curve?.type).toBe('polyline');
  });

  it('Enter key confirms active polyline draft', async () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 50, y: 50 });
    });

    // Simulate Enter key
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(result.current.polylineDraftActive).toBe(false);
    expect(updatePageData).toHaveBeenCalled();
  });

  it('Escape key cancels active polyline draft without saving', async () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 50, y: 50 });
    });

    // Simulate Escape key
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(result.current.polylineDraftActive).toBe(false);
    expect(result.current.polylineDraftPoints).toHaveLength(0);
    expect(updatePageData).not.toHaveBeenCalled();
  });

  // #434 F3: window レベルの Enter/Escape リスナーは元々入力要素ガードが無く、
  // OcrCard の textarea 編集中に Enter を押すと改行のはずが draft が確定してしまっていた。
  it('Enter key while a textarea is focused does not confirm the draft (text input takes priority)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 50, y: 50 });
    });
    expect(result.current.polylineDraftActive).toBe(true);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(result.current.polylineDraftActive).toBe(true);
    expect(updatePageData).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  // Escape も同様に textarea 編集中は draft のキャンセルに奪われないことを確認する。
  it('Escape key while a textarea is focused does not cancel the draft', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 50, y: 50 });
    });
    expect(result.current.polylineDraftActive).toBe(true);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(result.current.polylineDraftActive).toBe(true);
    expect(result.current.polylineDraftPoints.length).toBeGreaterThan(0);

    document.body.removeChild(textarea);
  });

  // IME 変換確定の Enter (isComposing=true) も draft を確定させないことを確認する。
  it('Enter key during IME composition does not confirm the draft', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 50, y: 50 });
    });
    expect(result.current.polylineDraftActive).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    });

    expect(result.current.polylineDraftActive).toBe(true);
    expect(updatePageData).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — hitTestCurveHandle', () => {
  it('returns null when isCurveMode is false', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const params = makeParams({
      isCurveMode: false,
      currentTextBlocksById: new Map([['block1', block]]),
    });
    const { result } = renderHook(() => useCurveEditor(params));
    expect(result.current.hitTestCurveHandle({ x: 80, y: 50 })).toBeNull();
  });

  it('returns handle info when click is within HIT_RADIUS of arc handle', () => {
    // arc: center=(50,50), radius=30, startAngle=0 → start handle at (80,50)
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));
    // Start handle at canvas coords (80*scale, 50*scale) = (80, 50) when zoom=100
    const hit = result.current.hitTestCurveHandle({ x: 80, y: 50 });
    expect(hit).not.toBeNull();
    expect(hit?.blockId).toBe('block1');
    expect(hit?.handleIndex).toBe(0);
  });

  it('returns null when click misses all handles', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
    });
    const { result } = renderHook(() => useCurveEditor(params));
    // Far from all handles
    const hit = result.current.hitTestCurveHandle({ x: 0, y: 0 });
    expect(hit).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — handle drag lifecycle', () => {
  it('mouseDown on handle sets curveHandleDragRef', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleMouseDownCurve({ x: 80, y: 50 });
    });

    expect(result.current.curveHandleDragRef.current).not.toBeNull();
    expect(result.current.curveHandleDragRef.current?.handleIndex).toBe(0);
    expect(result.current.curveHandleDragRef.current?.blockId).toBe('block1');
  });

  it('mouseMove during drag calls updatePageData with undoable=false', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      getPageData,
      updatePageData,
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    // Start drag on start handle
    act(() => {
      result.current.handleMouseDownCurve({ x: 80, y: 50 });
    });
    // Move to new position — #431 FB-5: the actual updatePageData call is
    // coalesced into a RAF callback, so it only fires once the frame flushes.
    act(() => {
      result.current.handleMouseMoveCurve({ x: 90, y: 55 });
    });
    act(() => {
      flushRaf();
    });

    expect(updatePageData).toHaveBeenCalled();
    const lastCall = updatePageData.mock.calls[updatePageData.mock.calls.length - 1];
    expect(lastCall[2]).toBe(false); // undoable=false during drag
  });

  // #356 (PCT-133): 以前は mouseUp の最終書き込みを undoable=true にしていたため
  // pecoStore の undo エントリの before がドラッグ後の状態を指してしまい undo が
  // 効かなかった。修正後は useBlockDragResize と同じく、mouseUp の書き込みは
  // すべて undoable=false にし、before/after を手動構築した 1 件の Action を
  // pushAction で積む。
  it('mouseUp after drag: final write is undoable=false and pushes exactly one undo Action, and clears dragRef', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };
    const block = makeTextBlock('block1', arc);
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      getPageData,
      updatePageData,
      pushAction,
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => {
      result.current.handleMouseDownCurve({ x: 80, y: 50 });
    });
    act(() => {
      result.current.handleMouseMoveCurve({ x: 90, y: 55 });
    });
    act(() => {
      result.current.handleMouseUpCurve();
    });

    expect(result.current.curveHandleDragRef.current).toBeNull();
    // Every updatePageData call during the drag lifecycle (including the
    // mouseUp confirm write) must be undoable=false — the undo Action is
    // pushed separately via pushAction, not via updatePageData's own pushUndo.
    for (const call of updatePageData.mock.calls) {
      expect(call[2]).toBe(false);
    }
    expect(pushAction).toHaveBeenCalledTimes(1);
    const action = pushAction.mock.calls[0][0];
    expect(action.type).toBe('update_page');
    expect(action.before).toBeDefined();
    expect(action.after).toBeDefined();
  });

  // #431 FB-5: curve handle drag の mousemove が RAF に coalesce され、
  // useBlockDragResize (#91/#172) と対称に「1フレームにつき1回」の
  // updatePageData 呼び出しになることを実測で縛る。
  describe('#431 FB-5: RAF coalescing during handle drag', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 50, y: 50 },
      radius: 30,
      startAngle: 0,
      endAngle: Math.PI,
    };

    it('multiple mousemove calls within the same frame produce only 1 updatePageData call after flush', () => {
      const block = makeTextBlock('block1', arc);
      const page = makePageData([block]);
      const getPageData = vi.fn(() => page);
      const updatePageData = vi.fn();
      const params = makeParams({
        currentTextBlocksById: new Map([['block1', block]]),
        getPageData,
        updatePageData,
        zoom: 100,
      });
      const { result } = renderHook(() => useCurveEditor(params));

      act(() => {
        result.current.handleMouseDownCurve({ x: 80, y: 50 });
      });

      // Simulate several mousemove events firing before the browser paints
      // a frame (the RAF callback has not run yet — coalesced).
      act(() => {
        result.current.handleMouseMoveCurve({ x: 82, y: 51 });
        result.current.handleMouseMoveCurve({ x: 85, y: 53 });
        result.current.handleMouseMoveCurve({ x: 90, y: 55 });
      });

      // Not yet flushed: no updatePageData call from drag should have fired.
      expect(updatePageData).not.toHaveBeenCalled();

      act(() => {
        flushRaf();
      });

      // Exactly 1 call for the whole burst of mousemove events (coalesced),
      // and it reflects the *latest* position (x:90,y:55), not an
      // intermediate one.
      expect(updatePageData).toHaveBeenCalledTimes(1);
      const [, partial, undoable] = updatePageData.mock.calls[0];
      expect(undoable).toBe(false);
      const newBlock = partial.textBlocks?.find((b: TextBlock) => b.id === 'block1');
      expect(newBlock?.curve?.type).toBe('arc');
    });

    it('mouseUp before the RAF flushes still applies the latest pending position (no dropped final move)', () => {
      const block = makeTextBlock('block1', arc);
      const page = makePageData([block]);
      const getPageData = vi.fn(() => page);
      const updatePageData = vi.fn();
      const pushAction = vi.fn();
      const params = makeParams({
        currentTextBlocksById: new Map([['block1', block]]),
        getPageData,
        updatePageData,
        pushAction,
        zoom: 100,
      });
      const { result } = renderHook(() => useCurveEditor(params));

      act(() => {
        result.current.handleMouseDownCurve({ x: 80, y: 50 });
      });
      act(() => {
        result.current.handleMouseMoveCurve({ x: 90, y: 55 });
      });
      // mouseUp fires before the queued RAF callback runs (fast drag release).
      // The drag-position update must still be applied synchronously (flushed
      // pending pos), and the confirm write that follows is also undoable=false
      // — the single undo Action is pushed via pushAction (#356).
      act(() => {
        result.current.handleMouseUpCurve();
      });

      expect(updatePageData.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of updatePageData.mock.calls) {
        expect(call[2]).toBe(false);
      }
      expect(pushAction).toHaveBeenCalledTimes(1);
      // No RAF should remain queued after mouseUp flushes it.
      expect(rafQueue.length).toBe(0);
    });
  });

  it('mouseUp when not dragging returns false', () => {
    const params = makeParams();
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = false;
    act(() => {
      handled = result.current.handleMouseUpCurve();
    });
    expect(handled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #356 (PCT-133): curve ハンドルドラッグの undo が壊れていた regression guard。
// mousemove 中は undoable=false で逐次書き込み、mouseUp で「最新状態をそのまま
// undoable=true で再書き込み」していたため、pecoStore が undo エントリの before
// に取る「直前の oldPage」が既にドラッグ後の状態になり、before=after 同値で
// undo が効かなかった (100% 再現)。useBlockDragResize と同じ preDragPageRef +
// 手動 pushAction 方式に揃えた修正の効果を、ここでは stateful mock
// (getPageData が updatePageData の書き込みを反映する) で検証する。
describe('useCurveEditor — #356 (PCT-133) handle drag undo correctness', () => {
  function makeStatefulPageMock(initialBlocks: TextBlock[]) {
    let currentPage = makePageData(initialBlocks);
    const getPageData = vi.fn(() => currentPage);
    const updatePageData = vi.fn((_idx: number, partial: Partial<PageData>) => {
      currentPage = { ...currentPage, ...partial };
    });
    return { getPageData, updatePageData, getCurrentPage: () => currentPage };
  }

  const arc: CurveDefinition = {
    type: 'arc',
    center: { x: 50, y: 50 },
    radius: 30,
    startAngle: 0,
    endAngle: Math.PI,
  };

  it('pushes an Action whose before.curve is the pre-drag shape and after.curve is the dragged shape (before !== after)', () => {
    const block = makeTextBlock('block1', arc);
    const { getPageData, updatePageData } = makeStatefulPageMock([block]);
    const pushAction = vi.fn();
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      getPageData,
      updatePageData,
      pushAction,
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    // Grab the arc's start handle (index 0) and drag it to a new position.
    act(() => { result.current.handleMouseDownCurve({ x: 80, y: 50 }); });
    act(() => { result.current.handleMouseMoveCurve({ x: 90, y: 55 }); });
    act(() => { flushRaf(); });
    act(() => { result.current.handleMouseUpCurve(); });

    expect(pushAction).toHaveBeenCalledTimes(1);
    const action = pushAction.mock.calls[0][0];
    const beforeCurve = action.before.textBlocks.find((b: TextBlock) => b.id === 'block1').curve;
    const afterCurve = action.after.textBlocks.find((b: TextBlock) => b.id === 'block1').curve;

    // before must be the untouched pre-drag arc (the bug's failure mode was
    // before === after, which made undo a no-op).
    expect(beforeCurve).toEqual(arc);
    expect(afterCurve).not.toEqual(beforeCurve);
  });

  it('a single handle drag (mousedown → several mousemoves → mouseup) pushes exactly 1 undo Action', () => {
    const block = makeTextBlock('block1', arc);
    const { getPageData, updatePageData } = makeStatefulPageMock([block]);
    const pushAction = vi.fn();
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      getPageData,
      updatePageData,
      pushAction,
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleMouseDownCurve({ x: 80, y: 50 }); });
    // Several intermediate mousemove ticks during the same drag — none of
    // these (nor the RAF-coalesced updatePageData calls behind them) may
    // push their own undo Action; only the final mouseUp does.
    act(() => { result.current.handleMouseMoveCurve({ x: 82, y: 51 }); });
    act(() => { flushRaf(); });
    act(() => { result.current.handleMouseMoveCurve({ x: 86, y: 53 }); });
    act(() => { flushRaf(); });
    act(() => { result.current.handleMouseMoveCurve({ x: 90, y: 55 }); });
    act(() => { flushRaf(); });
    act(() => { result.current.handleMouseUpCurve(); });

    expect(pushAction).toHaveBeenCalledTimes(1);
  });

  it('undo restores the pre-drag curve: applying action.before back onto the page yields the original shape', () => {
    // This does not exercise pecoStore.undo() directly (out of this hook's
    // scope), but confirms the Action carries what pecoStore.undo() needs:
    // setting the page to action.before must reproduce the exact pre-drag
    // block (curve unchanged, same reference-equal object).
    const block = makeTextBlock('block1', arc);
    const { getPageData, updatePageData } = makeStatefulPageMock([block]);
    const pushAction = vi.fn();
    const params = makeParams({
      currentTextBlocksById: new Map([['block1', block]]),
      getPageData,
      updatePageData,
      pushAction,
      zoom: 100,
    });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleMouseDownCurve({ x: 80, y: 50 }); });
    act(() => { result.current.handleMouseMoveCurve({ x: 90, y: 55 }); });
    act(() => { flushRaf(); });
    act(() => { result.current.handleMouseUpCurve(); });

    const action = pushAction.mock.calls[0][0];
    const restoredBlock = action.before.textBlocks.find((b: TextBlock) => b.id === 'block1');
    expect(restoredBlock.curve).toEqual(arc);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — isCurveMode=false guard', () => {
  it('handleMouseDownCurve returns false when isCurveMode=false', () => {
    const params = makeParams({ isCurveMode: false });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = true;
    act(() => {
      handled = result.current.handleMouseDownCurve({ x: 10, y: 10 });
    });
    expect(handled).toBe(false);
  });

  it('handleDoubleClickCurve returns false when isCurveMode=false', () => {
    const params = makeParams({ isCurveMode: false });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = true;
    act(() => {
      handled = result.current.handleDoubleClickCurve({ x: 10, y: 10 });
    });
    expect(handled).toBe(false);
  });

  it('handleMouseMoveCurve returns false when not dragging and isCurveMode=false', () => {
    const params = makeParams({ isCurveMode: false });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = true;
    act(() => {
      handled = result.current.handleMouseMoveCurve({ x: 10, y: 10 });
    });
    expect(handled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('useCurveEditor — selectedIds.size !== 1 guard', () => {
  it('handleMouseDownCurve returns false when no block is selected', () => {
    const params = makeParams({ selectedIds: new Set() });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = true;
    act(() => {
      handled = result.current.handleMouseDownCurve({ x: 10, y: 10 });
    });
    expect(handled).toBe(false);
  });

  it('handleMouseDownCurve returns false when multiple blocks are selected', () => {
    const params = makeParams({ selectedIds: new Set(['b1', 'b2']) });
    const { result } = renderHook(() => useCurveEditor(params));

    let handled = true;
    act(() => {
      handled = result.current.handleMouseDownCurve({ x: 10, y: 10 });
    });
    expect(handled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #417 (PCT-186): curveClickPoints / polyline draft must not survive page
// navigation, curve-mode exit, or selection change — otherwise a later click
// on a different page/block mixes with stale points into a silently
// committed hybrid arc/polyline (regression guard).
describe('useCurveEditor — #417 stale draft clearing on mode/selection/page change', () => {
  it('clears curveClickPoints when isCurveMode toggles off (mode exit)', () => {
    const params = makeParams();
    const { result, rerender } = renderHook((p: UseCurveEditorParams) => useCurveEditor(p), {
      initialProps: params,
    });

    // Collect 2 of 3 points needed for an arc — leaves a stale in-progress point.
    act(() => { result.current.handleMouseDownCurve({ x: 10, y: 20 }); });
    act(() => { result.current.handleMouseDownCurve({ x: 50, y: 10 }); });
    expect(result.current.curveClickPoints).toHaveLength(2);

    // Simulate leaving curve mode (e.g. toolbar toggle / Escape from mode).
    rerender({ ...params, isCurveMode: false });

    expect(result.current.curveClickPoints).toHaveLength(0);
  });

  it('clears curveClickPoints when selectedIds changes (selection change / page navigation)', () => {
    const params = makeParams({ selectedIds: new Set(['block1']) });
    const { result, rerender } = renderHook((p: UseCurveEditorParams) => useCurveEditor(p), {
      initialProps: params,
    });

    act(() => { result.current.handleMouseDownCurve({ x: 10, y: 20 }); });
    expect(result.current.curveClickPoints).toHaveLength(1);

    // setCurrentPage / toggleSelection both replace selectedIds with a new
    // Set instance (see pecoStore.ts setCurrentPage / toggleSelection) —
    // simulate that here to reproduce a page move or selection change.
    rerender({ ...params, selectedIds: new Set(['block2']) });

    expect(result.current.curveClickPoints).toHaveLength(0);
  });

  it('a fresh click after mode exit + re-entry does not mix with the stale point (no hybrid arc)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result, rerender } = renderHook((p: UseCurveEditorParams) => useCurveEditor(p), {
      initialProps: params,
    });

    // 1st click on original page/mode.
    act(() => { result.current.handleMouseDownCurve({ x: 0, y: 0 }); });
    expect(result.current.curveClickPoints).toHaveLength(1);

    // Leave curve mode without confirming (stale point would previously survive).
    rerender({ ...params, isCurveMode: false });
    // Re-enter curve mode (e.g. after navigating to a different page).
    rerender({ ...params, isCurveMode: true });

    expect(result.current.curveClickPoints).toHaveLength(0);

    // A single new click on the "new page" must start a fresh collection of 1,
    // not silently combine with the discarded stale point.
    act(() => { result.current.handleMouseDownCurve({ x: 100, y: 100 }); });
    expect(result.current.curveClickPoints).toHaveLength(1);
    expect(result.current.curveClickPoints[0]).toEqual({ x: 100, y: 100 });
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('clears an active polyline draft when isCurveMode toggles off, without committing it', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result, rerender } = renderHook((p: UseCurveEditorParams) => useCurveEditor(p), {
      initialProps: params,
    });

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    expect(result.current.polylineDraftActive).toBe(true);
    expect(result.current.polylineDraftPoints).toHaveLength(1);

    rerender({ ...params, isCurveMode: false });

    expect(result.current.polylineDraftActive).toBe(false);
    expect(result.current.polylineDraftPoints).toHaveLength(0);
    // Must be discarded, not silently committed as a curve.
    expect(updatePageData).not.toHaveBeenCalled();
  });

  it('clears an active polyline draft when selectedIds changes (page navigation mid-draft)', () => {
    const params = makeParams({ selectedIds: new Set(['block1']) });
    const { result, rerender } = renderHook((p: UseCurveEditorParams) => useCurveEditor(p), {
      initialProps: params,
    });

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    expect(result.current.polylineDraftActive).toBe(true);

    rerender({ ...params, selectedIds: new Set() }); // e.g. setCurrentPage clears selection

    expect(result.current.polylineDraftActive).toBe(false);
    expect(result.current.polylineDraftPoints).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #424 (PCT-193): a polyline whose points are all identical (or within
// floating-point noise) must not confirm — curveGlyphLayout.layoutOnPolyline
// treats zero-length segments as unusable and returns [], which causes the
// save core to drop the block's text entirely (character loss).
describe('useCurveEditor — #424 degenerate (same-point) polyline is rejected on confirm', () => {
  it('double-click then click on the exact same point, then Enter: draft is not confirmed (no updatePageData call)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 30, y: 40 }); // identical point
    });
    expect(result.current.polylineDraftPoints).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    // Rejected: no curve committed, and the draft is left active so the user
    // can click a distinct point instead of silently losing their input.
    expect(updatePageData).not.toHaveBeenCalled();
    expect(result.current.polylineDraftActive).toBe(true);
    expect(result.current.polylineDraftPoints).toHaveLength(2);
  });

  it('all points within floating-point noise (< epsilon) are also rejected', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      // 0.001 away — well under the MIN_POLYLINE_SEGMENT_LENGTH threshold.
      result.current.handleMouseDownCurve({ x: 30.001, y: 40 });
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(updatePageData).not.toHaveBeenCalled();
    expect(result.current.polylineDraftActive).toBe(true);
  });

  it('a polyline with at least one non-degenerate segment still confirms normally (no false rejection)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 80, y: 90 }); // clearly distinct point
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(result.current.polylineDraftActive).toBe(false);
    const [, partial] = updatePageData.mock.calls[0];
    const newBlock = partial.textBlocks?.find((b: TextBlock) => b.id === 'block1');
    expect(newBlock?.curve?.type).toBe('polyline');
  });

  it('3 points where only the first segment is degenerate but the second is not: still confirms (some usable segment exists)', () => {
    const block = makeTextBlock('block1');
    const page = makePageData([block]);
    const getPageData = vi.fn(() => page);
    const updatePageData = vi.fn();
    const params = makeParams({ getPageData, updatePageData });
    const { result } = renderHook(() => useCurveEditor(params));

    act(() => { result.current.handleDoubleClickCurve({ x: 30, y: 40 }); });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 30, y: 40 }); // identical to first (degenerate seg)
    });
    act(() => {
      result.current.lastDoubleClickTimeRef.current = 0;
      result.current.handleMouseDownCurve({ x: 100, y: 40 }); // distinct (non-degenerate seg)
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(result.current.polylineDraftActive).toBe(false);
  });
});
