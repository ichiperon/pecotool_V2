import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Ribbon } from '../../components/Ribbon/Ribbon'
import type { PageData } from '../../types'

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
})
