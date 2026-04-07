import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => ({
  drawText:        vi.fn(),
  drawImage:       vi.fn(),
  removePage:      vi.fn(),
  insertPage:      vi.fn(),
  pushOperators:   vi.fn(),
  embedJpg:        vi.fn(),
  save:            vi.fn(),
  embedFont:       vi.fn(),
  registerFontkit: vi.fn(),
  pdfLoad:         vi.fn(),
  pdfjsGetDocument: vi.fn(),
  translateFn:     vi.fn((...args: any[]) => ({ type: 'translate', args })),
  scaleFn:         vi.fn((...args: any[]) => ({ type: 'scale', args })),
  pushGsFn:        vi.fn(() => ({ type: 'pushGs' })),
  popGsFn:         vi.fn(() => ({ type: 'popGs' })),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.pdfjsGetDocument,
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument:       { load: m.pdfLoad },
  degrees:           (n: number) => ({ type: 'degrees', angle: n }),
  PDFName:           { of: vi.fn((s: string) => s) },
  PDFString:         { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  PDFHexString:      { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  StandardFonts:     { Helvetica: 'Helvetica' },
  pushGraphicsState: m.pushGsFn,
  popGraphicsState:  m.popGsFn,
  translate:         m.translateFn,
  scale:             m.scaleFn,
}))

vi.mock('@pdf-lib/fontkit', () => ({ default: {} }))

import { loadPage, destroySharedPdfProxy } from '../../utils/pdfLoader'
import { savePDF } from '../../utils/pdfSaver'
import { usePecoStore } from '../../store/pecoStore'
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types'

// ── ヘルパー ──────────────────────────────────────────────────

interface FakeItem {
  str: string
  transform: number[]
  width: number
  height: number
}

function makeMockPdf(items: FakeItem[], viewportWidth = 595, viewportHeight = 842) {
  return {
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({
        width: viewportWidth,
        height: viewportHeight,
        // Standard non-rotated viewport: x stays, y flips
        convertToViewportPoint: (x: number, y: number) => [x, viewportHeight - y],
      }),
      getTextContent: vi.fn().mockResolvedValue({ items }),
    }),
  }
}

/** getDocument がこの items を持つ pdf を返すようにセットアップ */
function setupGetDocument(items: FakeItem[], viewportWidth = 595, viewportHeight = 842) {
  const mockPdf = makeMockPdf(items, viewportWidth, viewportHeight)
  m.pdfjsGetDocument.mockReturnValue({ promise: Promise.resolve(mockPdf) })
  return mockPdf
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: `block-${Math.random()}`,
    text: 'テスト',
    originalText: 'テスト',
    bbox: { x: 10, y: 100, width: 80, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
    ...overrides,
  }
}

function makePage(blocks: TextBlock[], isDirty = true): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty,
    thumbnail: null,
  }
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: '',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

// ── グローバル beforeEach：キャッシュをテスト間でリセット ──────
beforeEach(() => {
  destroySharedPdfProxy()
})

// ── I-01: テキスト抽出パイプライン（横書き）──────────────────

describe('I-01: テキスト抽出パイプライン（横書き）', () => {
  it('横書きアイテムのページ → 全ブロックが writingMode="horizontal"、bbox が正値', async () => {
    const items: FakeItem[] = [
      { str: 'Hello', transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12 },
      { str: 'World', transform: [12, 0, 0, 12, 200, 700], width: 60, height: 12 },
      { str: 'Line2', transform: [12, 0, 0, 12, 72, 650], width: 60, height: 12 },
    ]
    setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, '')

    expect(pageData.textBlocks.length).toBe(3)

    for (const block of pageData.textBlocks) {
      expect(block.writingMode).toBe('horizontal')
      expect(block.bbox.x).toBeGreaterThanOrEqual(0)
      expect(block.bbox.y).toBeGreaterThanOrEqual(0)
      expect(block.bbox.width).toBeGreaterThan(0)
      expect(block.bbox.height).toBeGreaterThan(0)
      expect(block.bbox.width).toBeGreaterThan(block.bbox.height)
    }
  })

  it('空文字アイテムはフィルタリングされ含まれない', async () => {
    const items: FakeItem[] = [
      { str: 'Hello', transform: [12, 0, 0, 12, 72, 700], width: 60, height: 12 },
      { str: '   ', transform: [12, 0, 0, 12, 150, 700], width: 0, height: 12 },
      { str: 'World', transform: [12, 0, 0, 12, 200, 700], width: 60, height: 12 },
    ]
    setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, '')

    expect(pageData.textBlocks.length).toBe(2)
    expect(pageData.textBlocks.map(b => b.text)).toEqual(['Hello', 'World'])
  })
})

// ── I-02: テキスト抽出パイプライン（縦書き）──────────────────

describe('I-02: テキスト抽出パイプライン（縦書き）', () => {
  it('縦書きアイテムのページ → 全ブロックが writingMode="vertical"、bbox が縦長', async () => {
    const items: FakeItem[] = [
      { str: '縦書き', transform: [0, 14, -14, 0, 500, 600], width: 42, height: 14 },
      { str: 'テスト', transform: [0, 14, -14, 0, 460, 600], width: 42, height: 14 },
    ]
    setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, '')

    expect(pageData.textBlocks.length).toBe(2)

    for (const block of pageData.textBlocks) {
      expect(block.writingMode).toBe('vertical')
      expect(block.bbox.height).toBeGreaterThan(block.bbox.width)
    }
  })

  it('縦書きブロックの order は 0 から順に振られる', async () => {
    const items: FakeItem[] = [
      { str: 'A', transform: [0, 14, -14, 0, 500, 600], width: 14, height: 14 },
      { str: 'B', transform: [0, 14, -14, 0, 460, 600], width: 14, height: 14 },
    ]
    setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, '')

    expect(pageData.textBlocks[0].order).toBe(0)
    expect(pageData.textBlocks[1].order).toBe(1)
  })
})

// ── I-04: Undo/Redo サイクル ──────────────────────────────────

describe('I-04: Undo/Redo サイクル', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('テキスト編集 → undo → redo → 編集前→後→後の状態が一致', () => {
    const originalBlock = makeBlock({ id: 'b1', text: 'original', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([originalBlock], false)]]))
    usePecoStore.setState({ document: doc })

    const { updatePageData } = usePecoStore.getState()

    const editedBlock = { ...originalBlock, text: 'edited', isDirty: true }
    updatePageData(0, { textBlocks: [editedBlock], isDirty: true })

    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('edited')
    expect(usePecoStore.getState().undoStack.length).toBe(1)

    usePecoStore.getState().undo()
    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('original')
    expect(usePecoStore.getState().undoStack.length).toBe(0)
    expect(usePecoStore.getState().redoStack.length).toBe(1)

    usePecoStore.getState().redo()
    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('edited')
    expect(usePecoStore.getState().undoStack.length).toBe(1)
    expect(usePecoStore.getState().redoStack.length).toBe(0)
  })

  it('連続編集 → undo で順に戻る', () => {
    const block = makeBlock({ id: 'b1', text: 'v0', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([block], false)]]))
    usePecoStore.setState({ document: doc })

    const { updatePageData } = usePecoStore.getState()

    updatePageData(0, { textBlocks: [{ ...block, text: 'v1' }] })
    updatePageData(0, { textBlocks: [{ ...block, text: 'v2' }] })

    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('v2')

    usePecoStore.getState().undo()
    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('v1')

    usePecoStore.getState().undo()
    expect(usePecoStore.getState().document?.pages.get(0)?.textBlocks[0].text).toBe('v0')
  })
})

// ── I-05: 保存→再読み込み ─────────────────────────────────────

describe('I-05: 保存→再読み込み', () => {
  it.todo('savePDF → loadPage で保存内容が復元される（実PDF処理が必要なためE2E対象）')
})

// ── I-06: 縦書きPDFの保存 ────────────────────────────────────

describe('I-06: 縦書きPDFの保存', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
    }))

    m.translateFn.mockImplementation((...args: any[]) => ({ type: 'translate', args }))
    m.scaleFn.mockImplementation((...args: any[]) => ({ type: 'scale', args }))

    const mockPage = {
      drawText:     m.drawText,
      drawImage:    m.drawImage,
      pushOperators: m.pushOperators,
      node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
      getWidth: () => 595,
      getHeight: () => 842,
      getSize: () => ({ width: 595, height: 842 }),
    }
    const mockPdfDoc = {
      registerFontkit: m.registerFontkit,
      embedFont:   m.embedFont,
      removePage:  m.removePage,
      insertPage:  m.insertPage,
      getPage:     vi.fn().mockReturnValue(mockPage),
      embedJpg:    m.embedJpg,
      save:        m.save,
      context: { lookup: vi.fn() },
      getInfoDict: vi.fn().mockReturnValue({ lookup: vi.fn(), set: vi.fn() }),
    }
    m.embedFont.mockResolvedValue({
      widthOfTextAtSize: vi.fn().mockReturnValue(10),
      heightAtSize: vi.fn().mockReturnValue(1.448),
    })
    m.insertPage.mockReturnValue(mockPage)
    m.embedJpg.mockResolvedValue({ width: 1, height: 1 })
    m.save.mockResolvedValue(new Uint8Array(10))
    m.pdfLoad.mockResolvedValue(mockPdfDoc)

    m.pdfjsGetDocument.mockReturnValue({
      promise: Promise.resolve({
        getPage: vi.fn().mockResolvedValue({
          getViewport: vi.fn().mockImplementation(({ scale }: { scale: number }) => ({
            width:  595 * scale,
            height: 842 * scale,
          })),
          render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
        }),
      }),
    })
  })

  it('縦書きブロックを含む savePDF → drawText が rotate=-90° で呼ばれる', async () => {
    const verticalBlock = makeBlock({
      writingMode: 'vertical' as WritingMode,
      bbox: { x: 100, y: 200, width: 20, height: 100 },
      isDirty: true,
    })
    const doc = makeDoc(new Map([[0, makePage([verticalBlock], true)]]))

    await savePDF(new Uint8Array(10), doc)

    expect(m.drawText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        rotate: expect.objectContaining({ angle: -90 }),
      })
    )
  })
})
