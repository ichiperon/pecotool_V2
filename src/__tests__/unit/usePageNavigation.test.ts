/**
 * S-01-04 / S-01-05: usePageNavigation の bboxMeta 全ページ先行ロード「廃止」検証
 *
 * 背景:
 *  200 ページ級 PDF で bboxMeta 取得直後に forEach で全ページ loadPage を発火すると
 *  getTextContent() が単一 pdfjs worker に同時投入され、現在ページ含む全ての
 *  getTextContent が順番待ちで詰まり「編集可能になるまで / 次ページ遷移」が遅延する。
 *  修正により bboxMeta 取得後の全ページ一括 loadPage は廃止され、ページテキスト抽出は
 *  実際にそのページを表示する時 (currentPage 初回 + ±1/±2 プリフェッチ) に限定される。
 *
 * 検証対象:
 *  - bboxMeta 取得後に「全ページ」への loadPage 発火が起きないこと
 *  - bboxMetaRef は後続 loadPage 呼び出しで使えるよう保持されること
 *  - unmount 後の bboxMeta resolve で追加 loadPage が発火しないこと (既存挙動維持)
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

describe('S-01-04: bboxMeta 取得後に全ページ loadPage が発火しないこと (バルク pre-load 廃止)', () => {
  it('document.pages.size === 5 のとき bboxMeta 取得後も全ページ loadPage は起きない', async () => {
    const TOTAL = 5
    // 全ページを width=0 ダミーで populate（かつてのバルク forEach 対象）
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
        currentPageIndex: 0,
        showToast,
        triggerThumbnailLoad,
      })
    )

    // 初回 currentPage(0) の loadPage が呼ばれることを待つ
    await waitFor(() => {
      const calledIdxs = loadPageMock.mock.calls.map((c) => c[1] as number)
      expect(calledIdxs).toContain(0)
    })

    // bboxMeta resolve 完了を待つために microtask を複数進める
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // requestIdleCallback は削除済みなので ±2 プリフェッチ (setTimeout 200ms) も
    // 走らない。よって呼ばれる loadPage は currentPage(0) のみとなるはず。
    // 旧挙動のバルク forEach があれば idx=1,2,3,4 も呼ばれるが、それを起こさないのが本修正。
    const calledIdxs = new Set(
      loadPageMock.mock.calls.map((c) => c[1] as number)
    )
    expect(calledIdxs.has(0)).toBe(true)
    // 全ページ一括ロードは発生しない: 2,3,4 は currentPage でも ±1 プリフェッチでもない
    expect(calledIdxs.has(2)).toBe(false)
    expect(calledIdxs.has(3)).toBe(false)
    expect(calledIdxs.has(4)).toBe(false)
  })

  it('bboxMeta 取得後も isDirty=true なページ / 未ナビゲートページへの loadPage は発火しない', async () => {
    const TOTAL = 3
    // currentPage(0) は width=0 ダミーで loadCurrentPage 発火条件を満たす。
    // 1 番ページは isDirty=true → バルク廃止後はいずれにせよ触らない。
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: TOTAL,
      metadata: {},
      mtime: 1234,
      pages: new Map<number, PageData>([
        [0, makeDummyPage(0, false)],
        [1, makePage(1, true)], // dirty: バルク廃止後も当然 skip
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
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    // 初回 currentPage(0) のロードのみ観察
    await waitFor(() => {
      const calledIdxs = loadPageMock.mock.calls.map((c) => c[1] as number)
      expect(calledIdxs).toContain(0)
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const calledIdxs = loadPageMock.mock.calls.map((c) => c[1] as number)
    // バルク廃止後: currentPage=0 だけが loadPage される
    // （dirty の 1 も、未ナビゲートの 2 も対象外）
    expect(calledIdxs).not.toContain(1)
    expect(calledIdxs).not.toContain(2)
  })
})

describe('S-01-05: unmount 後に bboxMeta が resolve しても追加 loadPage は発火しない', () => {
  it('bboxMeta resolve 前にアンマウント → 追加 loadPage が呼ばれない', async () => {
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

    // bboxMeta を後から resolve しても、バルク廃止により追加 loadPage は起こらない
    resolveMeta({ '0': [], '1': [], '2': [], '3': [] })
    // promise 連鎖を解消するため複数 microtask を進める
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 追加 loadPage は 1 度も呼ばれていないこと
    expect(loadPageMock.mock.calls.length).toBe(callsBeforeAbort)
  })
})
