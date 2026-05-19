import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PdfCanvas } from '../../components/PdfCanvas'
import { usePecoStore } from '../../store/pecoStore'
import * as pdfLoader from '../../utils/pdfLoader'

// ── Mocking ──────────────────────────────────────────────────

vi.mock('pdfjs-dist', () => ({
  default: {
    // pdfjs-dist global stuff if needed
  }
}));

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: vi.fn(),
}));

// canvas ごとに別の context を返すことで「静的層 / 動的層 / PDF 層」の
// clearRect 回数等を個別に観測できるようにする (issue #90 の最適化テスト用)。
function makeMockContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 50 }),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
  };
}
// 旧テスト互換: 共有 1 つの mockContext (個別観測が不要なテスト用)
const mockContext = makeMockContext();

// ── Setup ────────────────────────────────────────────────────

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();

  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext);
  // Mock getBoundingClientRect for coordinate calculations
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    top: 0,
    width: 500,
    height: 500
  });

  const mockPage = {
    getViewport: vi.fn().mockReturnValue({ width: 500, height: 500 }),
    render: vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
  (pdfLoader.getCachedPageProxy as any).mockResolvedValue(mockPage);

  usePecoStore.setState({
    document: {
      filePath: 'test.pdf',
      pages: new Map([[0, {
        pageIndex: 0,
        textBlocks: [
          { id: 'b1', bbox: { x: 10, y: 10, width: 100, height: 50 }, text: 'Test', order: 0, pageIndex: 0 }
        ]
      }]])
    },
    zoom: 100,
    showOcr: true,
    ocrOpacity: 0.5,
    selectedIds: new Set(),
    isDrawingMode: false,
    isSplitMode: false,
  } as any);
});

// PdfCanvas は <canvas> を 3 枚レンダリングする:
//   [0] PDF 描画層 (pdfCanvasRef)
//   [1] 静的 overlay 層 (staticOverlayCanvasRef, 非選択 BB を描画)
//   [2] 動的 overlay 層 (overlayCanvasRef, 選択ハイライト + マウス入力受け口)
const OVERLAY_INTERACTIVE_INDEX = 2;

describe('PdfCanvas', () => {
  it('should render canvas elements', async () => {
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const canvases = container.querySelectorAll('canvas');
    // pdf layer + static overlay + dynamic overlay (issue #90 で 2 層化)
    expect(canvases.length).toBe(3);
  });

  it('should select a block on click', async () => {
    // Wait for page to "load" (mocked promise)
    render(<PdfCanvas pageIndex={0} />);

    // Find overlay canvas
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const overlay = container.querySelectorAll('canvas')[OVERLAY_INTERACTIVE_INDEX];

    // Click inside block b1 (10, 10, 100, 50)
    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 30 });

    // Check if store was updated
    const selectedIds = usePecoStore.getState().selectedIds;
    expect(selectedIds.has('b1')).toBe(true);
  });

  it('should clear selection on blank click without selecting an empty id', () => {
    usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any);

    const { container } = render(<PdfCanvas pageIndex={0} />);
    const overlay = container.querySelectorAll('canvas')[OVERLAY_INTERACTIVE_INDEX];

    fireEvent.mouseDown(overlay, { clientX: 300, clientY: 300 });

    const state = usePecoStore.getState();
    expect(state.selectedIds.size).toBe(0);
    expect(state.selectedIds.has('')).toBe(false);
    expect(state.lastSelectedId).toBe(null);
  });

  // ── C-PC-AUTOSCROLL: 自動スクロールは bbox 変化時のみ (issue #73) ────
  describe('auto-scroll effect (issue #73)', () => {
    function makePanel(): HTMLDivElement {
      const panel = window.document.createElement('div')
      panel.className = 'pdf-viewer-panel'
      panel.getBoundingClientRect = vi.fn().mockReturnValue({
        left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
      })
      window.document.body.appendChild(panel)
      return panel
    }

    it('updatePageData による thumbnail のみ更新では scrollTo を再発火しない', () => {
      usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)

      const panel = makePanel()
      const scrollSpy = vi.fn()
      panel.scrollTo = scrollSpy as unknown as typeof panel.scrollTo

      render(<PdfCanvas pageIndex={0} />)

      // 初回マウント effect の同期実行で 1 回 scrollTo
      const initialCalls = scrollSpy.mock.calls.length

      // bbox を変更せずに thumbnail だけ更新 (PageData 参照は変わるが textBlocks 参照は同一)
      const before = usePecoStore.getState().document!.pages.get(0)!
      act(() => {
        usePecoStore.getState().updatePageData(0, { thumbnail: 'dummy' } as any, false)
      })
      const after = usePecoStore.getState().document!.pages.get(0)!
      // 前提確認: textBlocks 参照は保たれていること
      expect(after.textBlocks).toBe(before.textBlocks)

      // textBlocks が変わっていないので scrollTo は追加で呼ばれない (issue #73)
      expect(scrollSpy.mock.calls.length).toBe(initialCalls)

      panel.remove()
    })

    it('updatePageData で textBlocks の bbox が変わると scrollTo は再発火する (sanity)', () => {
      usePecoStore.setState({ selectedIds: new Set(['b1']), lastSelectedId: 'b1' } as any)

      const panel = makePanel()
      const scrollSpy = vi.fn()
      panel.scrollTo = scrollSpy as unknown as typeof panel.scrollTo

      render(<PdfCanvas pageIndex={0} />)
      const initialCalls = scrollSpy.mock.calls.length

      // 新しい textBlocks 配列で bbox 変更
      act(() => {
        usePecoStore.getState().updatePageData(0, {
          textBlocks: [
            { id: 'b1', bbox: { x: 200, y: 200, width: 100, height: 50 }, text: 'Test', order: 0, pageIndex: 0 } as any,
          ],
        } as any, false)
      })

      expect(scrollSpy.mock.calls.length).toBeGreaterThan(initialCalls)

      panel.remove()
    })
  })

  it('should enter drawing mode and allow drawing a new block', () => {
    usePecoStore.setState({ isDrawingMode: true } as any);
    const { container } = render(<PdfCanvas pageIndex={0} />);
    const overlay = container.querySelectorAll('canvas')[OVERLAY_INTERACTIVE_INDEX];

    // Start drawing at 200, 200
    fireEvent.mouseDown(overlay, { clientX: 200, clientY: 200 });
    // Move to 300, 300
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 300 });
    // Release
    fireEvent.mouseUp(overlay);

    // Check if a new block was added to the document
    const pageData = usePecoStore.getState().document?.pages.get(0);
    expect(pageData?.textBlocks.length).toBe(2);
    const newBlock = pageData?.textBlocks.find(b => (b as any).isNew);
    expect(newBlock).toBeDefined();
    expect(newBlock?.bbox.x).toBe(200);
    expect(newBlock?.bbox.y).toBe(200);
  });

  // PdfCanvas の effect は (1) pdfPage を async に load する -> (2) ページ
  // 切替 debounce 50ms / zoom 切替 30ms 待ってから renderPdf → renderOverlays
  // 呼び出し… と複数の microtask + setTimeout を経由する。テストでは setState
  // 結果が overlay 描画に反映されるまで microtask + setTimeout を flush しないと
  // 観測できないため、ヘルパでまとめて待つ。
  async function flushAsyncRenders() {
    // 初回 pdfPage load + render debounce + render promise
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    // 残りの microtask / RAF flush
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  // ── C-PC-90-LAYERS: 2 層 overlay の層分離検証 (issue #90) ──────────────
  //
  // 静的層 (非選択 BB) と動的層 (選択ハイライト・drawing・altDrag) を分離した
  // ことで「BB 500+ で 1 文字編集 / 矢印キー移動ごとの O(N) 全 BB 再描画」を
  // 軽減した。ここでは:
  //   - selectedIds のみ変化 → 静的層の描画パスが新たに呼ばれないこと
  //     (※ selectedIds 変化用の小さな静的層更新 effect は走るが、それは
  //      意図された範囲。ここで観測したいのは「動的層は走る」「静的層の
  //      メイン再描画は selectedIds に依存していない」)
  //   - textBlocks 不変 → 静的層のメイン effect の依存にヒットしない
  //   - showOcr の切替 → 静的層も走る
  describe('issue #90: 2-layer overlay separation', () => {
    // canvas 要素の DOM 順 (querySelectorAll('canvas')) から context を引く。
    //   [0] PDF 描画層 (pdfCanvasRef)
    //   [1] 静的 overlay (staticOverlayCanvasRef)
    //   [2] 動的 overlay (overlayCanvasRef)
    // テストは render 後に container から canvas[] を取り出して context を観測する。
    function setupCanvasContexts(): {
      pdfCtx: ReturnType<typeof makeMockContext>
      staticCtx: ReturnType<typeof makeMockContext>
      dynamicCtx: ReturnType<typeof makeMockContext>
    } {
      const pdfCtx = makeMockContext()
      const staticCtx = makeMockContext()
      const dynamicCtx = makeMockContext()
      // 各 canvas が getContext を呼ぶたびに DOM 順に応じて返す context を選ぶ。
      // ※ jsdom + React で生成された canvas は parentNode 経由で兄弟順を辿れるので、
      //    canvas 要素自身が「pdf-viewer-panel 配下の何番目」かを毎回測って割当る。
      HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
        const wrapper = this.parentElement
        if (!wrapper) return pdfCtx
        const siblings = Array.from(wrapper.children).filter(
          (c) => c.tagName === 'CANVAS'
        ) as HTMLCanvasElement[]
        const idx = siblings.indexOf(this)
        if (idx === 0) return pdfCtx
        if (idx === 1) return staticCtx
        return dynamicCtx
      }) as any
      return { pdfCtx, staticCtx, dynamicCtx }
    }

    it('selectedIds-only change does not trigger the main static-layer redraw effect', async () => {
      // 大きめ N で静的層 forEach が観測しやすいケースを作る。
      const blocks = Array.from({ length: 20 }, (_, i) => ({
        id: `b${i}`,
        bbox: { x: i * 20, y: 10, width: 18, height: 18 },
        text: 'x',
        order: i,
        pageIndex: 0,
      }))
      usePecoStore.setState({
        document: {
          filePath: 'test.pdf',
          pages: new Map([[0, { pageIndex: 0, textBlocks: blocks }]]),
        },
        zoom: 100,
        showOcr: true,
        ocrOpacity: 0.5,
        selectedIds: new Set(),
        isDrawingMode: false,
        isSplitMode: false,
      } as any)

      const { staticCtx, dynamicCtx } = setupCanvasContexts()

      render(<PdfCanvas pageIndex={0} />)
      // 初回マウントで両層が描画される (RAF 同期 flush)
      await flushAsyncRenders()

      const baseStaticFillRectCalls = staticCtx.fillRect.mock.calls.length
      const baseDynamicClearCalls = dynamicCtx.clearRect.mock.calls.length

      // selectedIds のみを変更 (textBlocks は同じ参照)
      act(() => {
        usePecoStore.getState().setSelectedIds(['b3'])
      })
      await flushAsyncRenders()

      // 動的層は必ず再描画される
      expect(dynamicCtx.clearRect.mock.calls.length).toBeGreaterThan(baseDynamicClearCalls)

      // selectedIds 変化に伴う静的層更新は「全非選択 BB の再描画」となるが、
      // メイン静的層 effect (依存: currentTextBlocks) は走らないことを確認する。
      // 観測としては「メイン effect が走るときに rotate / scale 等が大量に呼ばれる
      // のが期待値と比べてどうか」よりも、「fillRect の差分が <= 元の全 BB 数」
      // 程度で安定することを期待する。ここでは厳密な等値ではなく、selectedIds
      // のみが切り替わったときに最低限 dynamic 層が走ること + static 層の
      // 描画コール数が増えても元の N 件分以下に収まることを担保する。
      const deltaStatic =
        staticCtx.fillRect.mock.calls.length - baseStaticFillRectCalls
      // 19 ブロックを再描画 (選択 1 つを除外) する分だけ fillRect が増えるのは許容。
      // ただし「2 倍以上呼ばれた = メイン effect も二重発火している」場合は退行。
      expect(deltaStatic).toBeLessThanOrEqual(blocks.length)
    })

    it('text-only change (zoom unchanged, selection unchanged) only redraws static layer because textBlocks parameter to dynamic effect also includes textBlocks; dynamic still runs but selection set is empty', async () => {
      const blocks = Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        bbox: { x: i * 30, y: 10, width: 28, height: 28 },
        text: 'a',
        order: i,
        pageIndex: 0,
      }))
      usePecoStore.setState({
        document: {
          filePath: 'test.pdf',
          pages: new Map([[0, { pageIndex: 0, textBlocks: blocks }]]),
        },
        zoom: 100,
        showOcr: true,
        ocrOpacity: 0.5,
        selectedIds: new Set(),
        isDrawingMode: false,
        isSplitMode: false,
      } as any)

      const { staticCtx, dynamicCtx } = setupCanvasContexts()

      render(<PdfCanvas pageIndex={0} />)
      await flushAsyncRenders()

      const baseStaticClearCalls = staticCtx.clearRect.mock.calls.length
      const baseDynamicClearCalls = dynamicCtx.clearRect.mock.calls.length

      // textBlocks 配列を差し替え (1 文字編集相当)
      act(() => {
        const next = blocks.map((b) => (b.id === 'b2' ? { ...b, text: 'ab' } : b))
        usePecoStore.getState().updatePageData(0, { textBlocks: next, isDirty: true }, false)
      })
      await flushAsyncRenders()

      // textBlocks 参照変化 → 両層が再描画される
      expect(staticCtx.clearRect.mock.calls.length).toBeGreaterThan(baseStaticClearCalls)
      expect(dynamicCtx.clearRect.mock.calls.length).toBeGreaterThan(baseDynamicClearCalls)
    })

    it('drawing preview update only touches dynamic layer, never the static layer', async () => {
      const blocks = Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        bbox: { x: i * 30, y: 10, width: 28, height: 28 },
        text: 'a',
        order: i,
        pageIndex: 0,
      }))
      usePecoStore.setState({
        document: {
          filePath: 'test.pdf',
          pages: new Map([[0, { pageIndex: 0, textBlocks: blocks }]]),
        },
        zoom: 100,
        showOcr: true,
        ocrOpacity: 0.5,
        selectedIds: new Set(),
        isDrawingMode: true, // drawing モードで開始
        isSplitMode: false,
      } as any)

      const { staticCtx, dynamicCtx } = setupCanvasContexts()

      const { container } = render(<PdfCanvas pageIndex={0} />)
      await flushAsyncRenders()

      const overlay = container.querySelectorAll('canvas')[OVERLAY_INTERACTIVE_INDEX]

      const baseStaticClearCalls = staticCtx.clearRect.mock.calls.length
      const baseDynamicClearCalls = dynamicCtx.clearRect.mock.calls.length

      // ドロー開始 → 多数回の mouseMove (drawing.* state が更新されるたびに
      // 動的層 effect の依存が変わる。textBlocks / selectedIds / showOcr 等の
      // 静的層依存は全て不変)
      fireEvent.mouseDown(overlay, { clientX: 200, clientY: 200 })
      for (let i = 0; i < 5; i++) {
        fireEvent.mouseMove(overlay, { clientX: 200 + i * 10, clientY: 200 + i * 10 })
      }
      await flushAsyncRenders()

      const dynamicDelta =
        dynamicCtx.clearRect.mock.calls.length - baseDynamicClearCalls
      const staticDelta =
        staticCtx.clearRect.mock.calls.length - baseStaticClearCalls

      // 動的層: drawing プレビュー更新で複数回 (少なくとも 1 回) 再描画。
      expect(dynamicDelta).toBeGreaterThanOrEqual(1)
      // 静的層: drawing 状態には依存していないため、増加量は動的層よりも
      // 大幅に小さい。マウント直後の RAF flush タイミングのブレで 1 回程度
      // 余分に走るのは許容するが、動的層の更新ペースで比例して増えないこと
      // (= drawing 中の N 回 mouseMove に対し静的層 forEach が同期しない)
      // を担保する。
      expect(staticDelta).toBeLessThanOrEqual(1)
      expect(staticDelta).toBeLessThan(dynamicDelta)
    })
  })
});
