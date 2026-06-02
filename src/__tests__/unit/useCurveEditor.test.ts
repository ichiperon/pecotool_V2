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
    // Move to new position
    act(() => {
      result.current.handleMouseMoveCurve({ x: 90, y: 55 });
    });

    expect(updatePageData).toHaveBeenCalled();
    const lastCall = updatePageData.mock.calls[updatePageData.mock.calls.length - 1];
    expect(lastCall[2]).toBe(false); // undoable=false during drag
  });

  it('mouseUp after drag calls updatePageData with undoable=true and clears dragRef', () => {
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
    // Last updatePageData call must be undoable=true
    const lastCall = updatePageData.mock.calls[updatePageData.mock.calls.length - 1];
    expect(lastCall[2]).toBe(true);
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
