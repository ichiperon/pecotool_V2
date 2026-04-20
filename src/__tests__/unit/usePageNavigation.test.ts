/**
 * S-01-04 / S-01-05: usePageNavigation の bboxMeta 全ページ再ロード回帰テスト
 *
 * 検証対象:
 *  - bboxMeta 取得後に document.pages.size 回 loadPage が forEach で発火されること
 *  - 途中で signal.aborted=true になったら以降の loadPage が skip されること
 *
 * 注意: ページ寸法プリフェッチや requestIdleCallback 内のプリフェッチも loadPage を
 *       呼ぶため、本テストでは「初回 currentPage の loadPage」と「全ページ再ロードの
 *       loadPage」を pdf 引数の identity で見分ける。pageNavigation の loadPage は
 *       常に同じ pdf proxy を渡すので、pageIndex の集合で検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

// ── pdfLoader モック: getSharedPdfProxy / getCachedPageProxy /
// loadPage / loadPecoToolBBoxMeta を差し替える ──────────────────
const getSharedPdfProxyMock = vi.fn()
const getCachedPageProxyMock = vi.fn()
const loadPageMock = vi.fn()
const loadPecoToolBBoxMetaMock = vi.fn()

vi.mock('../../utils/pdfLoader', () => ({
  getSharedPdfProxy: (...args: unknown[]) => getSharedPdfProxyMock(...args),
  getCachedPageProxy: (...args: unknown[]) => getCachedPageProxyMock(...args),
  loadPage: (...args: unknown[]) => loadPageMock(...args),
  loadPecoToolBBoxMeta: (...args: unknown[]) => loadPecoToolBBoxMetaMock(...args),
}))

import { usePageNavigation } from '../../hooks/usePageNavigation'
import { usePecoStore } from '../../store/pecoStore'
import type { PecoDocument, PageData } from '../../types'

function makePage(pageIndex: number, isDirty = false, width = 100): PageData {
  return {
    pageIndex,
    width,
    height: 100,
    textBlocks: [],
    isDirty,
    thumbnail: null,
  }
}

/** width=0 のダミーページ: usePageNavigation の useEffect が loadCurrentPage を発火する条件 */
function makeDummyPage(pageIndex: number, isDirty = false): PageData {
  return makePage(pageIndex, isDirty, 0)
}


beforeEach(() => {
  getSharedPdfProxyMock.mockReset()
  getCachedPageProxyMock.mockReset()
  loadPageMock.mockReset()
  loadPecoToolBBoxMetaMock.mockReset()

  // store をクリーンに
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    currentPageIndex: 0,
  } as any)
})

// disable requestIdleCallback so Step-2 prefetch doesn't run extra loadPage calls.
beforeEach(() => {
  // 'requestIdleCallback' in window が false になるよう削除
  if ('requestIdleCallback' in window) {
    delete (window as any).requestIdleCallback
  }
})

describe('S-01-04: bboxMeta 取得後に全ページ loadPage が発火', () => {
  it('document.pages.size === 5 のとき loadPage が ≥5 回呼ばれ、全 pageIndex を網羅', async () => {
    const TOTAL = 5
    // 全ページを width=0 ダミーで populate（forEach 対象 + loadCurrentPage 発火条件）
    const pages = new Map<number, PageData>()
    for (let i = 0; i < TOTAL; i++) pages.set(i, makeDummyPage(i))
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: TOTAL,
      metadata: {},
      pages,
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    const fakePdf = { numPages: TOTAL }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    const fakeMeta = {
      '0': [], '1': [], '2': [], '3': [], '4': [],
    }
    loadPecoToolBBoxMetaMock.mockResolvedValue(fakeMeta)
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    const triggerThumbnailLoad = vi.fn()
    const showToast = vi.fn()

    renderHook(() =>
      usePageNavigation({
        document: doc,
        currentPageIndex: 0,
        showToast,
        triggerThumbnailLoad,
      })
    )

    // bboxMeta forEach が走るまで待機（全ページ 0..4 が呼ばれること）
    await waitFor(() => {
      const calledIdxs = new Set(
        loadPageMock.mock.calls.map((c) => c[1] as number)
      )
      for (let i = 0; i < TOTAL; i++) {
        expect(calledIdxs.has(i)).toBe(true)
      }
    })

    // currentPage(0) の初回 loadPage と forEach の 5 ページ分で
    // pageIndex 0 への loadPage は複数回呼ばれる可能性がある。
    // forEach での全ページ網羅が満たせていれば S-01-04 は成立。
  })

  it('isDirty=true なページは forEach 内で skip される', async () => {
    const TOTAL = 3
    // currentPage(0) は width=0 ダミーで loadCurrentPage 発火条件を満たす。
    // 1 番ページは isDirty=true → forEach で skip されること。
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: TOTAL,
      metadata: {},
      mtime: 1234,
      pages: new Map<number, PageData>([
        [0, makeDummyPage(0, false)],
        [1, makePage(1, true)], // dirty → forEach で skip
        [2, makeDummyPage(2, false)],
      ]),
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    const fakePdf = { numPages: TOTAL }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })
    loadPecoToolBBoxMetaMock.mockResolvedValue({ '0': [], '1': [], '2': [] })
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    renderHook(() =>
      usePageNavigation({
        document: doc,
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    // forEach での dirty スキップを観察するため少し待機
    await waitFor(() => {
      // 初回 currentPage(0) の loadPage は呼ばれている
      const calledIdxs = loadPageMock.mock.calls.map((c) => c[1] as number)
      expect(calledIdxs).toContain(0)
      expect(calledIdxs).toContain(2)
    })

    // forEach 内で pageIndex=1 (isDirty=true) は呼ばれない。
    // ただし currentPage 初回ロード(0) と forEach の 0,2 だけが想定。
    // 1 が forEach で呼ばれないことを確認。
    // (currentPage が 1 ではないため、初回 currentPage ロードでも 1 は呼ばれない)
    const calledIdxs = loadPageMock.mock.calls.map((c) => c[1] as number)
    expect(calledIdxs).not.toContain(1)
  })
})

describe('S-01-05: signal.aborted で以降の loadPage が skip', () => {
  it('bboxMeta resolve 前にアンマウント → forEach 内 loadPage が呼ばれない', async () => {
    const TOTAL = 4
    const pages = new Map<number, PageData>()
    for (let i = 0; i < TOTAL; i++) pages.set(i, makeDummyPage(i))
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: TOTAL,
      metadata: {},
      pages,
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    const fakePdf = { numPages: TOTAL }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    // bboxMeta を手動制御
    let resolveMeta!: (m: any) => void
    const metaPromise = new Promise<any>((res) => { resolveMeta = res })
    loadPecoToolBBoxMetaMock.mockReturnValue(metaPromise)

    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    const { unmount } = renderHook(() =>
      usePageNavigation({
        document: doc,
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    // 初回 currentPage(0) の loadPage が呼ばれるのを待つ
    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalled()
    })

    const callsBeforeAbort = loadPageMock.mock.calls.length

    // アンマウント → controller.abort() がクリーンアップで呼ばれる
    unmount()

    // bboxMeta を後から resolve しても forEach 内の loadPage は signal.aborted で全て skip される
    resolveMeta({ '0': [], '1': [], '2': [], '3': [] })
    // promise 連鎖を解消するため複数 microtask を進める
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // forEach の loadPage は1度も追加で呼ばれていないこと
    expect(loadPageMock.mock.calls.length).toBe(callsBeforeAbort)
  })
})
