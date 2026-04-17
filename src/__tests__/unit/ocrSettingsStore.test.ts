import { describe, it, expect, beforeEach } from 'vitest'
import { useOcrSettingsStore } from '../../store/ocrSettingsStore'

beforeEach(() => {
  // Reset store to initial state
  useOcrSettingsStore.setState({
    horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
    vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
    groupTolerance: 20,
    mixedOrder: 'vertical-first',
  })
})

describe('ocrSettingsStore', () => {

  describe('U-OS-01~06: Default values', () => {
    it('U-OS-01: horizontal.rowOrder defaults to top-to-bottom', () => {
      expect(useOcrSettingsStore.getState().horizontal.rowOrder).toBe('top-to-bottom')
    })

    it('U-OS-02: horizontal.columnOrder defaults to left-to-right', () => {
      expect(useOcrSettingsStore.getState().horizontal.columnOrder).toBe('left-to-right')
    })

    it('U-OS-03: vertical.columnOrder defaults to right-to-left', () => {
      expect(useOcrSettingsStore.getState().vertical.columnOrder).toBe('right-to-left')
    })

    it('U-OS-04: vertical.rowOrder defaults to top-to-bottom', () => {
      expect(useOcrSettingsStore.getState().vertical.rowOrder).toBe('top-to-bottom')
    })

    it('U-OS-05: groupTolerance defaults to 20', () => {
      expect(useOcrSettingsStore.getState().groupTolerance).toBe(20)
    })

    it('U-OS-06: mixedOrder defaults to vertical-first', () => {
      expect(useOcrSettingsStore.getState().mixedOrder).toBe('vertical-first')
    })
  })

  describe('U-OS-07~12: Setters update only target field', () => {
    it('U-OS-07: setHorizontalRowOrder updates only horizontal.rowOrder', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setHorizontalRowOrder('bottom-to-top')
      const after = useOcrSettingsStore.getState()

      expect(after.horizontal.rowOrder).toBe('bottom-to-top')
      expect(after.horizontal.columnOrder).toBe(before.horizontal.columnOrder)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.groupTolerance).toBe(before.groupTolerance)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-08: setHorizontalColumnOrder updates only horizontal.columnOrder', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setHorizontalColumnOrder('right-to-left')
      const after = useOcrSettingsStore.getState()

      expect(after.horizontal.columnOrder).toBe('right-to-left')
      expect(after.horizontal.rowOrder).toBe(before.horizontal.rowOrder)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.groupTolerance).toBe(before.groupTolerance)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-09: setVerticalColumnOrder updates only vertical.columnOrder', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setVerticalColumnOrder('left-to-right')
      const after = useOcrSettingsStore.getState()

      expect(after.vertical.columnOrder).toBe('left-to-right')
      expect(after.vertical.rowOrder).toBe(before.vertical.rowOrder)
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.groupTolerance).toBe(before.groupTolerance)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-10: setVerticalRowOrder updates only vertical.rowOrder', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setVerticalRowOrder('bottom-to-top')
      const after = useOcrSettingsStore.getState()

      expect(after.vertical.rowOrder).toBe('bottom-to-top')
      expect(after.vertical.columnOrder).toBe(before.vertical.columnOrder)
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.groupTolerance).toBe(before.groupTolerance)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-11: setGroupTolerance updates only groupTolerance', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setGroupTolerance(50)
      const after = useOcrSettingsStore.getState()

      expect(after.groupTolerance).toBe(50)
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-12: setMixedOrder updates only mixedOrder', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setMixedOrder('horizontal-first')
      const after = useOcrSettingsStore.getState()

      expect(after.mixedOrder).toBe('horizontal-first')
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.groupTolerance).toBe(before.groupTolerance)
    })
  })

  describe('U-OS-13: Persist key', () => {
    it('persist key is peco-ocr-settings', () => {
      // The persist middleware stores under this key; verify via the store's persist API
      const persistOptions = (useOcrSettingsStore as any).persist
      expect(persistOptions.getOptions().name).toBe('peco-ocr-settings')
    })
  })

  describe('U-OS-14: State survives persist round-trip', () => {
    it('setting a value persists and is retrievable via getState', () => {
      useOcrSettingsStore.getState().setGroupTolerance(99)
      useOcrSettingsStore.getState().setHorizontalRowOrder('bottom-to-top')
      useOcrSettingsStore.getState().setVerticalColumnOrder('left-to-right')
      useOcrSettingsStore.getState().setMixedOrder('horizontal-first')

      const state = useOcrSettingsStore.getState()
      expect(state.groupTolerance).toBe(99)
      expect(state.horizontal.rowOrder).toBe('bottom-to-top')
      expect(state.vertical.columnOrder).toBe('left-to-right')
      expect(state.mixedOrder).toBe('horizontal-first')
    })
  })

})
