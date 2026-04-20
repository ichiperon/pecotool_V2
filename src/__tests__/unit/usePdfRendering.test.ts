/**
 * S-01-01 〜 S-01-03: usePdfRendering の旧 transport 保護回帰テスト
 *
 * 検証対象:
 *  - filePath / pageIndex 変更時の useEffect 冒頭での setPdfPage(null) 先行クリア
 *  - 連続ページ切替で前回 render が次回 setPdfPage で置換されること
 *  - ファイル切替 A→B 時に A の pdfPage が必ず null クリアされてから B の pdfPage が set されること
 *
 * 注意: pdfjs render の cancel 動作自体は実 transport を要するため、ここでは
 *       「render が呼ばれる対象の pdfPage インスタンス」が直前で null クリア
 *       された後に新インスタンスへ差し替わる、という観察可能な振る舞いだけを検証する。
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
})

describe('S-01-01: filePath/pageIndex 変更時に setPdfPage(null) 先行クリア', () => {
  it('rerender 直後 result.current.pdfPage は一旦 null になり、await 後に新ページが set される', async () => {
    const refs = makeRefs()
    const pageA = makeFakePage('A:0')
    const pageB = makeFakePage('A:1')

    // 初回読込: pageA を返す
    getCachedPageProxyMock.mockResolvedValueOnce(pageA)

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

    // 次ページ用 mock をセットしてからページ変更
    getCachedPageProxyMock.mockResolvedValueOnce(pageB)
    rerender({ filePath: 'file-A.pdf', pageIndex: 1, zoom: 100 })

    // useEffect 冒頭の setPdfPage(null) で旧プロキシが即時クリアされる
    expect(result.current.pdfPage).toBeNull()

    // 新ページが set されるまで待機
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
    rerender({ filePath: 'file-A.pdf', pageIndex: 3, zoom: 100 })
    expect(result.current.pdfPage).toBeNull() // 3 への切替直後
    rerender({ filePath: 'file-A.pdf', pageIndex: 5, zoom: 100 })
    expect(result.current.pdfPage).toBeNull() // 5 への切替直後

    // 最終的に 5 が反映される
    await waitFor(() => expect(result.current.pdfPage).toBe(pageP5))

    // 3 つすべての pageIndex に対して getCachedPageProxy が呼ばれたこと
    const calledIdxs = getCachedPageProxyMock.mock.calls.map((c) => c[1])
    expect(calledIdxs).toEqual([1, 3, 5])
  })
})

describe('S-01-03: ファイル切替 A→B で A プロキシが null クリア後 B が set', () => {
  it('A の pdfPage は B の resolve 前に null になり、その後 B プロキシへ置換', async () => {
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

    // ファイル B へ切替: setPdfPage(null) が同期で走り、A プロキシは即座に消える
    rerender({ filePath: 'file-B.pdf', pageIndex: 0, zoom: 100 })
    expect(result.current.pdfPage).toBeNull()

    // この時点ではまだ B も resolve していない → null のまま
    // 次にイベントループが回るのを待っても null のはず
    await Promise.resolve()
    expect(result.current.pdfPage).toBeNull()

    // B を resolve すると pdfPage が B に切り替わる
    await act(async () => {
      resolveB(pageB)
      await bPromise
    })

    await waitFor(() => expect(result.current.pdfPage).toBe(pageB))
  })
})
