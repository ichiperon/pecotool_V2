import { describe, it, expect, beforeEach } from 'vitest'
import { useOcrSettingsStore } from '../../store/ocrSettingsStore'

beforeEach(() => {
  // Reset store to initial state
  useOcrSettingsStore.setState({
    horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
    vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
    groupTolerance: 20,
    mixedOrder: 'vertical-first',
    ocrConfidenceThreshold: 0.7,
    showLowConfidenceHighlight: true,
    pdfTextOffsetRightMm: 0,
    pdfTextOffsetDownMm: 0,
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

    it('pdfTextOffsetRightMm defaults to 0 (補正なし＝BB枠と一致)', () => {
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(0)
    })

    it('pdfTextOffsetDownMm defaults to 0 (補正なし)', () => {
      expect(useOcrSettingsStore.getState().pdfTextOffsetDownMm).toBe(0)
    })
  })

  describe('PDF テキスト層オフセット setters', () => {
    it('setPdfTextOffsetRightMm updates only pdfTextOffsetRightMm (負値も許容)', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(-1.5)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(-1.5)
      expect(useOcrSettingsStore.getState().pdfTextOffsetDownMm).toBe(0)
    })

    it('setPdfTextOffsetDownMm updates only pdfTextOffsetDownMm', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetDownMm(3)
      expect(useOcrSettingsStore.getState().pdfTextOffsetDownMm).toBe(3)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(0)
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

  describe('U-OS-23~25: persist migrate (PCT-117 — 旧既定 4/2 → 0/0)', () => {
    // persist の migrate 関数を取り出す。version 未設定(=0)からの移行で
    // 位置補正のみ 0/0 にリセットし、他の永続値は保持することを検証する。
    const getMigrate = () =>
      (useOcrSettingsStore as any).persist.getOptions().migrate as (
        state: unknown,
        version: number,
      ) => Record<string, unknown>

    it('U-OS-23: version 0 (旧既定 4/2) からの移行で位置補正が 0/0 にリセットされる', () => {
      const migrate = getMigrate()
      const legacy = {
        horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
        vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
        groupTolerance: 30,
        mixedOrder: 'vertical-first',
        ocrLanguage: 'en-US',
        ocrConfidenceThreshold: 0.5,
        showLowConfidenceHighlight: false,
        pdfTextOffsetRightMm: 4,
        pdfTextOffsetDownMm: 2,
      }
      const migrated = migrate(legacy, 0)

      expect(migrated.pdfTextOffsetRightMm).toBe(0)
      expect(migrated.pdfTextOffsetDownMm).toBe(0)
    })

    it('U-OS-24: 移行時に位置補正以外の永続値は保持される', () => {
      const migrate = getMigrate()
      const legacy = {
        horizontal: { rowOrder: 'bottom-to-top', columnOrder: 'right-to-left' },
        vertical: { columnOrder: 'left-to-right', rowOrder: 'bottom-to-top' },
        groupTolerance: 30,
        mixedOrder: 'horizontal-first',
        ocrLanguage: 'en-US',
        ocrConfidenceThreshold: 0.5,
        showLowConfidenceHighlight: false,
        pdfTextOffsetRightMm: 4,
        pdfTextOffsetDownMm: 2,
      }
      const migrated = migrate(legacy, 0) as typeof legacy

      expect(migrated.groupTolerance).toBe(30)
      expect(migrated.mixedOrder).toBe('horizontal-first')
      expect(migrated.ocrLanguage).toBe('en-US')
      expect(migrated.ocrConfidenceThreshold).toBe(0.5)
      expect(migrated.showLowConfidenceHighlight).toBe(false)
      expect(migrated.horizontal).toEqual(legacy.horizontal)
      expect(migrated.vertical).toEqual(legacy.vertical)
    })

    it('U-OS-25: version 1 以降は位置補正をリセットしない（ユーザー設定を尊重）', () => {
      const migrate = getMigrate()
      const current = {
        groupTolerance: 20,
        pdfTextOffsetRightMm: 3,
        pdfTextOffsetDownMm: 1.5,
      }
      const migrated = migrate(current, 1) as typeof current

      expect(migrated.pdfTextOffsetRightMm).toBe(3)
      expect(migrated.pdfTextOffsetDownMm).toBe(1.5)
    })
  })

  describe('U-OS-26~29: PCT-110 位置補正 offset の clamp（±20mm）', () => {
    it('U-OS-26: 上限 20mm を超える値は 20 に clamp される', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(9999)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(20)
      useOcrSettingsStore.getState().setPdfTextOffsetDownMm(100)
      expect(useOcrSettingsStore.getState().pdfTextOffsetDownMm).toBe(20)
    })

    it('U-OS-27: 下限 -20mm 未満の値は -20 に clamp される', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(-50)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(-20)
    })

    it('U-OS-28: 範囲内の正常値はそのまま反映される', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(4)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(4)
      useOcrSettingsStore.getState().setPdfTextOffsetDownMm(-3.5)
      expect(useOcrSettingsStore.getState().pdfTextOffsetDownMm).toBe(-3.5)
    })

    it('U-OS-29: 非有限値（NaN）は現値を維持する', () => {
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(7)
      useOcrSettingsStore.getState().setPdfTextOffsetRightMm(Number.NaN)
      expect(useOcrSettingsStore.getState().pdfTextOffsetRightMm).toBe(7)
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

  describe('U-OS-19~22: confidence threshold and highlight toggle (#192)', () => {
    it('U-OS-19: ocrConfidenceThreshold defaults to 0.7', () => {
      expect(useOcrSettingsStore.getState().ocrConfidenceThreshold).toBe(0.7)
    })

    it('U-OS-20: showLowConfidenceHighlight defaults to true', () => {
      expect(useOcrSettingsStore.getState().showLowConfidenceHighlight).toBe(true)
    })

    it('U-OS-21: setOcrConfidenceThreshold updates ocrConfidenceThreshold only', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setOcrConfidenceThreshold(0.5)
      const after = useOcrSettingsStore.getState()

      expect(after.ocrConfidenceThreshold).toBe(0.5)
      expect(after.showLowConfidenceHighlight).toBe(before.showLowConfidenceHighlight)
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.groupTolerance).toBe(before.groupTolerance)
    })

    it('U-OS-22: setShowLowConfidenceHighlight toggles to false', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setShowLowConfidenceHighlight(false)
      const after = useOcrSettingsStore.getState()

      expect(after.showLowConfidenceHighlight).toBe(false)
      expect(after.ocrConfidenceThreshold).toBe(before.ocrConfidenceThreshold)
      expect(after.horizontal).toEqual(before.horizontal)
    })
  })

  describe('U-OS-15~18: OCR language state', () => {
    it('U-OS-15: ocrLanguage defaults to "ja"', () => {
      expect(useOcrSettingsStore.getState().ocrLanguage).toBe('ja')
    })

    it('U-OS-16: availableLanguages defaults to empty array', () => {
      expect(useOcrSettingsStore.getState().availableLanguages).toEqual([])
    })

    it('U-OS-17: setOcrLanguage updates ocrLanguage only', () => {
      const before = useOcrSettingsStore.getState()
      useOcrSettingsStore.getState().setOcrLanguage('en-US')
      const after = useOcrSettingsStore.getState()

      expect(after.ocrLanguage).toBe('en-US')
      expect(after.horizontal).toEqual(before.horizontal)
      expect(after.vertical).toEqual(before.vertical)
      expect(after.groupTolerance).toBe(before.groupTolerance)
      expect(after.mixedOrder).toBe(before.mixedOrder)
    })

    it('U-OS-18: setAvailableLanguages stores list with correct shape', () => {
      const langs = [
        { tag: 'ja', display_name: 'Japanese' },
        { tag: 'en-US', display_name: 'English (United States)' },
        { tag: 'zh-Hans-CN', display_name: 'Chinese Simplified (China)' },
      ]
      useOcrSettingsStore.getState().setAvailableLanguages(langs)
      const state = useOcrSettingsStore.getState()

      expect(state.availableLanguages).toHaveLength(3)
      expect(state.availableLanguages[0].tag).toBe('ja')
      expect(state.availableLanguages[0].display_name).toBe('Japanese')
      expect(state.availableLanguages[2].tag).toBe('zh-Hans-CN')
    })
  })

})
