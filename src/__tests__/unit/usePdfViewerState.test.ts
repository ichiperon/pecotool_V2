import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// pdfjs-dist は jsdom 環境で DOMMatrix を要求するため pdfLoader 経由でも import を避ける
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
}))

import { usePdfViewerState } from '../../hooks/usePdfViewerState'
import { usePecoStore } from '../../store/pecoStore'
import { useViewerStore } from '../../store/viewerStore'
import type { PecoDocument, PageData } from '../../types'

// ── ResizeObserver スパイ ──
// new ResizeObserver(cb) が何回呼ばれたかを観測する
let observerConstructCount = 0
const observerInstances: Array<{
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  cb: ResizeObserverCallback
}> = []

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
  cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    observerConstructCount += 1
    observerInstances.push(this as any)
  }
}

;(globalThis as any).ResizeObserver = MockResizeObserver

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  }
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

beforeEach(() => {
  observerConstructCount = 0
  observerInstances.length = 0
  usePecoStore.setState({
    document: makeDoc(new Map([
      [0, makePage({ pageIndex: 0, width: 595, height: 842 })],
      [1, makePage({ pageIndex: 1, width: 800, height: 1000 })],
      [2, makePage({ pageIndex: 2, width: 595, height: 842 })],
    ])),
    currentPageIndex: 0,
  } as any)
  useViewerStore.setState({ zoom: 100 })
})

afterEach(() => {
  vi.clearAllMocks()
})

// renderHook で viewerRef にコンテナを差し込む小さなラッパー hook。
// useEffect 内で viewerRef.current = container を割り当てて、
// 直後の effect (ResizeObserver 構築) に container を見せる。
function useWithContainer(pageIndex: number, container: HTMLDivElement | null) {
  const state = usePdfViewerState(pageIndex)
  // strict 等で前後 effect 順を入れ替えないよう viewerRef は即代入する
  if (container) (state.viewerRef as any).current = container
  return state
}

describe('usePdfViewerState (issue #26)', () => {
  it('viewerRef にコンテナをアタッチした状態でページ切替しても ResizeObserver が再生成されない', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true })
    document.body.appendChild(container)

    const { rerender, result } = renderHook(
      ({ pageIndex, c }: { pageIndex: number; c: HTMLDivElement | null }) =>
        useWithContainer(pageIndex, c),
      { initialProps: { pageIndex: 0, c: container } }
    )

    // 初回 mount で ResizeObserver が 1 つ生成されている前提
    const initialCount = observerConstructCount
    expect(initialCount).toBeGreaterThanOrEqual(1)

    // ページを 0 → 1 → 2 → 0 と切替
    act(() => {
      usePecoStore.setState({ currentPageIndex: 1 } as any)
    })
    rerender({ pageIndex: 1, c: container })

    act(() => {
      usePecoStore.setState({ currentPageIndex: 2 } as any)
    })
    rerender({ pageIndex: 2, c: container })

    act(() => {
      usePecoStore.setState({ currentPageIndex: 0 } as any)
    })
    rerender({ pageIndex: 0, c: container })

    // ページ切替で ResizeObserver は再生成されてはならない (issue #26)
    expect(observerConstructCount).toBe(initialCount)

    // fitToScreen の中身が変わっても (pageWidth/Height が変わる = useCallback の identity が変化)
    // observer は再生成されない
    act(() => {
      result.current.setIsAutoFit(false)
    })
    rerender({ pageIndex: 0, c: container })
    act(() => {
      result.current.setIsAutoFit(true)
    })
    rerender({ pageIndex: 0, c: container })
    expect(observerConstructCount).toBe(initialCount)

    document.body.removeChild(container)
  })

  it('isAutoFit が false の間は ResizeObserver コールバックが fitToScreen を呼ばない (ref 経由)', async () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true })
    document.body.appendChild(container)

    const { rerender, result } = renderHook(
      ({ pageIndex, c }: { pageIndex: number; c: HTMLDivElement | null }) =>
        useWithContainer(pageIndex, c),
      { initialProps: { pageIndex: 0, c: container } }
    )

    // isAutoFit を false にしてから resize callback を発火しても zoom が変わらない
    act(() => {
      result.current.setIsAutoFit(false)
    })
    rerender({ pageIndex: 0, c: container })

    // ref に isAutoFit=false が反映されたあとの zoom を baseline とする。
    // (mount 初期に fitToScreen が走って zoom が変わる場合があるため、
    //  ここを基準に「callback 前後で動かない」ことを検証する)
    const zoomBeforeCallback = useViewerStore.getState().zoom

    // 最新の observer の callback を呼ぶ
    const lastObserver = observerInstances[observerInstances.length - 1]
    expect(lastObserver).toBeDefined()
    act(() => {
      lastObserver.cb([] as any, lastObserver as any)
    })
    // rAF を flush
    await new Promise<void>((r) => requestAnimationFrame(() => r()))

    // isAutoFit=false のため zoom は変わらない
    expect(useViewerStore.getState().zoom).toBe(zoomBeforeCallback)

    document.body.removeChild(container)
  })
})
