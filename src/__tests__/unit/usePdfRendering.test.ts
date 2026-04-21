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
  zoom: number
}

beforeEach(() => {
  getCachedPageProxyMock.mockReset()
  // store の currentPageProxy をリセット（前テストの残留を防ぐ）
  usePecoStore.setState({ currentPageProxy: null, currentPageProxyKey: null } as any)
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
})

describe('S-01-06: store.currentPageProxy 共有チャネル経由で二重 getCachedPageProxy を回避', () => {
  it('currentPageProxyKey が一致すれば getCachedPageProxy を呼ばず store の proxy を使う', async () => {
    const refs = makeRefs()
    const sharedPage = makeFakePage('shared:A:0')

    // store に事前 publish しておく
    usePecoStore.setState({
      currentPageProxy: sharedPage as any,
      currentPageProxyKey: 'file-A.pdf:0',
    } as any)

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
})
