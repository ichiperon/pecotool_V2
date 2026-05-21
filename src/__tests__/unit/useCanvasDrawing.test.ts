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

// ─────────────────────────────────────────────────────────────
// finishDrawing の座標ベース挿入位置決定。選択が無いとき、新規 BB の中心と
// 既存 BB の中心を比較して「読み順で先に来る位置」へ挿入する。
// 縦書き / 横書きで比較軸が入れ替わるため、ここを誤ると新規 BB が
// 読み順の途中に紛れ込む。lines 76-91 の分岐は既存テスト未到達だった。
// ─────────────────────────────────────────────────────────────
describe('useCanvasDrawing: 座標ベース挿入 (writing mode 別の読み順判定)', () => {
  it('横書き: 同じ行 (Y が近い) の左に描いた新規 BB は既存 BB の前に入る', () => {
    // 既存 a を (200,100,40,20) に置く。新規 BB は (0,0)-(20,10) なので中心 (10,5)。
    // a の中心 cy=110 と新規 cy=5 → |Δcy|=105 は a.height*0.6=12 より大 → 別行扱い。
    // 別行なら cy 比較: 5 < 110 → 新規が先。
    const page = makePage([makeBlock('a', 0, { x: 200, y: 100, width: 40, height: 20 })]);
    const { result, updatePageData } = renderDrawing(page);

    drawNewBlock(result);

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(blocks.map((b) => b.id)).toEqual([newBlock.id, 'a']);
  });

  it('横書き: 同じ行内で新規 BB が既存 BB より右なら既存 BB の後に入る', () => {
    // 既存 a を新規 BB と同じ行・左寄りに置く: 新規中心 (10,5)。
    // a を (x=-30..-? ) では負座標になるので、a を新規の左に来るよう小さな bbox に。
    // a bbox=(0,0,4,4) 中心 (2,2)。新規中心 (10,5) → |Δcy|=3 < max(10,4)*0.6=6 → 同じ行。
    // 同じ行なら cx 比較: 新規 cx=10 > a cx=2 → 新規は a の後。
    const page = makePage([makeBlock('a', 0, { x: 0, y: 0, width: 4, height: 4 })]);
    const { result, updatePageData } = renderDrawing(page);

    drawNewBlock(result);

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(blocks.map((b) => b.id)).toEqual(['a', newBlock.id]);
  });

  it('縦書き: 既存 BB が縦書きなら同列判定で cy 比較され、上に描いた新規 BB が前に入る', () => {
    // 縦書き既存 v を新規 BB と同じ列・下に置く。
    // 新規 BB を縦長に描く: start(0,0) → (20,40) で width=20,height=40 → height>width*1.5 → vertical。
    // 新規中心 (10,20)。v bbox=(5,100,12,30) 中心 (11,115)。
    // |Δcx|=1 < max(20,12)*0.6=12 → 同じ列。同列なら cy: 新規 20 < 115 → 新規が先。
    const v = makeBlock('v', 0, { x: 5, y: 100, width: 12, height: 30 });
    v.writingMode = 'vertical';
    const page = makePage([v]);
    const { result, updatePageData } = renderDrawing(page);

    act(() => result.current.startDrawing({ x: 0, y: 0 }));
    act(() => result.current.updateDrawing({ x: 20, y: 40 }));
    act(() => result.current.finishDrawing());

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(newBlock.writingMode).toBe('vertical');
    expect(blocks.map((b) => b.id)).toEqual([newBlock.id, 'v']);
  });
});

// ─────────────────────────────────────────────────────────────
// zoom != 100 での座標変換。finishDrawing は screen 座標を zoom/100 で割って
// PDF 座標へ戻す。trySplit はヒットテストを zoom 倍して行う。
// ズーム時に新規 BB のサイズや分割比がずれると編集結果が壊れる。
// ─────────────────────────────────────────────────────────────
describe('useCanvasDrawing: zoom スケールの座標変換', () => {
  function renderDrawingZoom(pageData: PageData, zoom: number, selectedIds = new Set<string>()) {
    const updatePageData = vi.fn();
    const setSelectedIds = vi.fn();
    const toggleDrawingMode = vi.fn();
    const toggleSplitMode = vi.fn();
    const hook = renderHook(() =>
      useCanvasDrawing({
        pageIndex: 0,
        zoom,
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

  it('zoom=200 で描いた新規 BB の bbox は screen 座標の半分 (PDF 座標) になる', () => {
    const page = makePage([]);
    const { result, updatePageData } = renderDrawingZoom(page, 200);

    // screen 上で (100,100)→(300,200) をドラッグ。zoom=200 → scale=2。
    // PDF 座標: x=100/2=50, y=100/2=50, width=200/2=100, height=100/2=50。
    act(() => result.current.startDrawing({ x: 100, y: 100 }));
    act(() => result.current.updateDrawing({ x: 300, y: 200 }));
    act(() => result.current.finishDrawing());

    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    const newBlock = blocks.find((b) => b.isNew)!;
    expect(newBlock.bbox).toEqual({ x: 50, y: 50, width: 100, height: 50 });
  });

  it('zoom=50 で BB 内クリック時、trySplit はヒットテストを zoom 倍して判定する', () => {
    // block bbox=(100,100,100,40)。zoom=50 → scale=0.5。
    // screen 上の BB 範囲は x:50..100, y:50..70。screen (75,60) は BB 内。
    const block: TextBlock = {
      ...makeBlock('multi', 0, { x: 100, y: 100, width: 100, height: 40 }),
      text: 'abcdef',
      originalText: 'abcdef',
    };
    const page = makePage([block]);
    const { result, updatePageData, toggleSplitMode } = renderDrawingZoom(page, 50);

    let returned: boolean | undefined;
    act(() => {
      returned = result.current.trySplit({ x: 75, y: 60 });
    });

    expect(returned).toBe(true);
    expect(updatePageData).toHaveBeenCalledTimes(1);
    expect(toggleSplitMode).toHaveBeenCalledTimes(1);

    // 分割後 2 ブロックの合計幅 = 元の幅 (100)
    const blocks = updatePageData.mock.calls[0][1].textBlocks as TextBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].bbox.width + blocks[1].bbox.width).toBeCloseTo(100, 5);
  });

  it('zoom=50 で BB の screen 範囲外をクリックしたら分割は起きない', () => {
    const block: TextBlock = {
      ...makeBlock('multi', 0, { x: 100, y: 100, width: 100, height: 40 }),
      text: 'abcdef',
      originalText: 'abcdef',
    };
    const page = makePage([block]);
    const { result, updatePageData } = renderDrawingZoom(page, 50);

    // PDF 座標では BB 内 (150,120) だが、screen 換算では scale=0.5 なので
    // BB の screen 範囲は x:50..100。screen (150,120) は範囲外。
    let returned: boolean | undefined;
    act(() => {
      returned = result.current.trySplit({ x: 150, y: 120 });
    });

    expect(returned).toBe(false);
    expect(updatePageData).not.toHaveBeenCalled();
  });
});
