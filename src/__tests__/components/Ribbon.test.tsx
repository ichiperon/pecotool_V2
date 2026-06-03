import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { Ribbon } from '../../components/Ribbon/Ribbon'
import type { PageData } from '../../types'
import { useOcrSettingsStore } from '../../store/ocrSettingsStore'

// jsdom does not implement ResizeObserver; provide a no-op stub
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

vi.mock('lucide-react', () => {
  const s = (name: string) => (props: any) => <span data-icon={name} {...props} />
  return {
    RotateCcw: s('RotateCcw'),
    RotateCw: s('RotateCw'),
    ZoomIn: s('ZoomIn'),
    ZoomOut: s('ZoomOut'),
    Maximize: s('Maximize'),
    Plus: s('Plus'),
    Group: s('Group'),
    Trash2: s('Trash2'),
    Eye: s('Eye'),
    Scissors: s('Scissors'),
    ClipboardList: s('ClipboardList'),
    Eraser: s('Eraser'),
    ChevronDown: s('ChevronDown'),
    ChevronRight: s('ChevronRight'),
    Settings: s('Settings'),
    RemoveFormatting: s('RemoveFormatting'),
    ScanText: s('ScanText'),
    X: s('X'),
    Loader2: s('Loader2'),
    FileX: s('FileX'),
    SquareCheckBig: s('SquareCheckBig'),
    Replace: s('Replace'),
    Spline: s('Spline'),
    Crop: s('Crop'),
    AlertCircle: s('AlertCircle'),
  }
})

// ── ヘルパー ──────────────────────────────────────────────────

const dummyPage: PageData = {
  pageIndex: 0,
  width: 595,
  height: 842,
  textBlocks: [],
  isDirty: false,
  thumbnail: null,
}

function defaultProps(overrides: Partial<React.ComponentProps<typeof Ribbon>> = {}) {
  return {
    isFileLoaded: true,
    currentPage: dummyPage,
    isDirty: false,
    currentPageIsDirty: false,
    undoStackLength: 0,
    redoStackLength: 0,
    zoom: 100,
    isAutoFit: false,
    isDrawingMode: false,
    isSplitMode: false,
    isCurveMode: false,
    isRangeOcrMode: false,
    selectedIdsCount: 0,
    showOcr: false,
    ocrOpacity: 0.5,
    reorderThreshold: 50,
    isPreviewOpen: false,
    showSettingsDropdown: false,
    isOcrRunning: false,
    ocrProgress: null,
    recentFiles: [],
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFit: vi.fn(),
    onToggleDrawing: vi.fn(),
    onToggleSplit: vi.fn(),
    onToggleCurve: vi.fn(),
    onToggleRangeOcr: vi.fn(),
    onGroup: vi.fn(),
    onDeduplicate: vi.fn(),
    onSelectAllText: vi.fn(),
    onRemoveSpaces: vi.fn(),
    onDelete: vi.fn(),
    onToggleOcr: vi.fn(),
    onSetOcrOpacity: vi.fn(),
    onSetReorderThreshold: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleSettingsDropdown: vi.fn(),
    onRunOcrCurrentPage: vi.fn(),
    onRunOcrAllPages: vi.fn(),
    onRunOcrRange: vi.fn(),
    onRunOcrFolder: vi.fn(),
    onOpenBatchJob: vi.fn(),
    onCancelOcr: vi.fn(),
    onClearOcrCurrentPage: vi.fn(),
    onClearOcrAllPages: vi.fn(),
    onOpenReplace: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onReload: vi.fn(),
    onExport: vi.fn(),
    onShowShortcuts: vi.fn(),
    onShowUsage: vi.fn(),
    onShowVersion: vi.fn(),
    onShowTour: vi.fn(),
    onShowOcrSettings: vi.fn(),
    onOpenLogFolder: vi.fn(),
    onCheckUpdate: vi.fn(),
    ...overrides,
  }
}

function renderRibbon(overrides: Partial<React.ComponentProps<typeof Ribbon>> = {}) {
  return render(<Ribbon {...defaultProps(overrides)} />)
}

// ── テスト ───────────────────────────────────────────────────

describe('Ribbon', () => {
  afterEach(cleanup)

  // ── タブ構造 ───────────────────────────────────────────────
  it('C-RB-01: 6タブが全てレンダリングされる', () => {
    renderRibbon()
    expect(screen.getByText('ファイル')).toBeTruthy()
    expect(screen.getByText('編集')).toBeTruthy()
    expect(screen.getByText('OCR')).toBeTruthy()
    expect(screen.getByText('表示')).toBeTruthy()
    expect(screen.getByText('設定')).toBeTruthy()
    expect(screen.getByText('ヘルプ')).toBeTruthy()
  })

  it('C-RB-02: デフォルトでファイルタブがアクティブ', () => {
    renderRibbon()
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-03: 編集タブクリックでパネルが切り替わる', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('編集'))
    const editTab = screen.getByText('編集').closest('button')!
    expect(editTab.classList.contains('ribbon-tab--active')).toBe(true)
    // ファイルタブ内のボタンが消えている (「開く」はファイルタブのみ)
    expect(screen.queryByTitle('開く (Ctrl+O)')).toBeNull()
  })

  it('C-RB-04: OCRタブクリックでOCRパネルが表示される', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('OCR'))
    expect(screen.getByTitle('OCR実行')).toBeTruthy()
  })

  it('C-RB-05: 表示タブクリックでズームボタンが表示される', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('表示'))
    expect(screen.getByTitle('拡大')).toBeTruthy()
    expect(screen.getByTitle('縮小')).toBeTruthy()
  })

  it('C-RB-06: 設定タブクリックでログフォルダボタンが表示される', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('設定'))
    expect(screen.getByTitle('ログフォルダを開く')).toBeTruthy()
  })

  it('C-RB-07: ヘルプタブクリックでチュートリアルボタンが表示される', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('ヘルプ'))
    expect(screen.getByTitle('チュートリアルを表示')).toBeTruthy()
  })

  // ── data-tour 属性移植確認 ──────────────────────────────────
  it('C-RB-08: data-tour="menubar-file" がファイルタブに付いている', () => {
    renderRibbon()
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.getAttribute('data-tour')).toBe('menubar-file')
  })

  it('C-RB-09: data-tour="menubar-help" がヘルプタブに付いている', () => {
    renderRibbon()
    const helpTab = screen.getByText('ヘルプ').closest('button')!
    expect(helpTab.getAttribute('data-tour')).toBe('menubar-help')
  })

  it('C-RB-10: data-tour="toolbar-ocr" がOCRタブのOCR実行ボタンに付いている', () => {
    renderRibbon()
    fireEvent.click(screen.getByText('OCR'))
    const ocrBtn = screen.getByTitle('OCR実行')
    expect(ocrBtn.getAttribute('data-tour')).toBe('toolbar-ocr')
  })

  // ── ファイルタブ機能 ─────────────────────────────────────────
  it('C-RB-11: 開くボタンクリックで onOpen が呼ばれる', () => {
    const onOpen = vi.fn()
    renderRibbon({ onOpen })
    fireEvent.click(screen.getByTitle('開く (Ctrl+O)'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('C-RB-12: isDirty=false/isFileLoaded=true のとき保存ボタンは disabled', () => {
    renderRibbon({ isDirty: false, currentPageIsDirty: false })
    const saveBtn = screen.getByTitle('保存 (Ctrl+S)') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('C-RB-13: isDirty=true のとき保存ボタンは enabled', () => {
    renderRibbon({ isDirty: true })
    const saveBtn = screen.getByTitle('保存 (Ctrl+S)') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
  })

  // ── 編集タブ機能 ─────────────────────────────────────────────
  it('C-RB-14: 編集タブ: undoStackLength=0 で Undo disabled', () => {
    renderRibbon({ undoStackLength: 0 })
    fireEvent.click(screen.getByText('編集'))
    expect((screen.getByTitle('元に戻す (Ctrl+Z)') as HTMLButtonElement).disabled).toBe(true)
  })

  it('C-RB-15: 編集タブ: undoStackLength=3 で Undo enabled', () => {
    renderRibbon({ undoStackLength: 3 })
    fireEvent.click(screen.getByText('編集'))
    expect((screen.getByTitle('元に戻す (Ctrl+Z)') as HTMLButtonElement).disabled).toBe(false)
  })

  it('C-RB-16: 編集タブ: selectedIdsCount<2 でグループ化 disabled', () => {
    renderRibbon({ selectedIdsCount: 1 })
    fireEvent.click(screen.getByText('編集'))
    expect((screen.getByTitle('グループ化') as HTMLButtonElement).disabled).toBe(true)
  })

  it('C-RB-17: 編集タブ: 湾曲ボタンは isCurveMode=true で active + aria-pressed=true', () => {
    renderRibbon({ isCurveMode: true })
    fireEvent.click(screen.getByText('編集'))
    const btn = screen.getByTitle('湾曲モード') as HTMLButtonElement
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.classList.contains('active')).toBe(true)
  })

  // ── OCRタブ機能 ──────────────────────────────────────────────
  it('C-RB-18: OCRタブ: isOcrRunning=true で OCR実行ボタン disabled', () => {
    renderRibbon({ isOcrRunning: true, ocrProgress: { current: 1, total: 5 } })
    fireEvent.click(screen.getByText('OCR'))
    expect((screen.getByTitle('OCR実行') as HTMLButtonElement).disabled).toBe(true)
  })

  it('C-RB-19: OCRタブ: isOcrRunning + ocrProgress でキャンセルボタンが表示される', () => {
    renderRibbon({ isOcrRunning: true, ocrProgress: { current: 2, total: 10 } })
    fireEvent.click(screen.getByText('OCR'))
    expect(screen.getByTitle('キャンセル')).toBeTruthy()
  })

  // ── アクセシビリティ ─────────────────────────────────────────
  it('C-RB-20: タブに role=tab と aria-selected が付いている', () => {
    renderRibbon()
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.getAttribute('role')).toBe('tab')
    expect(fileTab.getAttribute('aria-selected')).toBe('true')
    const editTab = screen.getByText('編集').closest('button')!
    expect(editTab.getAttribute('aria-selected')).toBe('false')
  })

  // ── Phase 4: #277 Alt accelerator - title tooltips ───────────
  it('C-RB-21: ファイルタブに title="ファイル (Alt+F)" が付いている', () => {
    renderRibbon()
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.getAttribute('title')).toBe('ファイル (Alt+F)')
  })

  it('C-RB-22: 各タブに Alt+key ヒントの title が付いている', () => {
    renderRibbon()
    expect(screen.getByText('編集').closest('button')!.getAttribute('title')).toBe('編集 (Alt+E)')
    expect(screen.getByText('OCR').closest('button')!.getAttribute('title')).toBe('OCR (Alt+O)')
    expect(screen.getByText('表示').closest('button')!.getAttribute('title')).toBe('表示 (Alt+V)')
    expect(screen.getByText('設定').closest('button')!.getAttribute('title')).toBe('設定 (Alt+S)')
    expect(screen.getByText('ヘルプ').closest('button')!.getAttribute('title')).toBe('ヘルプ (Alt+H)')
  })

  // ── Phase 4: #277 Alt accelerator keyboard shortcuts ─────────
  it('C-RB-23: Alt+E でEditタブに切り替わる', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'e', altKey: true })
    const editTab = screen.getByText('編集').closest('button')!
    expect(editTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-24: Alt+O でOCRタブに切り替わる', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'o', altKey: true })
    const ocrTab = screen.getByText('OCR').closest('button')!
    expect(ocrTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-25: Alt+V でViewタブに切り替わる', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'v', altKey: true })
    const viewTab = screen.getByText('表示').closest('button')!
    expect(viewTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-26: Alt+S でSettingsタブに切り替わる', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 's', altKey: true })
    const settingsTab = screen.getByText('設定').closest('button')!
    expect(settingsTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-27: Alt+H でHelpタブに切り替わる', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'h', altKey: true })
    const helpTab = screen.getByText('ヘルプ').closest('button')!
    expect(helpTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-28: Alt+F でFileタブに切り替わる (別タブからの戻り)', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'e', altKey: true })
    fireEvent.keyDown(window, { key: 'f', altKey: true })
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  it('C-RB-29: Alt なしの単独キーはタブ切り替えに影響しない', () => {
    renderRibbon()
    fireEvent.keyDown(window, { key: 'e', altKey: false })
    const fileTab = screen.getByText('ファイル').closest('button')!
    expect(fileTab.classList.contains('ribbon-tab--active')).toBe(true)
  })

  // ── 表示タブ: 低信頼ハイライトトグル (#192 followup) ─────────
  it('C-RB-30: 表示タブ: 低信頼ハイライトボタンをクリックすると store state が反転する', () => {
    // store を初期状態 (showLowConfidenceHighlight=true) にリセット
    useOcrSettingsStore.setState({ showLowConfidenceHighlight: true })

    renderRibbon()
    fireEvent.click(screen.getByText('表示'))

    const btn = screen.getByTitle('低信頼ハイライト') as HTMLButtonElement
    // 初期状態 ON → active クラスと aria-pressed=true
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.classList.contains('active')).toBe(true)

    // クリックで OFF に反転
    fireEvent.click(btn)
    expect(useOcrSettingsStore.getState().showLowConfidenceHighlight).toBe(false)

    // 再クリックで ON に戻る
    fireEvent.click(btn)
    expect(useOcrSettingsStore.getState().showLowConfidenceHighlight).toBe(true)
  })
})
