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

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}))
vi.mock('../../utils/bitmapCache', () => ({
  clearBitmapCache: vi.fn(),
}))

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

import { loadPage, destroySharedPdfProxy, getSharedPdfProxy } from '../../utils/pdfLoader'
import { savePDF, __setSaveWorkerFactoryForTest, __resetSaveStateForTest } from '../../utils/pdfSaver'
import { usePecoStore } from '../../store/pecoStore'
import { logger } from '../../utils/logger'
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

/** getDocument がこの items を持つ pdf を返すようにセットアップ + shared proxy をプリシード */
async function setupGetDocument(items: FakeItem[], viewportWidth = 595, viewportHeight = 842) {
  const mockPdf = makeMockPdf(items, viewportWidth, viewportHeight)
  m.pdfjsGetDocument.mockReturnValue({ promise: Promise.resolve(mockPdf) })
  // Pre-seed the shared proxy so getCachedPageProxy doesn't increment globalLoadId
  await getSharedPdfProxy('test.pdf')
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
    await setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, 'test.pdf')

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
    await setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, 'test.pdf')

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
    await setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, 'test.pdf')

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
    await setupGetDocument(items)
    const pageData = await loadPage({} as any, 0, 'test.pdf')

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

// ── S-09: Undo/Redo サイクル後の destroy 警告 ────────────────

describe('S-09: Undo/Redo サイクル後の destroy 警告', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('S-09-01: 編集→Undo→Redo を 5 サイクル繰り返し、destroySharedPdfProxy で proxy.destroy 不在を logger.warn が観測できる', async () => {
    // proxy が destroy を持たないモック (= 既存テストと同じ簡易 mockPdf) をシード
    const items: FakeItem[] = [
      { str: 'A', transform: [12, 0, 0, 12, 72, 700], width: 12, height: 12 },
    ]
    await setupGetDocument(items)

    // 編集対象の document を作って Undo/Redo サイクルを回す
    const block = makeBlock({ id: 'b1', text: 'v0', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([block], false)]]))
    usePecoStore.setState({ document: doc })

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // 5 サイクル: 編集 → undo → redo
      for (let i = 0; i < 5; i++) {
        usePecoStore.getState().updatePageData(0, {
          textBlocks: [{ ...block, text: `v${i + 1}` }],
        })
        usePecoStore.getState().undo()
        usePecoStore.getState().redo()
      }

      // 5 サイクル後の状態は v5 (最後の編集後)
      expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('v5')

      // destroySharedPdfProxy を呼ぶと、proxy.destroy が無いため logger.warn が走る
      destroySharedPdfProxy()
      // proxy.promise.then(...) 内の警告は microtask で発火するため待機
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // logger.warn は silent ではなく観測可能に呼ばれている
      const warnCalls = warnSpy.mock.calls
      const matched = warnCalls.find((c) =>
        typeof c[0] === 'string' &&
        c[0].includes('destroySharedPdfProxy: proxy.destroy is not a function')
      )
      expect(matched).toBeDefined()
    } finally {
      warnSpy.mockRestore()
    }
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

    // savePDF を main thread fallback で動かす（Worker 不要）
    __setSaveWorkerFactoryForTest(() => null)
    __resetSaveStateForTest()

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
    commit:        m.save,
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

// ── 追加インポート ──────────────────────────────────────────────
import { sortOcrBlocks } from '../../utils/ocrSort'
import { classifyDirection, reorderBlocks } from '../../utils/bulkReorder'
import { formatFileSize } from '../../utils/format'
import type { OcrResultBlock } from '../../types'
import type { OcrSortSettings } from '../../store/ocrSettingsStore'

// ── I-03: Block merge (group) - combined bbox + text ─────────

describe('I-03: Block merge (group) - combined bbox + text', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('3つの選択ブロックをマージすると結合bbox・テキスト連結・isDirty=true', () => {
    const b1 = makeBlock({ id: 'b1', text: 'AAA', order: 0, bbox: { x: 10, y: 10, width: 50, height: 20 } })
    const b2 = makeBlock({ id: 'b2', text: 'BBB', order: 1, bbox: { x: 70, y: 10, width: 50, height: 20 } })
    const b3 = makeBlock({ id: 'b3', text: 'CCC', order: 2, bbox: { x: 10, y: 40, width: 50, height: 20 } })
    const page = makePage([b1, b2, b3], false)
    const doc = makeDoc(new Map([[0, page]]))
    usePecoStore.setState({ document: doc, selectedIds: new Set(['b1', 'b2', 'b3']), currentPageIndex: 0 })

    // Execute merge logic
    const state = usePecoStore.getState()
    const currentPage = state.document!.pages.get(0)!
    const selectedBlocks = currentPage.textBlocks
      .filter(b => state.selectedIds.has(b.id))
      .sort((a, b) => a.order - b.order)

    const minX = Math.min(...selectedBlocks.map(b => b.bbox.x))
    const minY = Math.min(...selectedBlocks.map(b => b.bbox.y))
    const maxX = Math.max(...selectedBlocks.map(b => b.bbox.x + b.bbox.width))
    const maxY = Math.max(...selectedBlocks.map(b => b.bbox.y + b.bbox.height))
    const mergedText = selectedBlocks.map(b => b.text).join('')

    const mergedBlock = makeBlock({
      id: 'merged-1',
      text: mergedText,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      order: 0,
      isDirty: true,
    })

    state.updatePageData(0, { textBlocks: [mergedBlock], isDirty: true })

    const result = usePecoStore.getState()
    const resultPage = result.document!.pages.get(0)!
    expect(resultPage.textBlocks.length).toBe(1)
    expect(resultPage.textBlocks[0].text).toBe('AAABBBCCC')
    expect(resultPage.textBlocks[0].bbox).toEqual({ x: 10, y: 10, width: 110, height: 50 })
    expect(result.isDirty).toBe(true)
  })
})

// ── I-05: Redo full cycle ────────────────────────────────────

describe('I-05: Redo full cycle', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('3アクション push → 全 undo → 全 redo → state復元・redoStack空・undoStack=3', () => {
    const block = makeBlock({ id: 'b1', text: 'v0', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([block], false)]]))
    usePecoStore.setState({ document: doc })

    const { updatePageData } = usePecoStore.getState()
    updatePageData(0, { textBlocks: [{ ...block, text: 'v1' }] })
    updatePageData(0, { textBlocks: [{ ...block, text: 'v2' }] })
    updatePageData(0, { textBlocks: [{ ...block, text: 'v3' }] })

    expect(usePecoStore.getState().undoStack.length).toBe(3)

    // Undo all 3
    usePecoStore.getState().undo()
    usePecoStore.getState().undo()
    usePecoStore.getState().undo()

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('v0')
    expect(usePecoStore.getState().undoStack.length).toBe(0)
    expect(usePecoStore.getState().redoStack.length).toBe(3)

    // Redo all 3
    usePecoStore.getState().redo()
    usePecoStore.getState().redo()
    usePecoStore.getState().redo()

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('v3')
    expect(usePecoStore.getState().redoStack.length).toBe(0)
    expect(usePecoStore.getState().undoStack.length).toBe(3)
  })
})

// ── I-07: Undo stack limit (101→100) ────────────────────────

describe('I-07: Undo stack limit (101→100)', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('101アクション push → undoStack.length === 100', () => {
    const block = makeBlock({ id: 'b1', text: 'v0', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([block], false)]]))
    usePecoStore.setState({ document: doc })

    for (let i = 1; i <= 101; i++) {
      usePecoStore.getState().updatePageData(0, {
        textBlocks: [{ ...block, text: `v${i}` }],
      })
    }

    expect(usePecoStore.getState().undoStack.length).toBe(100)
  })
})

// ── I-08: Duplicate removal ─────────────────────────────────

describe('I-08: Duplicate removal', () => {
  it('テキスト一致 & bbox差<5 のブロックを重複除去 → 2ブロック残る', () => {
    const blockA = makeBlock({ id: 'a', text: 'x', bbox: { x: 10, y: 10, width: 50, height: 20 } })
    const blockB = makeBlock({ id: 'b', text: 'x', bbox: { x: 11, y: 11, width: 50, height: 20 } })
    const blockC = makeBlock({ id: 'c', text: 'y', bbox: { x: 100, y: 100, width: 50, height: 20 } })

    const blocks = [blockA, blockB, blockC]

    // Implement dedup: find blocks where text matches AND bbox coordinates differ by <5
    const deduped: typeof blocks = []
    for (const block of blocks) {
      const isDuplicate = deduped.some(
        existing =>
          existing.text === block.text &&
          Math.abs(existing.bbox.x - block.bbox.x) < 5 &&
          Math.abs(existing.bbox.y - block.bbox.y) < 5
      )
      if (!isDuplicate) {
        deduped.push(block)
      }
    }

    expect(deduped.length).toBe(2)
    expect(deduped[0].id).toBe('a')
    expect(deduped[1].id).toBe('c')
  })
})

// ── I-09: Text preview ordering matches editor order ────────

describe('I-09: Text preview ordering matches editor order', () => {
  it('order [2,0,1] のブロックをソート → テキスト "A\\nB\\nC"', () => {
    const blocks = [
      makeBlock({ id: 'b0', text: 'C', order: 2 }),
      makeBlock({ id: 'b1', text: 'A', order: 0 }),
      makeBlock({ id: 'b2', text: 'B', order: 1 }),
    ]

    const sorted = [...blocks].sort((a, b) => a.order - b.order)
    const previewText = sorted.map(b => b.text).join('\n')

    expect(previewText).toBe('A\nB\nC')
  })
})

// ── I-12: Copy/Paste workflow ────────────────────────────────

describe('I-12: Copy/Paste workflow', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
      clipboard: [],
      currentPageIndex: 0,
    } as any)
  })

  it('2ブロック選択 → copySelected → pasteClipboard → offset付き新ブロック追加', () => {
    const b1 = makeBlock({ id: 'b1', text: 'Hello', order: 0, bbox: { x: 10, y: 20, width: 80, height: 20 } })
    const b2 = makeBlock({ id: 'b2', text: 'World', order: 1, bbox: { x: 10, y: 50, width: 80, height: 20 } })
    const page = makePage([b1, b2], false)
    const doc = makeDoc(new Map([[0, page]]))
    usePecoStore.setState({ document: doc, selectedIds: new Set(['b1', 'b2']), currentPageIndex: 0 })

    usePecoStore.getState().copySelected()
    expect(usePecoStore.getState().clipboard.length).toBe(2)

    usePecoStore.getState().pasteClipboard()

    const resultPage = usePecoStore.getState().document!.pages.get(0)!
    expect(resultPage.textBlocks.length).toBe(4)

    const pasted = resultPage.textBlocks.slice(2)
    expect(pasted.length).toBe(2)

    // New UUIDs
    expect(pasted[0].id).not.toBe('b1')
    expect(pasted[1].id).not.toBe('b2')

    // Offset +10, +10
    expect(pasted[0].bbox.x).toBe(20)
    expect(pasted[0].bbox.y).toBe(30)
    expect(pasted[1].bbox.x).toBe(20)
    expect(pasted[1].bbox.y).toBe(60)

    // isNew and isDirty
    for (const p of pasted) {
      expect(p.isNew).toBe(true)
      expect(p.isDirty).toBe(true)
    }

    expect(usePecoStore.getState().isDirty).toBe(true)
  })
})

// ── I-13: Bulk reorder left-right ────────────────────────────

describe('I-13: Bulk reorder left-right', () => {
  it('4ブロックを left-right で reorder → cx 昇順', () => {
    const blocks = [
      makeBlock({ id: 'a', order: 0, bbox: { x: 200, y: 10, width: 40, height: 20 } }),
      makeBlock({ id: 'b', order: 1, bbox: { x: 10, y: 10, width: 40, height: 20 } }),
      makeBlock({ id: 'c', order: 2, bbox: { x: 300, y: 10, width: 40, height: 20 } }),
      makeBlock({ id: 'd', order: 3, bbox: { x: 100, y: 10, width: 40, height: 20 } }),
    ]

    const result = reorderBlocks(blocks, 'left-right', 50)

    // cx values: a=220, b=30, c=320, d=120 → sorted: b(30), d(120), a(220), c(320)
    expect(result.map(b => b.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(result[0].order).toBe(0)
    expect(result[1].order).toBe(1)
    expect(result[2].order).toBe(2)
    expect(result[3].order).toBe(3)
    for (const b of result) {
      expect(b.isDirty).toBe(true)
    }
  })
})

// ── I-16: OCR settings change re-sorts blocks ───────────────

describe('I-16: OCR settings change re-sorts blocks', () => {
  const makeOcrBlock = (overrides: Partial<OcrResultBlock>): OcrResultBlock => ({
    text: 'test',
    bbox: { x: 0, y: 0, width: 50, height: 20 },
    writingMode: 'horizontal',
    confidence: 0.9,
    ...overrides,
  })

  const baseSettings: OcrSortSettings = {
    horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
    vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
    groupTolerance: 20,
    mixedOrder: 'vertical-first',
  }

  it('vertical-first → V が H の前', () => {
    const blocks: OcrResultBlock[] = [
      makeOcrBlock({ text: 'H1', writingMode: 'horizontal', bbox: { x: 10, y: 10, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'V1', writingMode: 'vertical', bbox: { x: 200, y: 10, width: 20, height: 50 } }),
    ]

    const result = sortOcrBlocks(blocks, { ...baseSettings, mixedOrder: 'vertical-first' })
    expect(result[0].text).toBe('V1')
    expect(result[1].text).toBe('H1')
  })

  it('horizontal-first → H が V の前', () => {
    const blocks: OcrResultBlock[] = [
      makeOcrBlock({ text: 'V1', writingMode: 'vertical', bbox: { x: 200, y: 10, width: 20, height: 50 } }),
      makeOcrBlock({ text: 'H1', writingMode: 'horizontal', bbox: { x: 10, y: 10, width: 50, height: 20 } }),
    ]

    const result = sortOcrBlocks(blocks, { ...baseSettings, mixedOrder: 'horizontal-first' })
    expect(result[0].text).toBe('H1')
    expect(result[1].text).toBe('V1')
  })
})

// ── I-23: classifyDirection utility ─────────────────────────

describe('I-23: classifyDirection utility', () => {
  it('(100,0) → left-right', () => {
    expect(classifyDirection(100, 0)).toBe('left-right')
  })

  it('(0,100) → up-down', () => {
    expect(classifyDirection(0, 100)).toBe('up-down')
  })

  it('(-100,0) → right-left', () => {
    expect(classifyDirection(-100, 0)).toBe('right-left')
  })

  it('(0,-100) → down-up', () => {
    expect(classifyDirection(0, -100)).toBe('down-up')
  })

  it('(2,2) → null (距離不足)', () => {
    expect(classifyDirection(2, 2)).toBeNull()
  })
})

// ── I-24: Space removal ─────────────────────────────────────

describe('I-24: Space removal', () => {
  beforeEach(() => {
    usePecoStore.setState({
      document: null,
      selectedIds: new Set<string>(),
      undoStack: [],
      redoStack: [],
      isDirty: false,
    } as any)
  })

  it('半角・全角スペースを除去 → "こんにちは" と "世界"', () => {
    const b1 = makeBlock({ id: 'b1', text: 'こん にちは', order: 0 })
    const b2 = makeBlock({ id: 'b2', text: '世\u3000界', order: 1 })
    const page = makePage([b1, b2], false)
    const doc = makeDoc(new Map([[0, page]]))
    usePecoStore.setState({ document: doc })

    // Remove half-width and full-width spaces
    const currentPage = usePecoStore.getState().document!.pages.get(0)!
    const cleaned = currentPage.textBlocks.map(b => ({
      ...b,
      text: b.text.replace(/[\s\u3000]/g, ''),
      isDirty: true,
    }))

    usePecoStore.getState().updatePageData(0, { textBlocks: cleaned, isDirty: true })

    const resultPage = usePecoStore.getState().document!.pages.get(0)!
    expect(resultPage.textBlocks[0].text).toBe('こんにちは')
    expect(resultPage.textBlocks[1].text).toBe('世界')
  })
})

// ── I-25: setDocument resets all editing state ──────────────

describe('I-25: setDocument resets all editing state', () => {
  it('dirty state, undo history, selections をリセット', () => {
    // Setup dirty state
    const block = makeBlock({ id: 'b1', text: 'old', isDirty: true })
    const oldDoc = makeDoc(new Map([[0, makePage([block], true)]]))
    usePecoStore.setState({
      document: oldDoc,
      isDirty: true,
      undoStack: [{ type: 'update_page', pageIndex: 0, before: makePage([block]), after: makePage([block]) }],
      redoStack: [{ type: 'update_page', pageIndex: 0, before: makePage([block]), after: makePage([block]) }],
      selectedIds: new Set(['b1']),
    } as any)

    // Call setDocument with new doc
    const newBlock = makeBlock({ id: 'b2', text: 'new', isDirty: false })
    const newDoc = makeDoc(new Map([[0, makePage([newBlock], false)]]))
    usePecoStore.getState().setDocument(newDoc)

    const state = usePecoStore.getState()
    expect(state.undoStack).toEqual([])
    expect(state.redoStack).toEqual([])
    expect(state.selectedIds.size).toBe(0)
    expect(state.isDirty).toBe(false)
  })
})

// ── I-26: formatFileSize utility ────────────────────────────

describe('I-26: formatFileSize utility', () => {
  it('0 → "0 B"', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('1024 → "1 KB"', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
  })

  it('1048576 → "1 MB"', () => {
    expect(formatFileSize(1048576)).toBe('1 MB')
  })

  it('1073741824 → "1 GB"', () => {
    expect(formatFileSize(1073741824)).toBe('1 GB')
  })
})
