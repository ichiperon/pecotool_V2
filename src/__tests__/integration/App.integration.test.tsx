import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '../../App'
import { usePecoStore } from '../../store/pecoStore'
import type { TextBlock, PageData, PecoDocument } from '../../types'

// ── Tauri / プラグインのモック ────────────────────────────────

const mockEmit = vi.fn().mockResolvedValue(undefined)
const mockListen = vi.fn().mockResolvedValue(() => {})

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: any[]) => mockEmit(...args),
  listen: (...args: any[]) => mockListen(...args),
}))

const mockGetAllWindows = vi.fn().mockResolvedValue([])
const mockGetCurrentWindow = vi.fn()

vi.mock('@tauri-apps/api/window', () => ({
  getAllWindows: (...args: any[]) => mockGetAllWindows(...args),
  getCurrentWindow: () => mockGetCurrentWindow(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    once = vi.fn()
  },
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalSize: vi.fn(),
  PhysicalPosition: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn(),
  loadPage: vi.fn(),
  loadPecoToolBBoxMeta: vi.fn(),
  openPDF: vi.fn(),
  generateThumbnail: vi.fn(),
}))

vi.mock('../../utils/pdfSaver', () => ({
  savePDF: vi.fn(),
}))

vi.mock('../../components/PdfCanvas', () => ({
  PdfCanvas: () => <div data-testid="pdf-canvas" />,
}))

vi.mock('../../components/OcrEditor', () => ({
  OcrEditor: () => <div data-testid="ocr-editor" />,
}))

// ── ヘルパー ──────────────────────────────────────────────────

function makeBlock(id: string, text: string, order: number, overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 10, y: 100 + order * 30, width: 80, height: 20 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
    ...overrides,
  }
}

function makePage(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  }
}

function makeDoc(blocks: TextBlock[]): PecoDocument {
  return {
    filePath: '/test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, makePage(blocks)]]),
  }
}

// ── setup ──────────────────────────────────────────────────────

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()

  mockGetAllWindows.mockResolvedValue([])
  mockGetCurrentWindow.mockReturnValue({
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    outerSize:   vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
    outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
    scaleFactor: vi.fn().mockResolvedValue(1),
  })
  mockEmit.mockResolvedValue(undefined)
  mockListen.mockResolvedValue(() => {})

  // ResizeObserver スタブ（jsdom が実装していないため）
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });

  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    currentPageIndex: 0,
    zoom: 100,
    showOcr: true,
    isDrawingMode: false,
    isSplitMode: false,
  } as any)
})

// ── I-03: ブロックマージ（グループ化）────────────────────────

describe('I-03: ブロックマージ', () => {
  it('複数ブロックを選択してグループ化 → 結合テキスト、bbox が全体を包む', async () => {
    const blockA = makeBlock('block-a', 'ブロックA', 0, {
      bbox: { x: 10, y: 100, width: 80, height: 20 },
    })
    const blockB = makeBlock('block-b', 'ブロックB', 1, {
      bbox: { x: 10, y: 130, width: 80, height: 20 },
    })
    const doc = makeDoc([blockA, blockB])
    usePecoStore.setState({
      document: doc,
      selectedIds: new Set(['block-a', 'block-b']),
      currentPageIndex: 0,
    } as any)

    render(<App />)

    // グループ化ボタンをクリック（span テキストで検索）
    const groupBtn = screen.getByTitle('グループ化')
    expect((groupBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(groupBtn)

    const page = usePecoStore.getState().document?.pages.get(0)
    expect(page?.textBlocks.length).toBe(1)

    const merged = page!.textBlocks[0]
    // 結合テキストに両ブロックのテキストが含まれる
    expect(merged.text).toContain('ブロックA')
    expect(merged.text).toContain('ブロックB')
    // bbox が2ブロック全体を包む
    expect(merged.bbox.x).toBeLessThanOrEqual(10)    // min(10, 10)
    expect(merged.bbox.y).toBeLessThanOrEqual(100)   // min(100, 130)
    expect(merged.bbox.x + merged.bbox.width).toBeGreaterThanOrEqual(90)   // max(90, 90)
    expect(merged.bbox.y + merged.bbox.height).toBeGreaterThanOrEqual(150) // max(120, 150)
  })
})

// ── I-07: 重複削除 ────────────────────────────────────────────

describe('I-07: 重複削除', () => {
  it('同一テキスト・同一 bbox の2ブロック → 1ブロックに削減', () => {
    const dup1 = makeBlock('dup-1', '重複テキスト', 0, {
      bbox: { x: 10, y: 100, width: 80, height: 20 },
    })
    const dup2 = makeBlock('dup-2', '重複テキスト', 1, {
      bbox: { x: 10, y: 100, width: 80, height: 20 },
    })
    const doc = makeDoc([dup1, dup2])
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    render(<App />)

    fireEvent.click(screen.getByTitle('重複削除'))

    const page = usePecoStore.getState().document?.pages.get(0)
    expect(page?.textBlocks.length).toBe(1)
    expect(page?.textBlocks[0].id).toBe('dup-1')
  })

  it('異なるテキストのブロックは削除されない', () => {
    const b1 = makeBlock('b1', 'テキストA', 0, { bbox: { x: 10, y: 100, width: 80, height: 20 } })
    const b2 = makeBlock('b2', 'テキストB', 1, { bbox: { x: 10, y: 100, width: 80, height: 20 } })
    const doc = makeDoc([b1, b2])
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    render(<App />)

    fireEvent.click(screen.getByTitle('重複削除'))

    const page = usePecoStore.getState().document?.pages.get(0)
    expect(page?.textBlocks.length).toBe(2)
  })
})

// ── I-08: テキストプレビューの順序 ───────────────────────────

describe('I-08: テキストプレビューの順序', () => {
  it('縦書きブロックが異なる列にあるとき → 改行で区切られる', async () => {
    const v1 = makeBlock('v1', '縦書き', 0, {
      writingMode: 'vertical',
      bbox: { x: 500, y: 0, width: 20, height: 100 },
    })
    const v2 = makeBlock('v2', '別列', 1, {
      writingMode: 'vertical',
      bbox: { x: 400, y: 0, width: 20, height: 100 },
    })
    const doc = makeDoc([v1, v2])
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    render(<App />)

    // emit('preview-update', '縦書き\n別列') が呼ばれるのを待つ
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('preview-update', '縦書き\n別列')
    })
  })

  it('横書きブロックが同一行にあるとき → 連続して結合', async () => {
    const h1 = makeBlock('h1', '一行目', 0, {
      writingMode: 'horizontal',
      bbox: { x: 0, y: 0, width: 60, height: 20 },
    })
    const h2 = makeBlock('h2', '同行', 1, {
      writingMode: 'horizontal',
      bbox: { x: 80, y: 0, width: 40, height: 20 },  // 同じ Y、すぐ右隣
    })
    const doc = makeDoc([h1, h2])
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    render(<App />)

    // 同じ行なので改行なし（gap = 80 - 60 = 20、height=20 より大きくない → スペースなし）
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('preview-update', '一行目同行')
    })
  })

  it('order 順に連結される（order が逆でも正しい順序）', async () => {
    // order が逆順で定義されていても order プロパティで並べ替えられる
    const b2 = makeBlock('b2', '後', 1, { bbox: { x: 20, y: 0, width: 20, height: 20 } })
    const b1 = makeBlock('b1', '前', 0, { bbox: { x: 0, y: 0, width: 20, height: 20 } })
    const doc = makeDoc([b2, b1]) // 逆順で page に登録
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any)

    render(<App />)

    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('preview-update', '前後')
    })
  })
})
