import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasDrawing } from '../../hooks/useCanvasDrawing';
import type { PageData, TextBlock } from '../../types';

function makeBlock(id: string, order: number, bbox = { x: 100 + order * 100, y: 100, width: 40, height: 20 }): TextBlock {
  return {
    id,
    text: id,
    originalText: id,
    bbox,
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  };
}

function makePage(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  };
}

function drawNewBlock(result: ReturnType<typeof renderDrawing>['result']) {
  act(() => result.current.startDrawing({ x: 0, y: 0 }));
  act(() => result.current.updateDrawing({ x: 20, y: 10 }));
  act(() => result.current.finishDrawing());
}

function renderDrawing(pageData: PageData, selectedIds = new Set<string>()) {
  const updatePageData = vi.fn();
  const setSelectedIds = vi.fn();
  const toggleDrawingMode = vi.fn();

  const hook = renderHook(() =>
    useCanvasDrawing({
      pageIndex: 0,
      zoom: 100,
      getPageData: () => pageData,
      selectedIds,
      updatePageData,
      setSelectedIds,
      toggleDrawingMode,
      toggleSplitMode: vi.fn(),
    })
  );

  return { ...hook, updatePageData, setSelectedIds, toggleDrawingMode };
}

describe('useCanvasDrawing: BB追加の挿入位置', () => {
  it('選択中BBが1件なら、その直後に新規BBを追加する', () => {
    const page = makePage([makeBlock('a', 0), makeBlock('b', 1), makeBlock('c', 2)]);
    const { result, updatePageData, setSelectedIds } = renderDrawing(page, new Set(['b']));

    drawNewBlock(result);

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b', newBlock.id, 'c']);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3]);
    expect(setSelectedIds).toHaveBeenCalledWith([newBlock.id]);
  });

  it('複数選択中なら、選択中で一番後ろのBBの直後に新規BBを追加する', () => {
    const page = makePage([makeBlock('a', 0), makeBlock('b', 1), makeBlock('c', 2)]);
    const { result, updatePageData } = renderDrawing(page, new Set(['a', 'c']));

    drawNewBlock(result);

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c', newBlock.id]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3]);
  });

  it('選択がなければ既存の座標ベース挿入を使う', () => {
    const page = makePage([makeBlock('a', 0), makeBlock('b', 1), makeBlock('c', 2)]);
    const { result, updatePageData } = renderDrawing(page);

    drawNewBlock(result);

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(blocks.map((b) => b.id)).toEqual([newBlock.id, 'a', 'b', 'c']);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3]);
  });
});
