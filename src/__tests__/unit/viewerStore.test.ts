import { describe, it, expect, beforeEach } from 'vitest'
import { useViewerStore } from '../../store/viewerStore'
import type { BoundingBox } from '../../types'

// Reset store to initial state before each test
beforeEach(() => {
  useViewerStore.setState({
    zoom: 100,
    showOcr: true,
    ocrOpacity: 0.4,
    showTextPreview: false,
    isDrawingMode: false,
    isSplitMode: false,
    isCurveMode: false,
    isRangeOcrMode: false,
    dragPreviewBboxes: null,
  })
})

describe('viewerStore', () => {

  // ── drawing mode ───────────────────────────────────────────────

  describe('U-VS-01: toggleDrawingMode sets isDrawingMode to true', () => {
    it('isDrawingMode becomes true after first toggle from false', () => {
      useViewerStore.getState().toggleDrawingMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(true)
    })
  })

  describe('U-VS-02: toggleDrawingMode disables isSplitMode (exclusive)', () => {
    it('isSplitMode is false after enabling drawing mode', () => {
      useViewerStore.setState({ isSplitMode: true })
      useViewerStore.getState().toggleDrawingMode()
      expect(useViewerStore.getState().isSplitMode).toBe(false)
    })
  })

  describe('U-VS-03: toggleDrawingMode disables isCurveMode (exclusive)', () => {
    it('isCurveMode is false after enabling drawing mode', () => {
      useViewerStore.setState({ isCurveMode: true })
      useViewerStore.getState().toggleDrawingMode()
      expect(useViewerStore.getState().isCurveMode).toBe(false)
    })
  })

  describe('U-VS-04: toggleSplitMode disables isDrawingMode (exclusive)', () => {
    it('isDrawingMode is false after enabling split mode', () => {
      useViewerStore.setState({ isDrawingMode: true })
      useViewerStore.getState().toggleSplitMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(false)
    })

    it('isSplitMode becomes true after toggle from false', () => {
      useViewerStore.getState().toggleSplitMode()
      expect(useViewerStore.getState().isSplitMode).toBe(true)
    })
  })

  describe('U-VS-05: toggleCurveMode disables isDrawingMode and isSplitMode (exclusive)', () => {
    it('isDrawingMode is false after enabling curve mode', () => {
      useViewerStore.setState({ isDrawingMode: true })
      useViewerStore.getState().toggleCurveMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(false)
    })

    it('isSplitMode is false after enabling curve mode', () => {
      useViewerStore.setState({ isSplitMode: true })
      useViewerStore.getState().toggleCurveMode()
      expect(useViewerStore.getState().isSplitMode).toBe(false)
    })

    it('isCurveMode becomes true after toggle from false', () => {
      useViewerStore.getState().toggleCurveMode()
      expect(useViewerStore.getState().isCurveMode).toBe(true)
    })
  })

  describe('U-VS-06: toggleRangeOcrMode disables all other modes (exclusive)', () => {
    it('isDrawingMode is false after enabling rangeOcr mode', () => {
      useViewerStore.setState({ isDrawingMode: true })
      useViewerStore.getState().toggleRangeOcrMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(false)
    })

    it('isSplitMode is false after enabling rangeOcr mode', () => {
      useViewerStore.setState({ isSplitMode: true })
      useViewerStore.getState().toggleRangeOcrMode()
      expect(useViewerStore.getState().isSplitMode).toBe(false)
    })

    it('isCurveMode is false after enabling rangeOcr mode', () => {
      useViewerStore.setState({ isCurveMode: true })
      useViewerStore.getState().toggleRangeOcrMode()
      expect(useViewerStore.getState().isCurveMode).toBe(false)
    })

    it('isRangeOcrMode becomes true after toggle from false', () => {
      useViewerStore.getState().toggleRangeOcrMode()
      expect(useViewerStore.getState().isRangeOcrMode).toBe(true)
    })
  })

  describe('U-VS-07: toggleDrawingMode is idempotent when called twice', () => {
    it('second toggle turns isDrawingMode back to false (toggle behavior)', () => {
      useViewerStore.getState().toggleDrawingMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(true)
      useViewerStore.getState().toggleDrawingMode()
      expect(useViewerStore.getState().isDrawingMode).toBe(false)
    })

    it('calling toggleDrawingMode when already true: other modes remain false', () => {
      useViewerStore.getState().toggleDrawingMode() // now true
      useViewerStore.getState().toggleDrawingMode() // back to false
      const state = useViewerStore.getState()
      expect(state.isSplitMode).toBe(false)
      expect(state.isCurveMode).toBe(false)
      expect(state.isRangeOcrMode).toBe(false)
    })
  })

  // ── resetViewerState ───────────────────────────────────────────

  describe('U-VS-08: resetViewerState resets all mode flags to false', () => {
    it('all mode flags are false after resetViewerState', () => {
      useViewerStore.setState({
        isDrawingMode: true,
        isSplitMode: true,
        isCurveMode: true,
        isRangeOcrMode: true,
      })
      useViewerStore.getState().resetViewerState()
      const state = useViewerStore.getState()
      expect(state.isDrawingMode).toBe(false)
      expect(state.isSplitMode).toBe(false)
      expect(state.isCurveMode).toBe(false)
      expect(state.isRangeOcrMode).toBe(false)
    })

    it('dragPreviewBboxes is null after resetViewerState', () => {
      const bbox: BoundingBox = { x: 0, y: 0, width: 10, height: 10 }
      useViewerStore.setState({ dragPreviewBboxes: new Map([['id1', bbox]]) })
      useViewerStore.getState().resetViewerState()
      expect(useViewerStore.getState().dragPreviewBboxes).toBeNull()
    })

    it('showOcr is reset to true after resetViewerState', () => {
      useViewerStore.setState({ showOcr: false })
      useViewerStore.getState().resetViewerState()
      expect(useViewerStore.getState().showOcr).toBe(true)
    })

    it('showTextPreview is reset to false after resetViewerState', () => {
      useViewerStore.setState({ showTextPreview: true })
      useViewerStore.getState().resetViewerState()
      expect(useViewerStore.getState().showTextPreview).toBe(false)
    })
  })

  describe('U-VS-09: resetViewerState does not change zoom', () => {
    it('zoom value is preserved after resetViewerState', () => {
      useViewerStore.setState({ zoom: 200 })
      useViewerStore.getState().resetViewerState()
      expect(useViewerStore.getState().zoom).toBe(200)
    })

    it('zoom at 150 remains 150 after resetViewerState', () => {
      useViewerStore.setState({ zoom: 150 })
      useViewerStore.getState().resetViewerState()
      expect(useViewerStore.getState().zoom).toBe(150)
    })
  })

  // ── zoom clamp ─────────────────────────────────────────────────

  describe('U-VS-10: zoom clamps at minimum (25)', () => {
    it('zoom=0.1 is clamped to 25', () => {
      useViewerStore.getState().setZoom(0.1)
      expect(useViewerStore.getState().zoom).toBe(25)
    })

    it('zoom=0 is clamped to 25', () => {
      useViewerStore.getState().setZoom(0)
      expect(useViewerStore.getState().zoom).toBe(25)
    })

    it('zoom=-100 is clamped to 25', () => {
      useViewerStore.getState().setZoom(-100)
      expect(useViewerStore.getState().zoom).toBe(25)
    })

    it('zoom=25 is accepted as-is (boundary)', () => {
      useViewerStore.getState().setZoom(25)
      expect(useViewerStore.getState().zoom).toBe(25)
    })

    it('zoom=26 is accepted without clamping', () => {
      useViewerStore.getState().setZoom(26)
      expect(useViewerStore.getState().zoom).toBe(26)
    })
  })

  describe('U-VS-11: zoom clamps at maximum (500)', () => {
    it('zoom=5.0 is a valid percentage value (5%) clamped to 25', () => {
      // Note: zoom is stored as percentage integer (25-500), not as decimal
      useViewerStore.getState().setZoom(5)
      expect(useViewerStore.getState().zoom).toBe(25)
    })

    it('zoom=500 is accepted as-is (boundary)', () => {
      useViewerStore.getState().setZoom(500)
      expect(useViewerStore.getState().zoom).toBe(500)
    })

    it('zoom=501 is clamped to 500', () => {
      useViewerStore.getState().setZoom(501)
      expect(useViewerStore.getState().zoom).toBe(500)
    })

    it('zoom=1000 is clamped to 500', () => {
      useViewerStore.getState().setZoom(1000)
      expect(useViewerStore.getState().zoom).toBe(500)
    })

    it('zoom=499 is accepted without clamping', () => {
      useViewerStore.getState().setZoom(499)
      expect(useViewerStore.getState().zoom).toBe(499)
    })
  })

  // ── dragPreviewBboxes ──────────────────────────────────────────

  describe('setDragPreviewBboxes', () => {
    it('sets dragPreviewBboxes when bboxes is provided', () => {
      const bbox: BoundingBox = { x: 10, y: 20, width: 100, height: 50 }
      const map = new Map([['id1', bbox]])
      useViewerStore.getState().setDragPreviewBboxes(map)
      expect(useViewerStore.getState().dragPreviewBboxes).toBe(map)
    })

    it('clears dragPreviewBboxes when null is passed', () => {
      const bbox: BoundingBox = { x: 0, y: 0, width: 10, height: 10 }
      useViewerStore.setState({ dragPreviewBboxes: new Map([['id1', bbox]]) })
      useViewerStore.getState().setDragPreviewBboxes(null)
      expect(useViewerStore.getState().dragPreviewBboxes).toBeNull()
    })

    it('skips set when identical map content (optimization #174)', () => {
      const bbox: BoundingBox = { x: 10, y: 20, width: 100, height: 50 }
      const map1 = new Map([['id1', bbox]])
      useViewerStore.getState().setDragPreviewBboxes(map1)
      const refBefore = useViewerStore.getState().dragPreviewBboxes

      // Create new map with identical values
      const map2 = new Map([['id1', { x: 10, y: 20, width: 100, height: 50 }]])
      useViewerStore.getState().setDragPreviewBboxes(map2)

      // Store should still hold the original map (no update triggered)
      expect(useViewerStore.getState().dragPreviewBboxes).toBe(refBefore)
    })

    it('updates when bbox values differ', () => {
      const bbox1: BoundingBox = { x: 10, y: 20, width: 100, height: 50 }
      const map1 = new Map([['id1', bbox1]])
      useViewerStore.getState().setDragPreviewBboxes(map1)

      const bbox2: BoundingBox = { x: 15, y: 20, width: 100, height: 50 }
      const map2 = new Map([['id1', bbox2]])
      useViewerStore.getState().setDragPreviewBboxes(map2)

      expect(useViewerStore.getState().dragPreviewBboxes).toBe(map2)
    })
  })

  // ── mode state machine: all exclusive ─────────────────────────

  describe('mode state machine: 4-mode exclusivity', () => {
    it('enabling drawing then split: only split is active', () => {
      useViewerStore.getState().toggleDrawingMode() // drawing=true
      useViewerStore.getState().toggleSplitMode()   // split=true, drawing=false
      const state = useViewerStore.getState()
      expect(state.isDrawingMode).toBe(false)
      expect(state.isSplitMode).toBe(true)
      expect(state.isCurveMode).toBe(false)
      expect(state.isRangeOcrMode).toBe(false)
    })

    it('enabling curve then rangeOcr: only rangeOcr is active', () => {
      useViewerStore.getState().toggleCurveMode()     // curve=true
      useViewerStore.getState().toggleRangeOcrMode()  // rangeOcr=true, curve=false
      const state = useViewerStore.getState()
      expect(state.isDrawingMode).toBe(false)
      expect(state.isSplitMode).toBe(false)
      expect(state.isCurveMode).toBe(false)
      expect(state.isRangeOcrMode).toBe(true)
    })

    it('at most one mode can be active at any time', () => {
      useViewerStore.getState().toggleDrawingMode()
      let state = useViewerStore.getState()
      const activeModes1 = [state.isDrawingMode, state.isSplitMode, state.isCurveMode, state.isRangeOcrMode]
      expect(activeModes1.filter(Boolean).length).toBeLessThanOrEqual(1)

      useViewerStore.getState().toggleSplitMode()
      state = useViewerStore.getState()
      const activeModes2 = [state.isDrawingMode, state.isSplitMode, state.isCurveMode, state.isRangeOcrMode]
      expect(activeModes2.filter(Boolean).length).toBeLessThanOrEqual(1)
    })
  })

  // ── initial state ──────────────────────────────────────────────

  describe('initial state', () => {
    it('zoom defaults to 100', () => {
      expect(useViewerStore.getState().zoom).toBe(100)
    })

    it('showOcr defaults to true', () => {
      expect(useViewerStore.getState().showOcr).toBe(true)
    })

    it('all mode flags default to false', () => {
      const state = useViewerStore.getState()
      expect(state.isDrawingMode).toBe(false)
      expect(state.isSplitMode).toBe(false)
      expect(state.isCurveMode).toBe(false)
      expect(state.isRangeOcrMode).toBe(false)
    })

    it('dragPreviewBboxes defaults to null', () => {
      expect(useViewerStore.getState().dragPreviewBboxes).toBeNull()
    })
  })
})
