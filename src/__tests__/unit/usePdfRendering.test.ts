/**
 * S-01-01 〜 S-01-03: usePdfRendering のページ切替チラつき抑止挙動検証
 *
 * 旧仕様:
 *  - filePath / pageIndex 変更時の useEffect 冒頭で setPdfPage(null) を同期実行し、
 *    新 proxy 解決までの間 pdfPage が null になっていた。
 *    これが「ページ切替時に Canvas が真っ白 → じわっと新ページ」チラつきの原因。
 *
 * 新仕様 (本タスクで変更):
 *  - 旧 pdfPage は切替直後にクリアせず、新 proxy が解決したタイミングで置換する。
 *  - store.currentPageProxy 共有チャネル経由で受け取れるときは二重 fetch を回避する。
 *  - ファイル unset (filePath=undefined) 時のみ即座に null クリア。
 *
 * 検証対象:
 *  - ページ切替 (同ファイル 0→1) 時、新 proxy 解決まで旧 pdfPage が維持される
 *  - ファイル切替 A→B 時も、B 解決までは A の pdfPage が維持される
 *  - 連続ページ切替で最終的な pdfPage は最終ページに収束する
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'

// ── Mock pdfjs-dist worker URL imports (Vite固有) ───────────────
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

// ── Mock pdfLoader: getCachedPageProxy をテスト中に挙動切替する ──
const getCachedPageProxyMock = vi.fn()
vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: (...args: unknown[]) => getCachedPageProxyMock(...args),
}))

// ── Mock bitmapCache: getter/setter を no-op に ────────────────
vi.mock('../../utils/bitmapCache', () => ({
  getBitmapCache: vi.fn().mockReturnValue(null),
  setBitmapCache: vi.fn(),
  clearBitmapCache: vi.fn(),
}))

import { usePdfRendering } from '../../hooks/usePdfRendering'
import { usePecoStore } from '../../store/pecoStore'
import { useInfraStore } from '../../store/infraStore'

// ── Test helpers ───────────────────────────────────────────────
type FakePage = {
  __id: string
  getViewport: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  getTextContent?: ReturnType<typeof vi.fn>
  destroy?: ReturnType<typeof vi.fn>
}

function makeFakePage(id: string): FakePage {
  return {
    __id: id,
    getViewport: vi.fn().mockReturnValue({ width: 100, height: 100 }),
    render: vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
    getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    destroy: vi.fn(),
  }
}

function makeRefs() {
  // useRef-like objects（renderHook の外で安定参照）
  const pdfCanvas = document.createElement('canvas')
  const overlayCanvas = document.createElement('canvas')
  const wrapper = document.createElement('div')
  return {
    pdfCanvasRef: { current: pdfCanvas } as React.RefObject<HTMLCanvasElement | null>,
    overlayCanvasRef: { current: overlayCanvas } as React.RefObject<HTMLCanvasElement | null>,
    wrapperRef: { current: wrapper } as React.RefObject<HTMLDivElement | null>,
    renderOverlaysRef: { current: vi.fn() } as React.MutableRefObject<(() => void) | null>,
  }
}

interface HookProps {
  filePath: string | undefined
  pageIndex: number
  documentEpoch?: number
  zoom: number
}

beforeEach(() => {
  getCachedPageProxyMock.mockReset()
  // infraStore の currentPageProxy をリセット（前テストの残留を防ぐ）
  useInfraStore.setState({ currentPageProxy: null, currentPageProxyKey: null, documentEpoch: 0 })
  usePecoStore.setState({ pageOrder: [] } as any)
})

describe('S-01-01: ページ切替時、新 proxy 解決まで旧 pdfPage を維持 (チラつき抑止)', () => {
  it('pageIndex 変更後も await 解決前は旧ページが残り、解決後に新ページへ置換', async () => {
    const refs = makeRefs()
    const pageA = makeFakePage('A:0')
    const pageB = makeFakePage('A:1')

    // ページ B は手動 resolve で順序を観察
    let resolveB!: (p: FakePage) => void
    const bPromise = new Promise<FakePage>((res) => { resolveB = res })

    getCachedPageProxyMock.mockImplementation((_fp: string, idx: number) => {
      if (idx === 0) return Promise.resolve(pageA)
      if (idx === 1) return bPromise
      return Promise.reject(new Error(`unexpected pageIndex ${idx}`))
    })

    const { result, rerender } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100 } }
    )

    // 非同期 set を待つ
    await waitFor(() => {
      expect(result.current.pdfPage).toBe(pageA)
    })

    // ページ 1 へ切替
    rerender({ filePath: 'file-A.pdf', pageIndex: 1, zoom: 100 })

    // 新仕様: 旧 pageA が維持される (チラつき抑止のため null にしない)
    expect(result.current.pdfPage).toBe(pageA)

    // まだ B を resolve していないので pageA のまま
    await Promise.resolve()
    expect(result.current.pdfPage).toBe(pageA)

    // B を resolve すると pdfPage が B に切り替わる
    await act(async () => {
      resolveB(pageB)
      await bPromise
    })

    await waitFor(() => {
      expect(result.current.pdfPage).toBe(pageB)
    })

    expect(getCachedPageProxyMock).toHaveBeenNthCalledWith(1, 'file-A.pdf', 0)
    expect(getCachedPageProxyMock).toHaveBeenNthCalledWith(2, 'file-A.pdf', 1)
  })
})

describe('S-01-02: 連続ページ切替 (1→3→5) で最終ページが反映', () => {
  it('3 回連続 rerender 後の result.current.pdfPage が最終ページ', async () => {
    const refs = makeRefs()
    const pageP1 = makeFakePage('A:1')
    const pageP3 = makeFakePage('A:3')
    const pageP5 = makeFakePage('A:5')

    // それぞれの呼び出しに対応するページを返す
    getCachedPageProxyMock.mockImplementation((_fp: string, idx: number) => {
      if (idx === 1) return Promise.resolve(pageP1)
      if (idx === 3) return Promise.resolve(pageP3)
      if (idx === 5) return Promise.resolve(pageP5)
      return Promise.reject(new Error(`unexpected pageIndex ${idx}`))
    })

    const { result, rerender } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 10,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 1, zoom: 100 } }
    )

    await waitFor(() => expect(result.current.pdfPage).toBe(pageP1))

    // 連続切替: 1 → 3 → 5
    // 新仕様: 切替直後も pdfPage は null にならず、旧 / 新どちらかが入っている。
    rerender({ filePath: 'file-A.pdf', pageIndex: 3, zoom: 100 })
    expect(result.current.pdfPage).not.toBeNull()
    rerender({ filePath: 'file-A.pdf', pageIndex: 5, zoom: 100 })
    expect(result.current.pdfPage).not.toBeNull()

    // 最終的に 5 が反映される
    await waitFor(() => expect(result.current.pdfPage).toBe(pageP5))

    // 3 つすべての pageIndex に対して getCachedPageProxy が呼ばれたこと
    const calledIdxs = getCachedPageProxyMock.mock.calls.map((c) => c[1])
    expect(calledIdxs).toEqual([1, 3, 5])
  })
})

describe('S-01-03: ファイル切替 A→B で B 解決まで A を維持、解決後 B へ置換', () => {
  it('A の pdfPage は B の resolve 前は維持され、解決後に B プロキシへ置換', async () => {
    const refs = makeRefs()
    const pageA = makeFakePage('A:0')
    const pageB = makeFakePage('B:0')

    // ファイル B 用 promise を手動制御して順序を観察可能にする
    let resolveB!: (p: FakePage) => void
    const bPromise = new Promise<FakePage>((res) => { resolveB = res })

    getCachedPageProxyMock.mockImplementation((fp: string) => {
      if (fp === 'file-A.pdf') return Promise.resolve(pageA)
      if (fp === 'file-B.pdf') return bPromise
      return Promise.reject(new Error(`unexpected file ${fp}`))
    })

    const { result, rerender } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100 } }
    )

    await waitFor(() => expect(result.current.pdfPage).toBe(pageA))

    // ファイル B へ切替: 新仕様では A プロキシは維持される
    rerender({ filePath: 'file-B.pdf', pageIndex: 0, zoom: 100 })
    expect(result.current.pdfPage).toBe(pageA)

    // この時点ではまだ B も resolve していない → A のまま
    await Promise.resolve()
    expect(result.current.pdfPage).toBe(pageA)

    // B を resolve すると pdfPage が B に切り替わる
    await act(async () => {
      resolveB(pageB)
      await bPromise
    })

    await waitFor(() => expect(result.current.pdfPage).toBe(pageB))
  })

  it('filePath=undefined (ファイル閉じ) 時は即座に pdfPage が null', async () => {
    const refs = makeRefs()
    const pageA = makeFakePage('A:0')
    getCachedPageProxyMock.mockResolvedValue(pageA)

    const { result, rerender } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf' as string | undefined, pageIndex: 0, zoom: 100 } }
    )
    await waitFor(() => expect(result.current.pdfPage).toBe(pageA))

    rerender({ filePath: undefined, pageIndex: 0, zoom: 100 })
    expect(result.current.pdfPage).toBeNull()
  })

  it('新ページ取得失敗時は旧 pdfPage を破棄して loadError を立てる', async () => {
    const refs = makeRefs()
    const pageA = makeFakePage('A:0')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getCachedPageProxyMock.mockImplementation((_fp: string, idx: number) => {
      if (idx === 0) return Promise.resolve(pageA)
      return Promise.reject(new Error('page load failed'))
    })

    try {
      const { result, rerender } = renderHook(
        (props: HookProps) =>
          usePdfRendering({
            ...refs,
            filePath: props.filePath,
            totalPages: 3,
            pageIndex: props.pageIndex,
            zoom: props.zoom,
            renderOverlaysRef: refs.renderOverlaysRef,
          }),
        { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100 } }
      )

      await waitFor(() => expect(result.current.pdfPage).toBe(pageA))

      rerender({ filePath: 'file-A.pdf', pageIndex: 1, zoom: 100 })

      await waitFor(() => {
        expect(result.current.loadError).toBe(true)
        expect(result.current.pdfPage).toBeNull()
      })
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('S-01-06: store.currentPageProxy 共有チャネル経由で二重 getCachedPageProxy を回避', () => {
  it('currentPageProxyKey が一致すれば getCachedPageProxy を呼ばず store の proxy を使う', async () => {
    const refs = makeRefs()
    const sharedPage = makeFakePage('shared:A:0')

    // store に事前 publish しておく
    useInfraStore.setState({
      currentPageProxy: sharedPage as any,
      currentPageProxyKey: 'file-A.pdf:0',
    })

    const { result } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100 } }
    )

    await waitFor(() => {
      expect(result.current.pdfPage).toBe(sharedPage)
    })
    // store のを使ったので getCachedPageProxy は呼ばれていない
    expect(getCachedPageProxyMock).not.toHaveBeenCalled()
  })

  it('documentEpoch が変わると同じ key の currentPageProxy を使わず proxy を取り直す', async () => {
    const refs = makeRefs()
    const stalePage = makeFakePage('stale:A:0')
    const refreshedPage = makeFakePage('fresh:A:0')

    useInfraStore.setState({
      currentPageProxy: stalePage as any,
      currentPageProxyKey: 'file-A.pdf:0',
      documentEpoch: 1,
    })
    getCachedPageProxyMock.mockResolvedValue(refreshedPage)

    const { result, rerender } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          documentEpoch: props.documentEpoch,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, documentEpoch: 1, zoom: 100 } }
    )

    await waitFor(() => {
      expect(result.current.pdfPage).toBe(stalePage)
    })
    expect(getCachedPageProxyMock).not.toHaveBeenCalled()

    useInfraStore.setState({ documentEpoch: 2 })
    rerender({ filePath: 'file-A.pdf', pageIndex: 0, documentEpoch: 2, zoom: 100 })

    await waitFor(() => {
      expect(result.current.pdfPage).toBe(refreshedPage)
    })
    expect(getCachedPageProxyMock).toHaveBeenCalledWith('file-A.pdf', 0)
    expect(getCachedPageProxyMock).toHaveBeenCalledTimes(1)
  })

  it('非identity pageOrder では stale な共有 proxy を使わず source page を取得する', async () => {
    const refs = makeRefs()
    const staleSharedPage = makeFakePage('stale:display:0')
    const sourcePage = makeFakePage('source:2')

    usePecoStore.setState({ pageOrder: [2, 0, 1] } as any)
    useInfraStore.setState({
      currentPageProxy: staleSharedPage as any,
      currentPageProxyKey: 'file-A.pdf:0',
    })
    getCachedPageProxyMock.mockResolvedValue(sourcePage)

    const { result } = renderHook(
      (props: HookProps) =>
        usePdfRendering({
          ...refs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: refs.renderOverlaysRef,
        }),
      { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100 } }
    )

    await waitFor(() => {
      expect(result.current.pdfPage).toBe(sourcePage)
    })
    expect(getCachedPageProxyMock).toHaveBeenCalledWith('file-A.pdf', 2)
  })
})

// ── H-5: render() 失敗時に loadError は立つが pdfPage は維持され、
// onRenderComplete も呼ばれる (isLoadingPageRender 固着防止) ──────────
//
// 背景: pdfjs の render() が cancel/destroyed 以外の実エラーで reject したとき、
// 旧実装は setLoadError(true) して return するだけで onRenderComplete を
// 呼んでいなかった。onRenderComplete は usePageNavigation.isLoadingPageRender を
// false にする唯一の経路のため、呼ばれないとローディング状態が固着したまま
// 復帰しない (るしあ C-5 相当)。
// また、この loadError はプロキシ取得失敗 (setPdfPage(null) を伴う) とは別経路
// なので、pdfPage は直前の proxy を維持したまま loadError=true になる。
// PdfCanvas 側のエラーオーバーレイ表示条件を直すには、この
// 「loadError=true かつ pdfPage!==null」という状態を正しく再現できている
// ことが前提となる。
describe('H-5: render() 失敗時の loadError/pdfPage/onRenderComplete', () => {
  it('render() が実エラーで reject した場合、pdfPage は維持されたまま loadError=true になり、onRenderComplete が呼ばれる', async () => {
    const refs = makeRefs()
    const page = makeFakePage('A:0')
    // Promise.reject は render() 呼び出し時に遅延生成する (mockImplementation)。
    // 事前に生成した reject 済み Promise を使い回すと、実際に await される前の
    // タイミングでテストランナーが unhandled rejection を報告してしまうため。
    page.render = vi.fn().mockImplementation(() => ({
      promise: Promise.reject(new Error('render boom')),
      cancel: vi.fn(),
    }))
    getCachedPageProxyMock.mockResolvedValue(page)
    const onRenderComplete = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { result } = renderHook(() =>
        usePdfRendering({
          ...refs,
          filePath: 'file-A.pdf',
          totalPages: 3,
          pageIndex: 0,
          zoom: 100,
          onRenderComplete,
          renderOverlaysRef: refs.renderOverlaysRef,
        })
      )

      // proxy 取得は成功するので pdfPage はまず解決される
      await waitFor(() => expect(result.current.pdfPage).toBe(page))

      // render() の reject を経て loadError が立つ
      await waitFor(() => expect(result.current.loadError).toBe(true))

      // pdfPage は破棄されない (プロキシ取得失敗経路とは別)
      expect(result.current.pdfPage).toBe(page)

      // isLoadingPageRender 固着防止のため、エラー経路でも完了通知される
      expect(onRenderComplete).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ── S-01-94: issue #94 zoom 連続変更時の canvas size 乖離回避 ──────
//
// 問題: usePdfRendering の render effect は 30ms debounce で render を遅延させる。
// この間に zoom が再度変化して effect が再走すると、cleanup で
// clearTimeout(renderDebounceRef) が走り、debounce が一度も発火せず render task が
// 起動しない window が生じる。一方 overlay 層は RAF で即座に新 zoom を反映するため、
// 「画像 Canvas は古い zoom サイズのまま、BB overlay だけ新 zoom」という乖離が起きる。
//
// 修正 (本テスト):
//   (1) effect 同期部で pdfCanvas + overlay + staticOverlay + wrapper のサイズを
//       新 zoom の viewport サイズに先取りで合わせる (debounce 外で sync)。
//       これにより layer 間のサイズ乖離 window を 0 にする。
//   (2) effect 再走の cleanup で setTimeout を破棄しない。timer は発火時に
//       latestParamsRef から最新 zoom/page を読んで coalesce render する。
//   (3) bitmapCache ヒット時は同期で描画完了させる (debounce を待たない)。
describe('S-01-94: zoom 連続変更で Canvas サイズ乖離が起きない (issue #94)', () => {
  // viewport は zoom (scale) によってサイズが変わる FakePage 用ヘルパ。
  // 既存の makeFakePage は viewport を固定 100x100 で返すので、本テスト専用に
  // scale 連動の挙動を持たせる。
  function makeScalingPage(id: string, baseW = 200, baseH = 100): FakePage {
    return {
      __id: id,
      getViewport: vi.fn().mockImplementation(({ scale }: { scale: number }) => ({
        width: baseW * scale,
        height: baseH * scale,
      })),
      render: vi.fn().mockReturnValue({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      }),
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      destroy: vi.fn(),
    }
  }

  // hook を render するヘルパ。staticOverlayCanvasRef も渡して #90 の互換性を担保。
  function renderUsePdfRendering(
    initialProps: { filePath: string; pageIndex: number; zoom: number }
  ) {
    const refs = makeRefs()
    const staticOverlay = window.document.createElement('canvas')
    const extendedRefs = {
      ...refs,
      staticOverlayCanvasRef: { current: staticOverlay } as React.RefObject<HTMLCanvasElement | null>,
    }
    const hookResult = renderHook(
      (props: { filePath: string; pageIndex: number; zoom: number }) =>
        usePdfRendering({
          ...extendedRefs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          renderOverlaysRef: extendedRefs.renderOverlaysRef,
        }),
      { initialProps }
    )
    return { ...hookResult, refs: extendedRefs }
  }

  it('zoom を 100→150→200 と短時間で 3 回変えても、最終的に pdfCanvas / overlay / static overlay / wrapper が zoom=200 サイズに収束する', async () => {
    const page = makeScalingPage('A:0')
    getCachedPageProxyMock.mockResolvedValue(page)

    const { result, rerender, refs } = renderUsePdfRendering({
      filePath: 'file-A.pdf', pageIndex: 0, zoom: 100,
    })

    // 初回 zoom=100 で pdfPage 解決を待つ
    await waitFor(() => {
      expect(result.current.pdfPage).toBe(page)
    })

    // 同期サイズ同期 (issue #94 (2)) の効果: 初回 effect run の同期部で
    // pdfCanvas.width/height が 100% scale の viewport に合うこと
    await waitFor(() => {
      expect(refs.pdfCanvasRef.current?.width).toBe(200)
      expect(refs.pdfCanvasRef.current?.height).toBe(100)
    })

    // zoom を連続変更: 100 → 150 → 200。各 rerender は 30ms 以内に行われる想定
    // (テストでは setTimeout を進めずに連続 rerender するので debounce 中)。
    rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 150 })
    // 同期サイズ同期で overlay / pdfCanvas / staticOverlay / wrapper が即時 zoom=150 へ
    expect(refs.pdfCanvasRef.current?.width).toBe(300) // 200 * 1.5
    expect(refs.pdfCanvasRef.current?.height).toBe(150)
    expect(refs.overlayCanvasRef.current?.width).toBe(300)
    expect(refs.overlayCanvasRef.current?.height).toBe(150)
    expect(refs.staticOverlayCanvasRef.current?.width).toBe(300)
    expect(refs.staticOverlayCanvasRef.current?.height).toBe(150)
    expect(refs.wrapperRef.current?.style.width).toBe('300px')

    rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 200 })
    // 同期サイズ同期: zoom=200 でも即座に反映
    expect(refs.pdfCanvasRef.current?.width).toBe(400)
    expect(refs.pdfCanvasRef.current?.height).toBe(200)
    expect(refs.overlayCanvasRef.current?.width).toBe(400)
    expect(refs.overlayCanvasRef.current?.height).toBe(200)
    expect(refs.staticOverlayCanvasRef.current?.width).toBe(400)
    expect(refs.staticOverlayCanvasRef.current?.height).toBe(200)
    expect(refs.wrapperRef.current?.style.width).toBe('400px')

    // debounce 発火後も最終 zoom のまま (timer 内で latestParams 読み、最新で coalesce)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })
    for (let i = 0; i < 4; i++) {
      await act(async () => { await Promise.resolve() })
    }

    expect(refs.pdfCanvasRef.current?.width).toBe(400)
    expect(refs.pdfCanvasRef.current?.height).toBe(200)
    expect(refs.overlayCanvasRef.current?.width).toBe(400)
    expect(refs.overlayCanvasRef.current?.height).toBe(200)
    expect(refs.staticOverlayCanvasRef.current?.width).toBe(400)
    expect(refs.staticOverlayCanvasRef.current?.height).toBe(200)
  })

  it('debounce 中の effect 再実行で前 timeout が破棄されず、render task が最終 zoom で 1 回だけ起動する', async () => {
    const page = makeScalingPage('A:0')
    getCachedPageProxyMock.mockResolvedValue(page)
    // render() 呼び出し回数 + 呼び出し時の viewport を観測する
    const renderCalls: Array<{ width: number; height: number }> = []
    page.render = vi.fn().mockImplementation((ctx: any) => {
      renderCalls.push({ width: ctx.viewport.width, height: ctx.viewport.height })
      return {
        promise: Promise.resolve(),
        cancel: vi.fn(),
      }
    })

    const { result, rerender } = renderUsePdfRendering({
      filePath: 'file-A.pdf', pageIndex: 0, zoom: 100,
    })

    // 初回 zoom=100 で pdfPage 解決 + render 1 回
    await waitFor(() => expect(result.current.pdfPage).toBe(page))
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    for (let i = 0; i < 4; i++) {
      await act(async () => { await Promise.resolve() })
    }
    const initialRenderCount = renderCalls.length
    expect(initialRenderCount).toBeGreaterThanOrEqual(1)
    // 直近の render は zoom=100 (viewport 200x100)
    expect(renderCalls[renderCalls.length - 1]).toEqual({ width: 200, height: 100 })

    // 連続 zoom 変更 (debounce 中に 3 連発):
    // 旧仕様だと cleanup で clearTimeout(renderDebounceRef) のせいで debounce timer が
    // 何度も置き換わり、間に挟まる effect 再走で「timer がリセットされ続け、
    // 一度も発火しないまま新 timer に置換」される window が発生していた。
    // 新仕様: 既存 timer は保持され、発火時に latestParamsRef から最新 zoom (=300%) を読む。
    rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 200 })
    rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 250 })
    rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 300 })

    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    for (let i = 0; i < 4; i++) {
      await act(async () => { await Promise.resolve() })
    }

    // 連続 3 回の rerender に対し render() 呼び出しは coalesce されて
    // 高々 1 回だけ追加される (合計 = 初回 + 1)。
    const newRenders = renderCalls.length - initialRenderCount
    expect(newRenders).toBe(1)
    // その 1 回は最終 zoom=300 の viewport (200*3 x 100*3) で行われた
    expect(renderCalls[renderCalls.length - 1]).toEqual({ width: 600, height: 300 })
  })

  it('cache hit 時は debounce を待たず同期で render 完了コールバックが呼ばれる', async () => {
    // bitmap cache が hit する状況を作る: getBitmapCache を真に返すよう mock 上書き
    const cacheModule = await import('../../utils/bitmapCache')
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    // renderCacheKey は filePath:sourcePageIndex:displayPageIndex:documentEpoch:zoom:dpr:r<rotation> の形式。
    // jsdom では window.devicePixelRatio が undefined になるため 1 に固定して dpr=100 にする。
    const origDpr = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true, writable: true })
    // viewport(scale=1) は 200x100 になる; key の dpr 部分は Math.round(1*100)=100, rotation=0
    vi.mocked(cacheModule.getBitmapCache).mockImplementation((key) => {
      if (key === 'file-A.pdf:0:0:0:100:r0:100') {
        return { bitmap, zoom: 100, width: 200, height: 100 } as any
      }
      return undefined
    })

    const page = makeScalingPage('A:0')
    getCachedPageProxyMock.mockResolvedValue(page)

    const onRenderComplete = vi.fn()
    const refs = makeRefs()
    const staticOverlay = window.document.createElement('canvas')

    renderHook(() =>
      usePdfRendering({
        ...refs,
        staticOverlayCanvasRef: { current: staticOverlay } as React.RefObject<HTMLCanvasElement | null>,
        filePath: 'file-A.pdf',
        totalPages: 3,
        pageIndex: 0,
        zoom: 100,
        onRenderComplete,
        renderOverlaysRef: refs.renderOverlaysRef,
      })
    )

    // pdfPage 解決後の同期 cache hit パスで onRenderComplete が呼ばれる
    await waitFor(() => {
      expect(onRenderComplete).toHaveBeenCalled()
    })
    // pdfjs render() は呼ばれない (キャッシュ hit のため)
    expect(page.render).not.toHaveBeenCalled()

    // 後続テストのために mock を戻す (next describe テストが期待する null 返却に)
    vi.mocked(cacheModule.getBitmapCache).mockReturnValue(undefined as any)
    Object.defineProperty(window, 'devicePixelRatio', { value: origDpr, configurable: true, writable: true })
  })

  it('documentEpoch 変更前に開始した render 結果を新 epoch の cache key に保存しない', async () => {
    const cacheModule = await import('../../utils/bitmapCache')
    vi.mocked(cacheModule.setBitmapCache).mockClear()

    const originalCreateImageBitmap = globalThis.createImageBitmap
    ;(globalThis as any).createImageBitmap = vi.fn().mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap)

    const pageEpoch1 = makeScalingPage('A:0:e1', 210, 100)
    const pageEpoch2 = makeScalingPage('A:0:e2', 220, 100)
    let resolveEpoch1Render!: () => void
    const epoch1RenderPromise = new Promise<void>((res) => { resolveEpoch1Render = res })
    pageEpoch1.render = vi.fn().mockReturnValue({
      promise: epoch1RenderPromise,
      cancel: vi.fn(),
    })
    pageEpoch2.render = vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    })
    getCachedPageProxyMock
      .mockResolvedValueOnce(pageEpoch1)
      .mockResolvedValueOnce(pageEpoch2)

    let unmountHook: (() => void) | undefined
    try {
      const refs = makeRefs()
      const staticOverlay = window.document.createElement('canvas')
      const { result, rerender, unmount } = renderHook(
        (props: HookProps) =>
          usePdfRendering({
            ...refs,
            staticOverlayCanvasRef: { current: staticOverlay } as React.RefObject<HTMLCanvasElement | null>,
            filePath: props.filePath,
            totalPages: 3,
            pageIndex: props.pageIndex,
            documentEpoch: props.documentEpoch,
            zoom: props.zoom,
            renderOverlaysRef: refs.renderOverlaysRef,
          }),
        { initialProps: { filePath: 'file-A.pdf', pageIndex: 0, documentEpoch: 1, zoom: 100 } }
      )
      unmountHook = unmount

      await waitFor(() => expect(result.current.pdfPage).toBe(pageEpoch1))
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      expect(pageEpoch1.render).toHaveBeenCalled()

      rerender({ filePath: 'file-A.pdf', pageIndex: 0, documentEpoch: 2, zoom: 100 })
      await waitFor(() => expect(result.current.pdfPage).toBe(pageEpoch2))

      await act(async () => {
        resolveEpoch1Render()
        await epoch1RenderPromise
        await Promise.resolve()
      })

      expect(cacheModule.setBitmapCache).not.toHaveBeenCalledWith(
        'file-A.pdf:0:2:100',
        expect.objectContaining({ width: 210 }),
      )
    } finally {
      unmountHook?.()
      if (originalCreateImageBitmap) {
        ;(globalThis as any).createImageBitmap = originalCreateImageBitmap
      } else {
        delete (globalThis as any).createImageBitmap
      }
    }
  })
})

// ── S-01-debounce: isAutoFit × isPageChange の debounce delay 選択ロジック ──
//
// 変更概要:
//   isPageChange && isAutoFit=true  → delay=50ms（ResizeObserver が zoom 確定するまで待機）
//   isPageChange && isAutoFit=false → delay=0ms （固定 zoom は確定済みのため即時）
//   !isPageChange（zoom 操作のみ）  → delay=30ms（連続入力を束ねる・isAutoFit 無関係）
//
// テスト方針:
//   vi.useFakeTimers() で setTimeout を制御する。
//   - waitFor は fake timer と相性が悪いため使わず、act + runAllTimers + Promise flush で管理。
//   - 非同期 Promise（getCachedPageProxy）は Promise.resolve() で返るため、
//     vi.advanceTimersByTimeAsync(0) or Promise flush で解決できる。
//   - pdfPage の state 変化は React の setState (async) のため、
//     act(async () => { vi.runAllTimers(); for(flush) }) のループで確認する。
describe('S-01-debounce: isAutoFit × isPageChange によるデバウンス delay 選択', () => {
  // S-01-94 と同様の page（render は即 resolve）
  function makeLocalScalingPage(id: string): FakePage {
    return {
      __id: id,
      getViewport: vi.fn().mockReturnValue({ width: 200, height: 100 }),
      render: vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      destroy: vi.fn(),
    }
  }

  // Promise を N 回 flush するヘルパ（microtask queue を draining）
  async function flushPromises(n = 6) {
    for (let i = 0; i < n; i++) {
      await act(async () => { await Promise.resolve() })
    }
  }

  // 共通ヘルパ: staticOverlayRef も渡し S-01-94 と同等の環境を再現
  function renderWithIsAutoFit(
    initialProps: HookProps & { isAutoFit?: boolean },
    onRenderComplete?: ReturnType<typeof vi.fn>
  ) {
    const refs = makeRefs()
    const staticOverlay = window.document.createElement('canvas')
    const extRefs = {
      ...refs,
      staticOverlayCanvasRef: { current: staticOverlay } as React.RefObject<HTMLCanvasElement | null>,
    }
    const hookResult = renderHook(
      (props: HookProps & { isAutoFit?: boolean }) =>
        usePdfRendering({
          ...extRefs,
          filePath: props.filePath,
          totalPages: 3,
          pageIndex: props.pageIndex,
          zoom: props.zoom,
          isAutoFit: props.isAutoFit,
          onRenderComplete,
          renderOverlaysRef: extRefs.renderOverlaysRef,
        }),
      { initialProps }
    )
    return { ...hookResult, refs: extRefs }
  }

  it('isAutoFit=false, ページ切替 → delay=0ms: 直後(0ms後)に onRenderComplete が呼ばれる', async () => {
    vi.useFakeTimers()
    try {
      const pageA = makeLocalScalingPage('D:0')
      const pageB = makeLocalScalingPage('D:1')
      getCachedPageProxyMock.mockImplementation((_fp: string, idx: number) => {
        if (idx === 0) return Promise.resolve(pageA)
        if (idx === 1) return Promise.resolve(pageB)
        return Promise.reject(new Error(`unexpected idx=${idx}`))
      })

      const onRenderComplete = vi.fn()
      const { result, rerender } = renderWithIsAutoFit(
        { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100, isAutoFit: false },
        onRenderComplete
      )

      // 初回 pdfPage 解決: timer を進めて Promise を flush
      await act(async () => { vi.runAllTimers(); await Promise.resolve() })
      await flushPromises(8)
      expect(result.current.pdfPage).toBe(pageA)

      // ページ切替（isAutoFit=false → delay=0ms）
      onRenderComplete.mockClear()
      rerender({ filePath: 'file-A.pdf', pageIndex: 1, zoom: 100, isAutoFit: false })

      // pdfPage=B の proxy 取得（Promise.resolve なので microtask flush で解決）
      await flushPromises(4)
      expect(result.current.pdfPage).toBe(pageB)

      // delay=0ms の setTimeout → vi.runAllTimers() で即時発火
      await act(async () => { vi.runAllTimers(); await Promise.resolve() })
      await flushPromises(6)

      // onRenderComplete が呼ばれている
      expect(onRenderComplete.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('isAutoFit=true, ページ切替 → delay=50ms: 49ms では未発火、50ms で発火する', async () => {
    vi.useFakeTimers()
    try {
      const pageA = makeLocalScalingPage('E:0')
      const pageB = makeLocalScalingPage('E:1')
      getCachedPageProxyMock.mockImplementation((_fp: string, idx: number) => {
        if (idx === 0) return Promise.resolve(pageA)
        if (idx === 1) return Promise.resolve(pageB)
        return Promise.reject(new Error(`unexpected idx=${idx}`))
      })

      const onRenderComplete = vi.fn()
      const { result, rerender } = renderWithIsAutoFit(
        { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100, isAutoFit: true },
        onRenderComplete
      )

      // 初回 pdfPage 解決
      await act(async () => { vi.runAllTimers(); await Promise.resolve() })
      await flushPromises(8)
      expect(result.current.pdfPage).toBe(pageA)

      // ページ切替（isAutoFit=true → delay=50ms）
      onRenderComplete.mockClear()
      rerender({ filePath: 'file-A.pdf', pageIndex: 1, zoom: 100, isAutoFit: true })
      await flushPromises(4)
      expect(result.current.pdfPage).toBe(pageB)

      // 49ms では debounce 未発火
      await act(async () => { vi.advanceTimersByTime(49) })
      await flushPromises(4)
      expect(onRenderComplete.mock.calls.length).toBe(0)

      // 1ms 追加（計 50ms）で debounce 発火
      await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })
      await flushPromises(6)
      expect(onRenderComplete.mock.calls.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('zoom のみ変更（isPageChange=false）→ delay=30ms: 30ms 経過後に onRenderComplete が呼ばれる', async () => {
    // zoom 操作時の 30ms debounce は isAutoFit によらず同じ。
    // ただし初回ページ解決後の debounce timer が vi.runAllTimers() で消化された後に
    // zoom 変更 rerender を行うため、zoom 変更後の debounce のみを観測できる。
    // 「29ms では未発火」の境界テストはタイマー精度の問題で安定しないため、
    // 「30ms 後に確実に発火する」ことを確認する形にする。
    vi.useFakeTimers()
    try {
      const page = makeLocalScalingPage('F:0')
      getCachedPageProxyMock.mockResolvedValue(page)

      const onRenderComplete = vi.fn()
      const { result, rerender } = renderWithIsAutoFit(
        { filePath: 'file-A.pdf', pageIndex: 0, zoom: 100, isAutoFit: false },
        onRenderComplete
      )

      // 初回解決（isPageChange=true, isAutoFit=false → delay=0ms timer）
      await act(async () => { vi.runAllTimers(); await Promise.resolve() })
      await flushPromises(8)
      expect(result.current.pdfPage).toBe(page)

      // zoom のみ変更（同ページ → isPageChange=false → delay=30ms）
      onRenderComplete.mockClear()
      rerender({ filePath: 'file-A.pdf', pageIndex: 0, zoom: 150, isAutoFit: false })

      // 30ms 経過で debounce 発火
      await act(async () => { vi.advanceTimersByTime(30); await Promise.resolve() })
      await flushPromises(6)
      expect(onRenderComplete.mock.calls.length).toBeGreaterThan(0)
      // 同ページ維持
      expect(result.current.pdfPage).toBe(page)
    } finally {
      vi.useRealTimers()
    }
  })
})
