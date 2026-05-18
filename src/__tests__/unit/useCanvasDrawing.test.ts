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
  const toggleSplitMode = vi.fn();

  const hook = renderHook(() =>
    useCanvasDrawing({
      pageIndex: 0,
      zoom: 100,
      getPageData: () => pageData,
      selectedIds,
      updatePageData,
      setSelectedIds,
      toggleDrawingMode,
      toggleSplitMode,
    })
  );

  return { ...hook, updatePageData, setSelectedIds, toggleDrawingMode, toggleSplitMode };
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

describe('useCanvasDrawing: Issue #7 BB描画モードは BB が作れた時だけ解除', () => {
  it('BB が正常に作成されたら描画モードが解除される', () => {
    const page = makePage([]);
    const { result, toggleDrawingMode, updatePageData } = renderDrawing(page);

    drawNewBlock(result);

    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(toggleDrawingMode).toHaveBeenCalledTimes(1);
  });

  it('width/height が 2 以下 (誤クリック) なら描画モードを維持する', () => {
    const page = makePage([]);
    const { result, toggleDrawingMode, updatePageData } = renderDrawing(page);

    // 誤クリック相当: startPos と currentPos がほぼ同じ
    act(() => result.current.startDrawing({ x: 100, y: 100 }));
    act(() => result.current.updateDrawing({ x: 101, y: 101 }));
    act(() => result.current.finishDrawing());

    expect(updatePageData).not.toHaveBeenCalled();
    expect(toggleDrawingMode).not.toHaveBeenCalled();
  });
});

describe('useCanvasDrawing: Issue #5 分割不可ブロックは split モードを維持', () => {
  it('1 文字ブロックをクリックしても split モードは維持される (toggleSplitMode が呼ばれない)', () => {
    // 1 文字のブロック (graphemes.length < 2 で splitBlockAtRatio が null を返す)
    const oneCharBlock: TextBlock = {
      ...makeBlock('one', 0, { x: 50, y: 50, width: 40, height: 40 }),
      text: 'A',
      originalText: 'A',
    };
    const page = makePage([oneCharBlock]);
    const { result, toggleSplitMode, updatePageData } = renderDrawing(page);

    let returned: boolean | undefined;
    act(() => {
      returned = result.current.trySplit({ x: 70, y: 70 });
    });

    expect(returned).toBe(false);
    expect(updatePageData).not.toHaveBeenCalled();
    // モード維持: toggleSplitMode は呼ばれない
    expect(toggleSplitMode).not.toHaveBeenCalled();
  });

  it('複数文字ブロックを正常に分割した時は split モードを解除する', () => {
    const multiBlock: TextBlock = {
      ...makeBlock('multi', 0, { x: 50, y: 50, width: 100, height: 40 }),
      text: 'abcdef',
      originalText: 'abcdef',
    };
    const page = makePage([multiBlock]);
    const { result, toggleSplitMode, updatePageData } = renderDrawing(page);

    let returned: boolean | undefined;
    act(() => {
      returned = result.current.trySplit({ x: 100, y: 70 });
    });

    expect(returned).toBe(true);
    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(toggleSplitMode).toHaveBeenCalledTimes(1);
  });

  it('ブロック外をクリックしたら split モードは解除される (既存挙動の維持)', () => {
    const page = makePage([makeBlock('a', 0, { x: 50, y: 50, width: 40, height: 20 })]);
    const { result, toggleSplitMode, updatePageData } = renderDrawing(page);

    let returned: boolean | undefined;
    act(() => {
      // ブロック外
      returned = result.current.trySplit({ x: 500, y: 500 });
    });

    expect(returned).toBe(false);
    expect(updatePageData).not.toHaveBeenCalled();
    // ブロック外クリックは既存通り解除される (cancel UX)
    expect(toggleSplitMode).toHaveBeenCalledTimes(1);
  });
});
