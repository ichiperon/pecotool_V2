import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Toolbar } from '../../components/Toolbar/Toolbar'
import type { PecoDocument, PageData } from '../../types'

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
    Settings: s('Settings'),
    RemoveFormatting: s('RemoveFormatting'),
    ScanText: s('ScanText'),
    X: s('X'),
    Loader2: s('Loader2'),
    FileX: s('FileX'),
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

const dummyDocument: PecoDocument = {
  filePath: '/test.pdf',
  fileName: 'test.pdf',
  totalPages: 1,
  metadata: {},
  pages: new Map([[0, dummyPage]]),
}

function defaultProps(overrides: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  return {
    document: dummyDocument,
    currentPage: dummyPage,
    isDirty: false,
    undoStackLength: 0,
    redoStackLength: 0,
    zoom: 1,
    isAutoFit: false,
    isDrawingMode: false,
    isSplitMode: false,
    selectedIdsCount: 0,
    showOcr: false,
    ocrOpacity: 0.5,
    reorderThreshold: 50,
    isPreviewOpen: false,
    showSettingsDropdown: false,
    isOcrRunning: false,
    ocrProgress: null,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFit: vi.fn(),
    onToggleDrawing: vi.fn(),
    onToggleSplit: vi.fn(),
    onGroup: vi.fn(),
    onDeduplicate: vi.fn(),
    onRemoveSpaces: vi.fn(),
    onDelete: vi.fn(),
    onToggleOcr: vi.fn(),
    onSetOcrOpacity: vi.fn(),
    onSetReorderThreshold: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleSettingsDropdown: vi.fn(),
    onRunOcrCurrentPage: vi.fn(),
    onRunOcrAllPages: vi.fn(),
    onCancelOcr: vi.fn(),
    onClearOcrCurrentPage: vi.fn(),
    onClearOcrAllPages: vi.fn(),
    ...overrides,
  }
}

function renderToolbar(overrides: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  return render(<Toolbar {...defaultProps(overrides)} />)
}

function getButton(title: string): HTMLButtonElement {
  return screen.getByTitle(title) as HTMLButtonElement
}

// ── テスト ───────────────────────────────────────────────────

describe('Toolbar', () => {
  afterEach(cleanup)

  it('C-TB-01: undo disabled when undoStackLength=0', () => {
    renderToolbar({ undoStackLength: 0 })
    expect(getButton('元に戻す (Ctrl+Z)').disabled).toBe(true)
  })

  it('C-TB-02: undo enabled when undoStackLength=3', () => {
    renderToolbar({ undoStackLength: 3 })
    expect(getButton('元に戻す (Ctrl+Z)').disabled).toBe(false)
  })

  it('C-TB-03: redo disabled when redoStackLength=0', () => {
    renderToolbar({ redoStackLength: 0 })
    expect(getButton('やり直し (Ctrl+Y)').disabled).toBe(true)
  })

  it('C-TB-04: group disabled when selectedIdsCount < 2', () => {
    renderToolbar({ selectedIdsCount: 1 })
    expect(getButton('グループ化').disabled).toBe(true)
  })

  it('C-TB-05: group enabled when selectedIdsCount >= 2', () => {
    renderToolbar({ selectedIdsCount: 2 })
    expect(getButton('グループ化').disabled).toBe(false)
  })

  it('C-TB-06: delete disabled when selectedIdsCount=0', () => {
    renderToolbar({ selectedIdsCount: 0 })
    expect(getButton('削除').disabled).toBe(true)
  })

  it('C-TB-07: drawing mode active class when isDrawingMode=true', () => {
    renderToolbar({ isDrawingMode: true })
    expect(getButton('BB追加').className).toContain('active')
  })

  it('C-TB-08: split mode active class when isSplitMode=true', () => {
    renderToolbar({ isSplitMode: true })
    expect(getButton('BB分割').className).toContain('active')
  })

  it('C-TB-09: preview button active when isPreviewOpen=true', () => {
    renderToolbar({ isPreviewOpen: true })
    expect(getButton('プレビュー').className).toContain('active')
  })

  it('C-TB-10: OCR dropdown opens on click', () => {
    renderToolbar()
    fireEvent.click(getButton('OCR実行'))
    expect(screen.getByText('現在のページ')).toBeTruthy()
  })

  it('C-TB-11: OCR button disabled when isOcrRunning=true', () => {
    renderToolbar({ isOcrRunning: true, ocrProgress: { current: 1, total: 5 } })
    expect(getButton('OCR実行').disabled).toBe(true)
  })

  it('C-TB-12: OCR progress text', () => {
    renderToolbar({ isOcrRunning: true, ocrProgress: { current: 5, total: 20 } })
    expect(screen.getByText('OCR 5/20')).toBeTruthy()
  })

  it('C-TB-13: cancel button shown when isOcrRunning + ocrProgress', () => {
    renderToolbar({ isOcrRunning: true, ocrProgress: { current: 5, total: 20 } })
    expect(screen.getByText('キャンセル')).toBeTruthy()
  })

  it('C-TB-14: add/split disabled when document=null', () => {
    renderToolbar({ document: null })
    expect(getButton('BB追加').disabled).toBe(true)
    expect(getButton('BB分割').disabled).toBe(true)
  })

  it('C-TB-15: removeSpaces disabled when selectedIdsCount=0', () => {
    renderToolbar({ selectedIdsCount: 0 })
    expect(getButton('スペース削除 (Ctrl+Shift+Space)').disabled).toBe(true)
  })

  it('C-TB-16: settings dropdown shows opacity slider when showSettingsDropdown=true', () => {
    const { container } = renderToolbar({ showSettingsDropdown: true })
    expect(container.querySelector('.ocr-opacity-slider')).toBeTruthy()
  })
})
