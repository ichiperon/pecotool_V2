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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

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

afterEach(() => {
  cleanup()
})

// disable requestIdleCallback so Step-2 prefetch doesn't run extra loadPage calls.
beforeEach(() => {
  // 'requestIdleCallback' in window が false になるよう削除
  if ('requestIdleCallback' in window) {
    delete (window as any).requestIdleCallback
  }
})

// 各テスト後に renderHook で mount したコンポーネントを unmount する
// (前テストが await 中の効果フックを次テストへ残さないように)
afterEach(() => {
  cleanup()
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
    expect(loadPageMock.mock.calls.find((c) => c[1] === 0)?.[3]).toBe(fakeMeta)

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

describe('S-01-06 (#99): loadPage 呼び出し時点で bboxMetaRef が解決済みであること', () => {
  it('loadPage は bboxMeta が resolve した後にのみ呼ばれ、第4引数に meta が渡る', async () => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    const fakePdf = { numPages: 1 }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    // bboxMeta を手動制御。resolve しないと loadPage は呼ばれてはならない。
    let resolveMeta!: (m: any) => void
    const metaPromise = new Promise<any>((res) => { resolveMeta = res })
    loadPecoToolBBoxMetaMock.mockReturnValue(metaPromise)

    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    const stableShowToast = vi.fn()
    const stableTriggerThumbnail = vi.fn()

    renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: stableShowToast,
        triggerThumbnailLoad: stableTriggerThumbnail,
      })
    )

    // bboxMeta が pending の間は loadPage を呼んではならない。
    // (旧実装は fire-and-forget で loadPage を即実行していたため、ここで loadPage が
    //  呼ばれていた → bboxMetaRef=null のまま pdfjs fallback 経路に落ちる主因。)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(loadPageMock).not.toHaveBeenCalled()

    // bboxMeta を resolve すると、解決済みの meta を持って loadPage が呼ばれる。
    const fakeMeta = { '0': [{ bbox: { x: 1, y: 2, width: 3, height: 4 }, writingMode: 'horizontal', order: 0, text: 'x' }] }
    resolveMeta(fakeMeta)

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalled()
    })

    const firstCall = loadPageMock.mock.calls[0]
    // loadPage(pdf, pageIdx, filePath, bboxMeta, mtime)
    expect(firstCall[1]).toBe(0)
    expect(firstCall[3]).toEqual(fakeMeta) // ← meta が解決済みで渡されている
  })

  it('loadPecoToolBBoxMeta が reject しても bboxMetaRef は null になり loadPage は実行される', async () => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    const fakePdf = { numPages: 1 }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    // meta loader が reject するケース (旧フローでは catch でつぶしていた)
    loadPecoToolBBoxMetaMock.mockRejectedValue(new Error('metadata stream corrupt'))
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    const stableShowToast2 = vi.fn()
    const stableTriggerThumbnail2 = vi.fn()

    renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: stableShowToast2,
        triggerThumbnailLoad: stableTriggerThumbnail2,
      })
    )

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalled()
    })

    const firstCall = loadPageMock.mock.calls[0]
    expect(firstCall[3]).toBeNull() // bboxMeta=null で pdfjs fallback 経路に確定的に落ちる
  })
})

describe('S-01-05: unmount 後に bboxMeta が resolve しても追加 loadPage は発火しない', () => {
  it('bboxMeta resolve 前にアンマウント → 以降の loadPage は新たに発火しない', async () => {
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

    // showToast / triggerThumbnailLoad を stable 参照にする
    // (renderHook の再レンダ時に新しい vi.fn() が渡されると loadCurrentPage useCallback の
    //  identity が変わり、effect が再実行されて複数の loadCurrentPage が並列に走る。
    //  本テストはアンマウント抑制を見るためにこの並列実行は防ぐ。)
    const stableShowToast = vi.fn()
    const stableTriggerThumbnail = vi.fn()

    const { unmount } = renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: stableShowToast,
        triggerThumbnailLoad: stableTriggerThumbnail,
      })
    )

    // #99 修正後: loadPage は bboxMeta await の完了後にのみ呼ばれる。
    // resolve 前にアンマウントすれば、その後の resolve でも abort 済みなので loadPage は走らない。
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 現時点での呼び出し回数を計測 (meta 未 resolve なので 0 のはず)
    const callsBeforeAbort = loadPageMock.mock.calls.length
    expect(callsBeforeAbort).toBe(0)

    // アンマウント → controller.abort() がクリーンアップで呼ばれる
    unmount()

    // bboxMeta を後から resolve しても、abort 済みなので新規 loadPage は走らない
    resolveMeta({ '0': [], '1': [], '2': [], '3': [] })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 追加 loadPage は 1 度も呼ばれていないこと (meta await 後 signal.aborted で return)
    expect(loadPageMock.mock.calls.length).toBe(callsBeforeAbort)
  })
})

describe('documentLoadId: 同一 filePath / currentPageIndex の再読込', () => {
  it('document identity が変わったら同じ filePath/currentPageIndex でも loadPage を再発火する', async () => {
    const filePath = 'same-path.pdf'
    const fakePdf = { numPages: 1 }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })
    const metaA = { '0': [{ bbox: { x: 1, y: 1, width: 10, height: 10 }, writingMode: 'horizontal', order: 0, text: 'old' }] }
    const metaB = { '0': [{ bbox: { x: 2, y: 2, width: 20, height: 20 }, writingMode: 'horizontal', order: 0, text: 'restored' }] }
    loadPecoToolBBoxMetaMock
      .mockResolvedValueOnce(metaA)
      .mockResolvedValueOnce(metaB)
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    const docA: PecoDocument = {
      filePath,
      fileName: filePath,
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({
      document: docA,
      documentLoadId: 1,
      currentPageIndex: 0,
    } as any)

    const showToast = vi.fn()
    const triggerThumbnailLoad = vi.fn()

    renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast,
        triggerThumbnailLoad,
      })
    )

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalledWith(
        fakePdf,
        0,
        filePath,
        metaA,
        1234
      )
    })

    await Promise.resolve()
    await Promise.resolve()
    loadPageMock.mockClear()
    await Promise.resolve()
    expect(loadPageMock).not.toHaveBeenCalled()

    const docB: PecoDocument = {
      filePath,
      fileName: filePath,
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({
      document: docB,
      documentLoadId: 2,
      currentPageIndex: 0,
    } as any)

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalledWith(
        fakePdf,
        0,
        filePath,
        metaB,
        1234
      )
    })
    expect(loadPecoToolBBoxMetaMock).toHaveBeenCalledTimes(2)
  })
})
