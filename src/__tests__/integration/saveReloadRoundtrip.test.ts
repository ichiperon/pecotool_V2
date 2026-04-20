/**
 * S-03: OCR 編集 → 保存 → 再読込ラウンドトリップ
 *
 * 検証対象:
 *  - S-03-01: 複数ページの textBlocks 編集 → savePDF 経由（main thread fallback）→
 *             buildPdfDocument 内で生成された bboxMeta を「再読込相当」として
 *             loadPage に渡したとき、block の text/bbox/writingMode が一致すること
 *  - S-03-02: 縦書きブロックの保存 → 再読込で writingMode='vertical' と縦長 bbox が保持
 *  - S-03-03: backup JSON 経由のラウンドトリップ:
 *             setPendingRestoration() → setDocument() で復元データが反映されること
 *
 * 注意: pdf-lib / Worker / 実 PDF は完全モックで検証する。実 PDF への書き戻しは
 *       integration.test.ts I-06 で別途検証済み（drawText の呼出回数）。本テストは
 *       「メタデータの整合性 = ラウンドトリップでブロックが復元される」点に集中する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────
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
  // 保存時に書き込まれた PecoToolBBoxes JSON を捕捉する
  capturedBBoxJson: { value: null as string | null },
  infoDictSet: vi.fn(),
  translateFn: vi.fn((...args: any[]) => ({ type: 'translate', args })),
  scaleFn:     vi.fn((...args: any[]) => ({ type: 'scale', args })),
  pushGsFn:    vi.fn(() => ({ type: 'pushGs' })),
  popGsFn:     vi.fn(() => ({ type: 'popGs' })),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.pdfjsGetDocument,
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
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
  PDFHexString: {
    of: vi.fn((s: string) => s),
    // buildPdfDocument は PDFHexString.fromText(JSON.stringify(bboxMeta)) で書き込む。
    // テスト側で JSON を捕捉するためにここで横取りする。
    fromText: vi.fn((s: string) => {
      m.capturedBBoxJson.value = s
      return s
    }),
  },
  StandardFonts:     { Helvetica: 'Helvetica' },
  pushGraphicsState: m.pushGsFn,
  popGraphicsState:  m.popGsFn,
  translate:         m.translateFn,
  scale:             m.scaleFn,
  // buildPdfDocument の `instanceof PDFArray / PDFRawStream / PDFName` チェックが
  // false に評価されるよう、最低限のクラス stub を提供する。
  PDFArray:          class PDFArray { asArray() { return [] } },
  PDFRawStream:      class PDFRawStream {},
  PDFDict:           class PDFDict {},
  PDFRef:            class PDFRef {},
  PDFObject:         class PDFObject {},
}))

vi.mock('@pdf-lib/fontkit', () => ({ default: {} }))

import { savePDF, __setSaveWorkerFactoryForTest, __resetSaveStateForTest } from '../../utils/pdfSaver'
import { loadPage, getSharedPdfProxy, destroySharedPdfProxy } from '../../utils/pdfLoader'
import { usePecoStore } from '../../store/pecoStore'
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types'

// ── Helpers ───────────────────────────────────────────────────
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

function makePage(blocks: TextBlock[], pageIndex = 0, isDirty = true): PageData {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty,
    thumbnail: null,
  }
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  }
}

/**
 * savePDF が main thread fallback で動作するよう pdf-lib モックをセットアップ。
 * 編集後の textBlocks 数だけ drawText が呼ばれるシナリオを期待する。
 */
function setupPdfLibMock() {
  __setSaveWorkerFactoryForTest(() => null)
  __resetSaveStateForTest()
  m.capturedBBoxJson.value = null

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
  }))

  m.translateFn.mockImplementation((...args: any[]) => ({ type: 'translate', args }))
  m.scaleFn.mockImplementation((...args: any[]) => ({ type: 'scale', args }))

  const mockPage = {
    drawText:      m.drawText,
    drawImage:     m.drawImage,
    pushOperators: m.pushOperators,
    node: {
      Contents: vi.fn().mockReturnValue(null),
      set:      vi.fn(),
    },
    getWidth: () => 595,
    getHeight: () => 842,
    getSize: () => ({ width: 595, height: 842 }),
  }

  const mockInfoDict = {
    get: vi.fn().mockReturnValue(undefined), // 既存 PecoToolBBoxes 無し
    set: m.infoDictSet,
    lookup: vi.fn(),
  }

  const mockPdfDoc = {
    registerFontkit: m.registerFontkit,
    embedFont:       m.embedFont,
    removePage:      m.removePage,
    insertPage:      m.insertPage,
    getPage:         vi.fn().mockReturnValue(mockPage),
    embedJpg:        m.embedJpg,
    save:            m.save,
    context: { lookup: vi.fn() },
    getInfoDict: vi.fn().mockReturnValue(mockInfoDict),
  }
  m.embedFont.mockResolvedValue({
    widthOfTextAtSize: vi.fn().mockReturnValue(10),
    heightAtSize: vi.fn().mockReturnValue(1.448),
  })
  m.insertPage.mockReturnValue(mockPage)
  m.embedJpg.mockResolvedValue({ width: 1, height: 1 })
  m.save.mockResolvedValue(new Uint8Array(10))
  m.pdfLoad.mockResolvedValue(mockPdfDoc)
}

/** loadPage 検証用: textItems を空にして bboxMeta 経由のブロック復元のみを観察 */
async function setupReloadPdfMock(viewportWidth = 595, viewportHeight = 842) {
  destroySharedPdfProxy()
  const mockPdf = {
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({
        width: viewportWidth,
        height: viewportHeight,
        convertToViewportPoint: (x: number, y: number) => [x, viewportHeight - y],
      }),
      // bboxMeta が優先されるが、textByOrder マッピング用に空 items を返す
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    }),
  }
  m.pdfjsGetDocument.mockReturnValue({ promise: Promise.resolve(mockPdf) })
  // shared proxy を予熱（loadPage が呼ぶ getCachedPageProxy がインクリメントしないように）
  await getSharedPdfProxy('test.pdf')
  return mockPdf
}

// ── beforeEach ────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks()
  destroySharedPdfProxy()
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pendingRestoration: null,
  } as any)
})

// ── S-03-01 ────────────────────────────────────────────────────
describe('S-03-01: 複数ページ編集 → savePDF → 再読込で id/text/bbox/writingMode 一致', () => {
  it('2ページに各 1 ブロック編集 → 保存メタデータから loadPage で復元される', async () => {
    setupPdfLibMock()

    const blockP0 = makeBlock({
      id: 'p0-b1',
      text: 'ページ0テキスト',
      bbox: { x: 50, y: 100, width: 200, height: 24 },
      writingMode: 'horizontal',
      order: 0,
      isDirty: true,
    })
    const blockP1 = makeBlock({
      id: 'p1-b1',
      text: 'ページ1テキスト',
      bbox: { x: 80, y: 300, width: 180, height: 24 },
      writingMode: 'horizontal',
      order: 0,
      isDirty: true,
    })

    const doc = makeDoc(new Map([
      [0, makePage([blockP0], 0, true)],
      [1, makePage([blockP1], 1, true)],
    ]))

    // savePDF 実行（PDFHexString.fromText で JSON が m.capturedBBoxJson に格納される）
    await savePDF(new Uint8Array(10), doc)

    expect(m.capturedBBoxJson.value).not.toBeNull()
    const bboxMeta = JSON.parse(m.capturedBBoxJson.value!)
    expect(bboxMeta['0']).toHaveLength(1)
    expect(bboxMeta['1']).toHaveLength(1)
    expect(bboxMeta['0'][0].text).toBe('ページ0テキスト')
    expect(bboxMeta['1'][0].text).toBe('ページ1テキスト')

    // 「再読込相当」: 新規 doc を読み込み + 保存 bboxMeta を渡して loadPage する
    await setupReloadPdfMock()

    const reloadedP0 = await loadPage({} as any, 0, 'test.pdf', bboxMeta)
    const reloadedP1 = await loadPage({} as any, 1, 'test.pdf', bboxMeta)

    // 再読込後は新 id（crypto.randomUUID）が割り当てられるが、text/bbox/writingMode/order は保持
    expect(reloadedP0.textBlocks).toHaveLength(1)
    expect(reloadedP0.textBlocks[0].text).toBe('ページ0テキスト')
    expect(reloadedP0.textBlocks[0].bbox).toEqual({ x: 50, y: 100, width: 200, height: 24 })
    expect(reloadedP0.textBlocks[0].writingMode).toBe('horizontal')
    expect(reloadedP0.textBlocks[0].order).toBe(0)

    expect(reloadedP1.textBlocks).toHaveLength(1)
    expect(reloadedP1.textBlocks[0].text).toBe('ページ1テキスト')
    expect(reloadedP1.textBlocks[0].bbox).toEqual({ x: 80, y: 300, width: 180, height: 24 })
    expect(reloadedP1.textBlocks[0].writingMode).toBe('horizontal')
  })
})

// ── S-03-02 ────────────────────────────────────────────────────
describe('S-03-02: 縦書きブロック編集 → 保存 → 再読込で writingMode と 縦長 bbox 保持', () => {
  it('vertical block の bbox.height > bbox.width が再読込後も維持される', async () => {
    setupPdfLibMock()

    const verticalBlock = makeBlock({
      id: 'v-1',
      text: '縦書きテキスト',
      writingMode: 'vertical' as WritingMode,
      bbox: { x: 500, y: 200, width: 24, height: 200 },
      order: 0,
      isDirty: true,
    })
    const doc = makeDoc(new Map([[0, makePage([verticalBlock], 0, true)]]))

    await savePDF(new Uint8Array(10), doc)
    expect(m.capturedBBoxJson.value).not.toBeNull()
    const bboxMeta = JSON.parse(m.capturedBBoxJson.value!)

    await setupReloadPdfMock()
    const reloaded = await loadPage({} as any, 0, 'test.pdf', bboxMeta)

    expect(reloaded.textBlocks).toHaveLength(1)
    const block = reloaded.textBlocks[0]
    expect(block.writingMode).toBe('vertical')
    expect(block.bbox.height).toBeGreaterThan(block.bbox.width)
    expect(block.bbox).toEqual({ x: 500, y: 200, width: 24, height: 200 })
    expect(block.text).toBe('縦書きテキスト')
  })
})

// ── S-03-03 ────────────────────────────────────────────────────
describe('S-03-03: backup JSON ラウンドトリップ (setPendingRestoration → setDocument)', () => {
  it('pendingRestoration を経由した setDocument で IDB 復元＋ isDirty=true が反映される', async () => {
    // 編集前のオリジナル document
    const originalBlock = makeBlock({ id: 'orig-1', text: 'original', isDirty: false })
    const baseDoc = makeDoc(new Map([[0, makePage([originalBlock], 0, false)]]))

    // 「バックアップから復元したいページ」（保存前の編集スナップショット）
    const editedBlock = makeBlock({
      id: 'edited-1',
      text: 'edited via backup',
      bbox: { x: 10, y: 20, width: 100, height: 30 },
      writingMode: 'horizontal',
      isDirty: true,
    })
    const restoration = {
      '0': {
        pageIndex: 0,
        width: 595,
        height: 842,
        textBlocks: [editedBlock],
        isDirty: true,
        thumbnail: null,
      },
    }

    usePecoStore.getState().setPendingRestoration(restoration as any)
    expect(usePecoStore.getState().pendingRestoration).toBe(restoration)

    // setDocument を呼ぶと pendingRestoration がクリアされ、isDirty=true で確定する
    usePecoStore.getState().setDocument(baseDoc)

    const state = usePecoStore.getState()
    expect(state.pendingRestoration).toBeNull()
    expect(state.isDirty).toBe(true) // 復元データがある場合は即 dirty
    expect(state.document).toBe(baseDoc)
    expect(state.undoStack).toEqual([])
    expect(state.redoStack).toEqual([])
    expect(state.selectedIds.size).toBe(0)
  })

  it('pendingRestoration なしでの setDocument は isDirty=false に正規化される', () => {
    const block = makeBlock({ id: 'b-1', text: 'plain', isDirty: false })
    const doc = makeDoc(new Map([[0, makePage([block], 0, false)]]))

    usePecoStore.getState().setDocument(doc)
    const state = usePecoStore.getState()
    expect(state.isDirty).toBe(false)
    expect(state.pendingRestoration).toBeNull()
  })
})
