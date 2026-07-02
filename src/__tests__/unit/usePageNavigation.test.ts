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
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import type React from 'react'

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
import { useInfraStore } from '../../store/infraStore'
import type { PecoDocument, PageData, TextBlock } from '../../types'

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

  usePecoStore.setState(usePecoStore.getInitialState(), true)
  // store をクリーンに
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    currentPageIndex: 0,
  })
  useInfraStore.setState({ documentEpoch: 0 })
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
    // loadPage(pdf, sourcePageIdx, filePath, bboxMeta, mtime, { displayPageIndex })
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

  it('非identity pageOrder では source page を読み、display page に書き戻す', async () => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 3,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({
      document: doc,
      currentPageIndex: 0,
      pageOrder: [2, 0, 1],
    } as any)

    const fakePdf = { numPages: 3 }
    getSharedPdfProxyMock.mockResolvedValue(fakePdf)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 300, height: 400 }),
    })
    loadPecoToolBBoxMetaMock.mockResolvedValue({ '0': [], '1': [], '2': [] })
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx, false, 300))
    )

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
      expect(loadPageMock).toHaveBeenCalledWith(fakePdf, 2, 'test.pdf', expect.anything(), 1234, { displayPageIndex: 0 })
    })
    expect(getCachedPageProxyMock).toHaveBeenCalledWith('test.pdf', 2)

    await waitFor(() => {
      const page = usePecoStore.getState().document!.pages.get(0)!
      expect(page.pageIndex).toBe(0)
      expect(page.width).toBe(300)
      expect(page.isTextExtracted).toBe(true)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// ページ番号入力 (handlePageInputCommit / handlePageInputKeyDown)。
// 1-based 入力 → 0-based index への変換と、範囲外/非数値の拒否は
// 「存在しないページへ飛んでクラッシュ」を防ぐ境界ロジック。未検証だった。
// ─────────────────────────────────────────────────────────────
describe('usePageNavigation: ページ番号入力のコミット (handlePageInputCommit)', () => {
  /**
   * setCurrentPage を spy に差し替えてから hook を mount する。
   * usePageNavigation は usePecoStore(s => s.setCurrentPage) で render 時に
   * 取得するため、spy は renderHook より前に store へ入れておく必要がある。
   */
  function renderNav(totalPages: number) {
    const setCurrentPageSpy = vi.fn()
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages,
      metadata: {},
      // currentPage は width>0 の実ページにして loadCurrentPage を発火させない
      pages: new Map<number, PageData>([[0, makePage(0, false, 100)]]),
      mtime: 1234,
    }
    usePecoStore.setState({
      document: doc,
      currentPageIndex: 0,
      setCurrentPage: setCurrentPageSpy,
    } as any)
    getSharedPdfProxyMock.mockResolvedValue({ numPages: totalPages })
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })
    loadPecoToolBBoxMetaMock.mockResolvedValue({})
    loadPageMock.mockImplementation((_pdf: unknown, idx: number) => Promise.resolve(makePage(idx)))

    const hook = renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )
    return { ...hook, setCurrentPageSpy }
  }

  it('範囲内のページ番号 (1-based) を 0-based index に変換して setCurrentPage を呼ぶ', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    act(() => { result.current.setPageInputValue('5') })
    act(() => { result.current.handlePageInputCommit() })

    // 入力 "5" (1-based) → index 4
    expect(setCurrentPageSpy).toHaveBeenCalledWith(4)
    // コミット後は pageInputValue がクリアされる
    expect(result.current.pageInputValue).toBeNull()
  })

  it('下限境界: "1" は index 0 を要求し受理される', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    act(() => { result.current.setPageInputValue('1') })
    act(() => { result.current.handlePageInputCommit() })

    expect(setCurrentPageSpy).toHaveBeenCalledWith(0)
  })

  it('上限境界: totalPages ちょうどは受理、totalPages+1 は拒否される', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    // 上限 (10) ちょうど → index 9 で受理
    act(() => { result.current.setPageInputValue('10') })
    act(() => { result.current.handlePageInputCommit() })
    expect(setCurrentPageSpy).toHaveBeenCalledWith(9)

    setCurrentPageSpy.mockClear()

    // 上限超過 (11) → 拒否、setCurrentPage は呼ばれない
    act(() => { result.current.setPageInputValue('11') })
    act(() => { result.current.handlePageInputCommit() })
    expect(setCurrentPageSpy).not.toHaveBeenCalled()
    // 拒否されても入力値はクリアされる
    expect(result.current.pageInputValue).toBeNull()
  })

  it('0 や負値は拒否される (1-based の下限未満)', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    act(() => { result.current.setPageInputValue('0') })
    act(() => { result.current.handlePageInputCommit() })
    expect(setCurrentPageSpy).not.toHaveBeenCalled()

    act(() => { result.current.setPageInputValue('-2') })
    act(() => { result.current.handlePageInputCommit() })
    expect(setCurrentPageSpy).not.toHaveBeenCalled()
  })

  it('非数値の入力は拒否され setCurrentPage を呼ばない', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    act(() => { result.current.setPageInputValue('abc') })
    act(() => { result.current.handlePageInputCommit() })

    expect(setCurrentPageSpy).not.toHaveBeenCalled()
    expect(result.current.pageInputValue).toBeNull()
  })

  it('pageInputValue が null のときは何もしない (no-op コミット)', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    // setPageInputValue を呼ばずにコミット
    act(() => { result.current.handlePageInputCommit() })

    expect(setCurrentPageSpy).not.toHaveBeenCalled()
  })

  it('前置数値を含む不正な入力 ("3xyz") は拒否される', () => {
    const { result, setCurrentPageSpy } = renderNav(10)

    act(() => { result.current.setPageInputValue('3xyz') })
    act(() => { result.current.handlePageInputCommit() })

    expect(setCurrentPageSpy).not.toHaveBeenCalled()
    expect(result.current.pageInputValue).toBeNull()
  })
})

describe('usePageNavigation: ページ番号入力のキー操作 (handlePageInputKeyDown)', () => {
  function renderNav() {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 10,
      metadata: {},
      pages: new Map<number, PageData>([[0, makePage(0, false, 100)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)
    getSharedPdfProxyMock.mockResolvedValue({ numPages: 10 })
    getCachedPageProxyMock.mockResolvedValue({ getViewport: () => ({ width: 100, height: 100 }) })
    loadPecoToolBBoxMetaMock.mockResolvedValue({})
    loadPageMock.mockImplementation((_pdf: unknown, idx: number) => Promise.resolve(makePage(idx)))
    return renderHook(() =>
      usePageNavigation({ currentPageIndex: 0, showToast: vi.fn(), triggerThumbnailLoad: vi.fn() })
    )
  }

  it('Enter キーは input を blur する (コミットは blur ハンドラに委譲)', () => {
    const { result } = renderNav()
    const blur = vi.fn()
    const evt = {
      key: 'Enter',
      currentTarget: { blur },
    } as unknown as React.KeyboardEvent<HTMLInputElement>

    act(() => { result.current.handlePageInputKeyDown(evt) })
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it('Escape キーは pageInputValue を破棄して input を blur する', () => {
    const { result } = renderNav()
    // まず入力値を入れておく
    act(() => { result.current.setPageInputValue('7') })
    expect(result.current.pageInputValue).toBe('7')

    const blur = vi.fn()
    const evt = {
      key: 'Escape',
      currentTarget: { blur },
    } as unknown as React.KeyboardEvent<HTMLInputElement>

    act(() => { result.current.handlePageInputKeyDown(evt) })
    // Escape は入力を捨てる
    expect(result.current.pageInputValue).toBeNull()
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it('Enter / Escape 以外のキーは何もしない (入力値も blur も変化しない)', () => {
    const { result } = renderNav()
    act(() => { result.current.setPageInputValue('9') })

    const blur = vi.fn()
    const evt = {
      key: 'a',
      currentTarget: { blur },
    } as unknown as React.KeyboardEvent<HTMLInputElement>

    act(() => { result.current.handlePageInputKeyDown(evt) })
    expect(result.current.pageInputValue).toBe('9')
    expect(blur).not.toHaveBeenCalled()
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

describe('documentEpoch: 同一 filePath / currentPageIndex の再読込', () => {
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
      currentPageIndex: 0,
    })
    useInfraStore.setState({ documentEpoch: 1 })

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
        1234,
        { displayPageIndex: 0 }
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
      currentPageIndex: 0,
    })
    useInfraStore.setState({ documentEpoch: 2 })

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalledWith(
        fakePdf,
        0,
        filePath,
        metaB,
        1234,
        { displayPageIndex: 0 }
      )
    })
    expect(loadPecoToolBBoxMetaMock).toHaveBeenCalledTimes(2)
  })

  it('古い bboxMeta resolve がファイル切替後の bboxMetaRef を汚染しない', async () => {
    const fakePdfA = { numPages: 1, name: 'A' }
    const fakePdfB = { numPages: 1, name: 'B' }
    let resolveMetaA!: (m: any) => void
    let resolveSharedB!: (p: any) => void
    const metaAPromise = new Promise<any>((res) => { resolveMetaA = res })
    const sharedBPromise = new Promise<any>((res) => { resolveSharedB = res })
    const metaA = { '0': [{ bbox: { x: 1, y: 1, width: 10, height: 10 }, writingMode: 'horizontal', order: 0, text: 'old' }] }
    const metaB = { '0': [{ bbox: { x: 2, y: 2, width: 20, height: 20 }, writingMode: 'horizontal', order: 0, text: 'new' }] }

    getSharedPdfProxyMock.mockImplementation((path: string) =>
      path === 'a.pdf' ? Promise.resolve(fakePdfA) : sharedBPromise
    )
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })
    loadPecoToolBBoxMetaMock
      .mockReturnValueOnce(metaAPromise)
      .mockResolvedValueOnce(metaB)
    loadPageMock.mockImplementation((_pdf, idx) =>
      Promise.resolve(makePage(idx))
    )

    usePecoStore.setState({
      document: {
        filePath: 'a.pdf',
        fileName: 'a.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
        mtime: 100,
      },
      currentPageIndex: 0,
    })
    useInfraStore.setState({ documentEpoch: 1 })

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
      expect(loadPecoToolBBoxMetaMock).toHaveBeenCalledTimes(1)
    })

    act(() => {
      usePecoStore.setState({
        document: {
          filePath: 'b.pdf',
          fileName: 'b.pdf',
          totalPages: 1,
          metadata: {},
          pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
          mtime: 200,
        },
        currentPageIndex: 0,
      })
      useInfraStore.setState({ documentEpoch: 2 })
    })

    resolveMetaA(metaA)
    await Promise.resolve()
    resolveSharedB(fakePdfB)

    await waitFor(() => {
      expect(loadPageMock).toHaveBeenCalledWith(fakePdfB, 0, 'b.pdf', metaB, 200, { displayPageIndex: 0 })
    })
    expect(loadPageMock.mock.calls.some((call) => call[2] === 'a.pdf')).toBe(false)
    expect(loadPageMock.mock.calls.some((call) => call[2] === 'b.pdf' && call[3] === metaA)).toBe(false)
  })
})

describe('page input validation', () => {
  it.each([
    ['0'],
    ['6'],
    [''],
    ['1.5'],
    ['+1'],
    ['-1'],
  ])('境界外または非整数のページ番号入力 "%s" では移動しない', (input) => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 5,
      metadata: {},
      pages: new Map<number, PageData>([[1, makePage(1)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 1 } as any)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    const { result } = renderHook(() =>
      usePageNavigation({
        currentPageIndex: 1,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    act(() => {
      result.current.setPageInputValue(input)
    })
    act(() => {
      result.current.handlePageInputCommit()
    })

    expect(usePecoStore.getState().currentPageIndex).toBe(1)
    expect(result.current.pageInputValue).toBeNull()
  })

  it('数字以外を含むページ番号入力では移動しない', () => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 5,
      metadata: {},
      pages: new Map<number, PageData>([[0, makePage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    const { result } = renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    act(() => {
      result.current.setPageInputValue('3abc')
    })
    act(() => {
      result.current.handlePageInputCommit()
    })

    expect(usePecoStore.getState().currentPageIndex).toBe(0)
    expect(result.current.pageInputValue).toBeNull()
  })

  it('数字のみのページ番号入力では対象ページに移動する', () => {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 5,
      metadata: {},
      pages: new Map<number, PageData>([[0, makePage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })

    const { result } = renderHook(() =>
      usePageNavigation({
        currentPageIndex: 0,
        showToast: vi.fn(),
        triggerThumbnailLoad: vi.fn(),
      })
    )

    act(() => {
      result.current.setPageInputValue('3')
    })
    act(() => {
      result.current.handlePageInputCommit()
    })

    expect(usePecoStore.getState().currentPageIndex).toBe(2)
    expect(result.current.pageInputValue).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// PCT-168 (issue #399): 全ブロック削除 (Ctrl+A → Delete) したページが
// loadPage 再実行 (ページ移動→戻る / 再読込等) で抽出原文に復活しない。
//
// loadCurrentPage 内の merge ガード:
//   hasUserEdits = existing.isDirty && (textBlocks.length > 0 || ocrCleared === true)
// は「空配列 + isDirty」だけのページを編集なしと判定し、loadPage の抽出原文
// (isDirty=false) で上書きする。そのため App.tsx の handleDelete は全削除時に
// ocrCleared: true を立てる (clearOcrCurrentPage と同じフラグ構成)。
// ─────────────────────────────────────────────────────────────

function makeBlock(id: string, text = 'x'): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 10, y: 10, width: 50, height: 12 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
  }
}

describe('PCT-168 (issue #399): 全ブロック削除ページの loadPage 上書き防止 (merge ガード)', () => {
  /**
   * page 0 を width=0 ダミーにして loadCurrentPage を発火させ、
   * loadPage の resolve を手動制御できるようにする共通セットアップ。
   */
  function setupWithControlledLoadPage() {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, makeDummyPage(0)]]),
      mtime: 1234,
    }
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    getSharedPdfProxyMock.mockResolvedValue({ numPages: 1 })
    getCachedPageProxyMock.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
    })
    loadPecoToolBBoxMetaMock.mockResolvedValue({ '0': [] })

    let resolveLoadPage!: (p: PageData) => void
    loadPageMock.mockReturnValue(
      new Promise<PageData>((res) => { resolveLoadPage = res })
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
    return { resolveLoadPage: (p: PageData) => resolveLoadPage(p) }
  }

  /** loadPage が返す「抽出原文」: 非空 textBlocks + isDirty=false。
   *  thumbnail をマーカーにして .then 内の updatePageData 完了を検知する。 */
  function extractedOriginal(): PageData {
    return {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [makeBlock('orig-1'), makeBlock('orig-2')],
      isDirty: false,
      thumbnail: 'extracted-marker',
    }
  }

  it('空 textBlocks + isDirty=true + ocrCleared=true の既存編集は loadPage 抽出原文で上書きされない (温存)', async () => {
    const { resolveLoadPage } = setupWithControlledLoadPage()

    await waitFor(() => expect(loadPageMock).toHaveBeenCalled())

    // ユーザーの全ブロック削除を再現 (修正後の handleDelete が書く形)
    act(() => {
      usePecoStore.getState().updatePageData(0, {
        textBlocks: [],
        isDirty: true,
        isTextExtracted: true,
        ocrCleared: true,
      }, false)
    })

    resolveLoadPage(extractedOriginal())

    // merge 後の updatePageData 完了を thumbnail マーカーで待つ
    // (温存/上書きどちらの分岐でも pageData の thumbnail は書き込まれる)
    await waitFor(() => {
      expect(usePecoStore.getState().document!.pages.get(0)!.thumbnail).toBe('extracted-marker')
    })

    const page = usePecoStore.getState().document!.pages.get(0)!
    expect(page.textBlocks).toHaveLength(0) // 削除が温存される (復活しない)
    expect(page.isDirty).toBe(true)         // dirty も温存 (保存 PDF に削除が反映される)
    expect(page.ocrCleared).toBe(true)      // 次の loadPage サイクルでもガードが効く
  })

  it('ocrCleared を立てない空 dirty ページは抽出原文で上書きされる (ガードの既存契約 = handleDelete が ocrCleared を立てる理由)', async () => {
    const { resolveLoadPage } = setupWithControlledLoadPage()

    await waitFor(() => expect(loadPageMock).toHaveBeenCalled())

    // 修正前の handleDelete が書いていた形 (ocrCleared なし)。
    // width=0 stub や clearOcrAllPages ダミーを実データで置換するための
    // ガード仕様上、この形は「編集なし」と判定される。
    act(() => {
      usePecoStore.getState().updatePageData(0, {
        textBlocks: [],
        isDirty: true,
        isTextExtracted: true,
      }, false)
    })

    resolveLoadPage(extractedOriginal())

    await waitFor(() => {
      expect(usePecoStore.getState().document!.pages.get(0)!.thumbnail).toBe('extracted-marker')
    })

    const page = usePecoStore.getState().document!.pages.get(0)!
    expect(page.textBlocks).toHaveLength(2) // 抽出原文が復活する (PCT-168 のバグ経路そのもの)
    expect(page.isDirty).toBe(false)
  })
})

describe('PCT-168 (issue #399): handleDelete の全削除で ocrCleared が立つ (契約検証)', () => {
  /**
   * 検証対象: App.tsx の handleDelete と同一仕様の関数。
   * App.tsx 内に inline 定義されているため、契約 (全削除時に ocrCleared: true を
   * updatePageData へ渡す) のみをここで担保する。
   * 仕様逸脱した場合、本関数と App.tsx を同時に修正する。
   */
  function handleDeleteSpec() {
    const { document, currentPageIndex, selectedIds, updatePageData } = usePecoStore.getState()
    const currentPage = document?.pages.get(currentPageIndex)
    if (selectedIds.size === 0 || !currentPage) return
    const newBlocks = currentPage.textBlocks.filter(b => !selectedIds.has(b.id))
    updatePageData(
      currentPageIndex,
      newBlocks.length === 0
        ? { textBlocks: newBlocks, isDirty: true, isTextExtracted: true, ocrCleared: true }
        : { textBlocks: newBlocks, isDirty: true }
    )
    usePecoStore.getState().clearSelection()
  }

  function setupPageWithBlocks(blocks: TextBlock[], selected: string[]) {
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, {
        pageIndex: 0,
        width: 100,
        height: 100,
        textBlocks: blocks,
        isDirty: false,
        thumbnail: null,
        isTextExtracted: true,
      }]]),
      mtime: 1234,
    }
    usePecoStore.setState({
      document: doc,
      currentPageIndex: 0,
      selectedIds: new Set(selected),
    } as any)
  }

  it('3手再現: 全ブロック選択 → Delete で textBlocks=[] + isDirty=true + ocrCleared=true が立つ', () => {
    const blocks = [makeBlock('a'), makeBlock('b')]
    setupPageWithBlocks(blocks, ['a', 'b']) // 手1: Ctrl+A 相当 (全選択)

    handleDeleteSpec() // 手2: Delete

    // 手3: この状態でページ移動→戻る (loadPage 再実行) が起きても、
    // 上の merge ガードテストが示す通り ocrCleared=true で温存される。
    const page = usePecoStore.getState().document!.pages.get(0)!
    expect(page.textBlocks).toHaveLength(0)
    expect(page.isDirty).toBe(true)
    expect(page.ocrCleared).toBe(true)
    expect(page.isTextExtracted).toBe(true)
    expect(usePecoStore.getState().selectedIds.size).toBe(0)
  })

  it('部分削除 (ページに残ブロックあり) では ocrCleared を立てない', () => {
    const blocks = [makeBlock('a'), makeBlock('b')]
    setupPageWithBlocks(blocks, ['a'])

    handleDeleteSpec()

    const page = usePecoStore.getState().document!.pages.get(0)!
    expect(page.textBlocks).toHaveLength(1)
    expect(page.textBlocks[0].id).toBe('b')
    expect(page.isDirty).toBe(true)
    // 非空ページは merge ガードが textBlocks.length > 0 で守るため、
    // ocrCleared は導入しない (OCR 再実行時の false リセット経路とも整合)
    expect(page.ocrCleared).toBeUndefined()
  })
})
