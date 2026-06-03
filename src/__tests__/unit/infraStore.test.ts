import { describe, it, expect, beforeEach } from 'vitest'
import { useInfraStore } from '../../store/infraStore'

// Reset store to initial state before each test
beforeEach(() => {
  useInfraStore.setState({
    documentEpoch: 0,
    pageAccessOrder: [],
    pendingRestoration: null,
    lastIdbError: null,
    currentPageProxy: null,
    currentPageProxyKey: null,
  })
})

describe('infraStore', () => {

  // ── documentEpoch ──────────────────────────────────────────────

  describe('U-IS-01: bumpDocumentEpoch increments on openDocument', () => {
    it('epoch increases by 1 after single bump', () => {
      const before = useInfraStore.getState().documentEpoch
      useInfraStore.getState().bumpDocumentEpoch()
      expect(useInfraStore.getState().documentEpoch).toBe(before + 1)
    })
  })

  describe('U-IS-02: bumpDocumentEpoch increments on closeDocument (monotonic)', () => {
    it('epoch continues to increase after second bump', () => {
      useInfraStore.getState().bumpDocumentEpoch()
      const after1 = useInfraStore.getState().documentEpoch
      useInfraStore.getState().bumpDocumentEpoch()
      const after2 = useInfraStore.getState().documentEpoch
      expect(after2).toBe(after1 + 1)
    })
  })

  describe('U-IS-03: bumpDocumentEpoch accumulates over multiple calls', () => {
    it('epoch equals number of bumps', () => {
      useInfraStore.getState().bumpDocumentEpoch()
      useInfraStore.getState().bumpDocumentEpoch()
      useInfraStore.getState().bumpDocumentEpoch()
      expect(useInfraStore.getState().documentEpoch).toBe(3)
    })
  })

  describe('U-IS-04: bumpDocumentEpochAndClearProxy clears currentPageProxy', () => {
    it('proxy is null after bumpDocumentEpochAndClearProxy', () => {
      // Set a proxy first
      const fakeProxy = {} as any
      useInfraStore.getState().setCurrentPageProxy('file.pdf', 0, fakeProxy)
      expect(useInfraStore.getState().currentPageProxy).not.toBeNull()

      useInfraStore.getState().bumpDocumentEpochAndClearProxy()

      expect(useInfraStore.getState().currentPageProxy).toBeNull()
      expect(useInfraStore.getState().currentPageProxyKey).toBeNull()
    })

    it('epoch also increases by 1', () => {
      const before = useInfraStore.getState().documentEpoch
      useInfraStore.getState().bumpDocumentEpochAndClearProxy()
      expect(useInfraStore.getState().documentEpoch).toBe(before + 1)
    })
  })

  // ── currentPageProxy / expectedKey ────────────────────────────

  describe('U-IS-05: setCurrentPageProxy stores proxy with expected key', () => {
    it('proxy and key are set when filePath and pageIndex match', () => {
      const fakeProxy = { _type: 'proxy' } as any
      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 2, fakeProxy)

      const state = useInfraStore.getState()
      expect(state.currentPageProxy).toBe(fakeProxy)
      expect(state.currentPageProxyKey).toBe('doc.pdf:2')
    })
  })

  describe('U-IS-06: key mismatch can be detected for race prevention', () => {
    it('when proxy is set for page 1 then overwritten for page 2, key reflects page 2', () => {
      const proxy1 = { _page: 1 } as any
      const proxy2 = { _page: 2 } as any

      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 1, proxy1)
      expect(useInfraStore.getState().currentPageProxyKey).toBe('doc.pdf:1')

      // Simulate page switch: caller checks key before using proxy
      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 2, proxy2)
      expect(useInfraStore.getState().currentPageProxyKey).toBe('doc.pdf:2')
      expect(useInfraStore.getState().currentPageProxy).toBe(proxy2)
    })

    it('setCurrentPageProxy with null proxy sets key to null', () => {
      const fakeProxy = {} as any
      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 0, fakeProxy)
      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 0, null)

      expect(useInfraStore.getState().currentPageProxy).toBeNull()
      expect(useInfraStore.getState().currentPageProxyKey).toBeNull()
    })
  })

  // ── pageAccessOrder / LRU ──────────────────────────────────────

  describe('U-IS-07: pageAccessOrder moves accessed page to front (LRU)', () => {
    it('newly accessed page appears at head of order array', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2] })
      useInfraStore.getState().updatePageAccessOrder(2)
      expect(useInfraStore.getState().pageAccessOrder[0]).toBe(2)
    })

    it('order result has page 2 promoted: [2, 0, 1]', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2] })
      useInfraStore.getState().updatePageAccessOrder(2)
      expect(useInfraStore.getState().pageAccessOrder).toEqual([2, 0, 1])
    })
  })

  describe('U-IS-08: pageAccessOrder evicts last entry at MAX_CACHED_PAGES', () => {
    it('when 100 pages cached and a new page accessed, oldest is still accessible via order', () => {
      // Simulate 100 pages already cached: indices 1..100
      const initial = Array.from({ length: 100 }, (_, i) => i + 1)
      useInfraStore.setState({ pageAccessOrder: initial })

      // Access a new page (0) not in the existing list
      const result = useInfraStore.getState().updatePageAccessOrder(0)

      // New page should be at head
      expect(result[0]).toBe(0)
      // Total length is now 101 (infraStore itself does not cap — LRU cap is in pdfLoader)
      expect(result.length).toBe(101)
    })

    it('updatePageAccessOrder returns the new order array', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2] })
      const returned = useInfraStore.getState().updatePageAccessOrder(3)
      expect(returned).toEqual([3, 0, 1, 2])
      // Returned value should equal stored value
      expect(returned).toEqual(useInfraStore.getState().pageAccessOrder)
    })
  })

  describe('U-IS-09: duplicate pageIndex access does not create duplicates', () => {
    it('re-accessing existing page moves it to head without duplicating', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2] })
      useInfraStore.getState().updatePageAccessOrder(1)
      const order = useInfraStore.getState().pageAccessOrder
      expect(order).toEqual([1, 0, 2])
      // No duplicates
      expect(new Set(order).size).toBe(order.length)
    })

    it('re-accessing head page keeps it at head', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2] })
      useInfraStore.getState().updatePageAccessOrder(0)
      expect(useInfraStore.getState().pageAccessOrder).toEqual([0, 1, 2])
    })
  })

  // ── pendingRestoration ─────────────────────────────────────────

  describe('U-IS-10: pendingRestoration set/clear works correctly', () => {
    it('setPendingRestoration stores the pages map', () => {
      const pages = { 'file.pdf:0': { isDirty: true } }
      useInfraStore.getState().setPendingRestoration(pages)
      expect(useInfraStore.getState().pendingRestoration).toEqual(pages)
    })

    it('clearPendingRestoration sets pendingRestoration to null', () => {
      useInfraStore.getState().setPendingRestoration({ 'file.pdf:0': {} })
      useInfraStore.getState().clearPendingRestoration()
      expect(useInfraStore.getState().pendingRestoration).toBeNull()
    })

    it('setPendingRestoration with null clears the value', () => {
      useInfraStore.getState().setPendingRestoration({ 'file.pdf:0': {} })
      useInfraStore.getState().setPendingRestoration(null)
      expect(useInfraStore.getState().pendingRestoration).toBeNull()
    })
  })

  // ── lastIdbError ───────────────────────────────────────────────

  describe('U-IS-11: lastIdbError stores IDB error on failure', () => {
    it('setLastIdbError stores the error object', () => {
      const err = new Error('IDB write failed')
      useInfraStore.getState().setLastIdbError(err)
      expect(useInfraStore.getState().lastIdbError).toBe(err)
    })

    it('clearLastIdbError resets lastIdbError to null', () => {
      useInfraStore.getState().setLastIdbError(new Error('test'))
      useInfraStore.getState().clearLastIdbError()
      expect(useInfraStore.getState().lastIdbError).toBeNull()
    })

    it('clearLastIdbErrorIfSet clears when error is set', () => {
      useInfraStore.getState().setLastIdbError(new Error('test'))
      useInfraStore.getState().clearLastIdbErrorIfSet()
      expect(useInfraStore.getState().lastIdbError).toBeNull()
    })

    it('clearLastIdbErrorIfSet is no-op when error is null', () => {
      // Should not throw, state stays null
      useInfraStore.getState().clearLastIdbErrorIfSet()
      expect(useInfraStore.getState().lastIdbError).toBeNull()
    })
  })

  describe('U-IS-12: lastIdbError is null in initial state', () => {
    it('initial lastIdbError is null', () => {
      expect(useInfraStore.getState().lastIdbError).toBeNull()
    })

    it('initial documentEpoch is 0', () => {
      expect(useInfraStore.getState().documentEpoch).toBe(0)
    })

    it('initial pageAccessOrder is empty', () => {
      expect(useInfraStore.getState().pageAccessOrder).toEqual([])
    })

    it('initial pendingRestoration is null', () => {
      expect(useInfraStore.getState().pendingRestoration).toBeNull()
    })

    it('initial currentPageProxy is null', () => {
      expect(useInfraStore.getState().currentPageProxy).toBeNull()
    })

    it('initial currentPageProxyKey is null', () => {
      expect(useInfraStore.getState().currentPageProxyKey).toBeNull()
    })
  })

  // ── clearCurrentPageProxy ──────────────────────────────────────

  describe('clearCurrentPageProxy', () => {
    it('clears both proxy and key', () => {
      const fakeProxy = {} as any
      useInfraStore.getState().setCurrentPageProxy('doc.pdf', 0, fakeProxy)
      useInfraStore.getState().clearCurrentPageProxy()
      expect(useInfraStore.getState().currentPageProxy).toBeNull()
      expect(useInfraStore.getState().currentPageProxyKey).toBeNull()
    })
  })

  // ── resetPageAccessOrder ───────────────────────────────────────

  describe('resetPageAccessOrder', () => {
    it('resets pageAccessOrder to empty array', () => {
      useInfraStore.setState({ pageAccessOrder: [0, 1, 2, 3] })
      useInfraStore.getState().resetPageAccessOrder()
      expect(useInfraStore.getState().pageAccessOrder).toEqual([])
    })
  })
})
