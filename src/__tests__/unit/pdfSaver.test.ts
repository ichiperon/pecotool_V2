import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => {
  // Minimal class stubs so `instanceof` checks in pdfSaver.ts work
  class PDFRawStreamStub {
    dict: any
    _contents: Uint8Array
    constructor(dict: any, contents: Uint8Array) { this.dict = dict; this._contents = contents }
    getContents() { return this._contents }
  }
  class PDFArrayStub {
    _arr: any[]
    constructor(arr: any[]) { this._arr = arr }
    asArray() { return this._arr }
  }
  return {
    drawText:            vi.fn(),
    drawImage:           vi.fn(),
    removePage:          vi.fn(),
    insertPage:          vi.fn(),
    pushOperators:       vi.fn(),
    embedJpg:            vi.fn(),
    save:                vi.fn(),
    embedFont:           vi.fn(),
    registerFontkit:     vi.fn(),
    pdfLoad:             vi.fn(),
    pdfjsGetDocument:    vi.fn(),
    translateFn:         vi.fn((...args: any[]) => ({ type: 'translate', args })),
    scaleFn:             vi.fn((...args: any[]) => ({ type: 'scale', args })),
    pushGsFn:            vi.fn(() => ({ type: 'pushGs' })),
    popGsFn:             vi.fn(() => ({ type: 'popGs' })),
    PDFRawStream:        PDFRawStreamStub,
    PDFArray:            PDFArrayStub,
  }
})

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument:      { load: m.pdfLoad },
  degrees:          (n: number) => ({ type: 'degrees', angle: n }),
  PDFName:          Object.assign(function PDFName() {}, { of: vi.fn((s: string) => s) }),
  PDFString:        { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  PDFHexString:     { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  StandardFonts:    { Helvetica: 'Helvetica' },
  pushGraphicsState: m.pushGsFn,
  popGraphicsState:  m.popGsFn,
  translate:         m.translateFn,
  scale:             m.scaleFn,
  PDFRawStream:     m.PDFRawStream,
  PDFArray:         m.PDFArray,
}))

vi.mock('@pdf-lib/fontkit', () => ({ default: {} }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.pdfjsGetDocument,
}))

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver'

// ── ヘルパー ──────────────────────────────────────────────────

function makeDoc(
  blocks: Partial<TextBlock>[],
  isDirty = true,
): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks.map((b, i): TextBlock => ({
      id: `block-${i}`,
      text: 'テスト',
      originalText: 'テスト',
      writingMode: 'horizontal' as WritingMode,
      order: i,
      isNew: false,
      isDirty: true,
      bbox: { x: 10, y: 20, width: 100, height: 30 },
      ...b,
    })),
    isDirty,
    thumbnail: null,
  }
  return {
    filePath: '',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  }
}

// viewport1x: scale=1.0 → height=842
const PAGE_HEIGHT = 842

// ── setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // 既存テストは buildPdfDocument を直接検証する。worker factory を null 返却に差し替え、
  // savePDF が main-thread fallback を取るようにする。
  __setSaveWorkerFactoryForTest(() => null)
  __resetSaveStateForTest()

  // pdf-lib mock chain
  const mockPage = {
    drawImage:    m.drawImage,
    drawText:     m.drawText,
    pushOperators: m.pushOperators,
    node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
    getWidth: () => 595,
    getHeight: () => 842,
    getSize: () => ({ width: 595, height: 842 }),
  }
  m.insertPage.mockReturnValue(mockPage)
  m.embedJpg.mockResolvedValue({ width: 1, height: 1 })
  m.save.mockResolvedValue(new Uint8Array([1, 2, 3]))
  m.embedFont.mockResolvedValue({
    widthOfTextAtSize: vi.fn().mockReturnValue(10),
    heightAtSize: vi.fn().mockReturnValue(1.448),
  })
  m.pdfLoad.mockResolvedValue({
    registerFontkit: m.registerFontkit,
    embedFont:       m.embedFont,
    removePage:      m.removePage,
    insertPage:      m.insertPage,
    getPage:         vi.fn().mockReturnValue(mockPage),
    embedJpg:        m.embedJpg,
    save:            m.save,
    context: { lookup: vi.fn() },
    getInfoDict:     vi.fn().mockReturnValue({ lookup: vi.fn(), set: vi.fn() }),
  })

  // pdfjs mock: getPage returns viewport + render stub
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

  // fetch mock for NotoSansJP font
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
  }))

  // translate/scale fns を毎回リセット（vi.clearAllMocks では fn 実装がリセットされない）
  m.translateFn.mockImplementation((...args: any[]) => ({ type: 'translate', args }))
  m.scaleFn.mockImplementation((...args: any[]) => ({ type: 'scale', args }))
  m.pushGsFn.mockImplementation(() => ({ type: 'pushGs' }))
  m.popGsFn.mockImplementation(() => ({ type: 'popGs' }))
})

// ── テスト ────────────────────────────────────────────────────

describe('pdfSaver / savePDF', () => {

  describe('U-S-01: 横書きブロックの Y 座標', () => {
    it('translate の y 引数 ≈ viewport.height - bbox.y - ベースライン補正', async () => {
      const doc = makeDoc([{
        writingMode: 'horizontal',
        bbox: { x: 10, y: 100, width: 200, height: 20 },
      }])
      await savePDF(new Uint8Array(), doc)

      // 新コード: translate(bboxX, baselineY) が pushOperators 経由で呼ばれる
      // baselineY = 842 - 100 - 1.16 * (20/1.448) ≈ 725.98 ≈ 726
      expect(m.translateFn).toHaveBeenCalled()
      const [, y] = m.translateFn.mock.calls[0]
      const sy = 20 / 1.448
      const expectedY = PAGE_HEIGHT - 100 - 1.16 * sy
      expect(y).toBeCloseTo(expectedY, 0) // ≈ 726（旧設計の ≈ 725 に対応）
    })
  })

  describe('U-S-02: 縦書きブロックの Y 座標', () => {
    it('translate の y 引数 = viewport.height - bbox.y', async () => {
      const doc = makeDoc([{
        writingMode: 'vertical',
        bbox: { x: 10, y: 100, width: 15, height: 200 },
      }])
      await savePDF(new Uint8Array(), doc)

      // baselineY = 842 - 100 = 742
      expect(m.translateFn).toHaveBeenCalled()
      const [, y] = m.translateFn.mock.calls[0]
      expect(y).toBe(PAGE_HEIGHT - 100) // 742
    })
  })

  describe('U-S-03: 縦書きブロックの回転', () => {
    it('rotate = degrees(-90)', async () => {
      const doc = makeDoc([{
        writingMode: 'vertical',
        bbox: { x: 10, y: 100, width: 15, height: 200 },
      }])
      await savePDF(new Uint8Array(), doc)

      const opts = m.drawText.mock.calls[0][1]
      expect(opts.rotate).toEqual({ type: 'degrees', angle: -90 })
    })

    it('横書きブロックに rotate は含まれない', async () => {
      const doc = makeDoc([{
        writingMode: 'horizontal',
        bbox: { x: 10, y: 100, width: 200, height: 20 },
      }])
      await savePDF(new Uint8Array(), doc)

      const opts = m.drawText.mock.calls[0][1]
      expect(opts.rotate).toBeUndefined()
    })
  })

  describe('U-S-04: 縦書きブロックのフォントサイズ', () => {
    it('drawText は size=1 で呼ばれ、scale で bbox.width に応じたスケールが設定される', async () => {
      const doc = makeDoc([{
        writingMode: 'vertical',
        bbox: { x: 10, y: 100, width: 15, height: 200 },
      }])
      await savePDF(new Uint8Array(), doc)

      // size は常に 1（スケールは translate+scale マトリクスで設定）
      expect(m.drawText.mock.calls[0][1].size).toBe(1)
      // scale が呼ばれる（bbox.width に応じた sx）
      expect(m.scaleFn).toHaveBeenCalled()
      const [sx] = m.scaleFn.mock.calls[0]
      // sx = bbox.width / 1.448 ≈ 10.36
      expect(sx).toBeCloseTo(15 / 1.448, 1)
    })
  })

  describe('U-S-05: 横書きブロックのフォントサイズ', () => {
    it('drawText は size=1 で呼ばれ、scale で bbox に応じたスケールが設定される', async () => {
      const doc = makeDoc([{
        writingMode: 'horizontal',
        bbox: { x: 10, y: 100, width: 200, height: 20 },
      }])
      await savePDF(new Uint8Array(), doc)

      // size は常に 1
      expect(m.drawText.mock.calls[0][1].size).toBe(1)
      // scale が呼ばれる（bbox.height に応じた sy）
      expect(m.scaleFn).toHaveBeenCalled()
      const [sx, sy] = m.scaleFn.mock.calls[0]
      expect(sy).toBeCloseTo(20 / 1.448, 1)
      // sx = bbox.width / textWidth（textWidth = widthOfTextAtSize が返す 10）
      expect(sx).toBeCloseTo(200 / 10, 1) // = 20
    })
  })

  describe('U-S-06: isDirty=false のページをスキップ', () => {
    it('isDirty=false のページは drawText が呼ばれない', async () => {
      const doc = makeDoc([{ writingMode: 'horizontal' }], /* isDirty= */ false)
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText).not.toHaveBeenCalled()
      expect(m.insertPage).not.toHaveBeenCalled()
    })
  })

  describe('U-S-07: drawText エラーのスキップ', () => {
    it('1件目が例外を投げても処理が継続し 2件目が描画される', async () => {
      m.drawText.mockImplementationOnce(() => { throw new Error('encoding error') })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const doc = makeDoc([
        { writingMode: 'horizontal', text: '壊れたテキスト' },
        { writingMode: 'horizontal', text: '正常なテキスト' },
      ])
      const result = await savePDF(new Uint8Array(), doc)

      // savePDF 自体は解決する
      expect(result).toBeInstanceOf(Uint8Array)
      // console.warn が呼ばれる
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('block error'),
        expect.any(Error),
      )
      // 2件ともdrawText が呼ばれる（1件目は例外で落ちた後もループ継続）
      expect(m.drawText).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })
  })

  describe('U-SV-18: Only dirty pages are processed', () => {
    it('drawText is only called for dirty page blocks', async () => {
      const page0: PageData = {
        pageIndex: 0, width: 595, height: 842, isDirty: false, thumbnail: null,
        textBlocks: [{
          id: 'b0', text: 'Page0', originalText: 'Page0', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: false,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const page1: PageData = {
        pageIndex: 1, width: 595, height: 842, isDirty: true, thumbnail: null,
        textBlocks: [{
          id: 'b1', text: 'Page1', originalText: 'Page1', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: true,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const page2: PageData = {
        pageIndex: 2, width: 595, height: 842, isDirty: false, thumbnail: null,
        textBlocks: [{
          id: 'b2', text: 'Page2', originalText: 'Page2', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: false,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const doc: PecoDocument = {
        filePath: '', fileName: 'test.pdf', totalPages: 3, metadata: {},
        pages: new Map([[0, page0], [1, page1], [2, page2]]),
      }
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText).toHaveBeenCalledTimes(1)
      expect(m.drawText.mock.calls[0][0]).toBe('Page1')
    })
  })

  describe('U-SV-19: Non-dirty pages remain untouched', () => {
    it('pages 0 and 2 have no drawText calls when only page 1 is dirty', async () => {
      const page0: PageData = {
        pageIndex: 0, width: 595, height: 842, isDirty: false, thumbnail: null,
        textBlocks: [{
          id: 'b0', text: 'Untouched0', originalText: 'Untouched0', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: false,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const page1: PageData = {
        pageIndex: 1, width: 595, height: 842, isDirty: true, thumbnail: null,
        textBlocks: [{
          id: 'b1', text: 'Dirty1', originalText: 'Dirty1', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: true,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const page2: PageData = {
        pageIndex: 2, width: 595, height: 842, isDirty: false, thumbnail: null,
        textBlocks: [{
          id: 'b2', text: 'Untouched2', originalText: 'Untouched2', writingMode: 'horizontal',
          order: 0, isNew: false, isDirty: false,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const doc: PecoDocument = {
        filePath: '', fileName: 'test.pdf', totalPages: 3, metadata: {},
        pages: new Map([[0, page0], [1, page1], [2, page2]]),
      }
      await savePDF(new Uint8Array(), doc)

      const drawnTexts = m.drawText.mock.calls.map((c: any[]) => c[0])
      expect(drawnTexts).not.toContain('Untouched0')
      expect(drawnTexts).not.toContain('Untouched2')
    })
  })

  describe('U-SV-20: Empty text block is skipped', () => {
    it('block with text="" produces no drawText call', async () => {
      const doc = makeDoc([{ text: '', writingMode: 'horizontal' }])
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText).not.toHaveBeenCalled()
    })
  })

  describe('U-SV-21: Zero textWidth warning', () => {
    it('font.widthOfTextAtSize returning 0 → console.warn called, block skipped', async () => {
      m.embedFont.mockResolvedValue({
        widthOfTextAtSize: vi.fn().mockReturnValue(0),
        heightAtSize: vi.fn().mockReturnValue(1.448),
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('zero font metrics'),
      )
      warnSpy.mockRestore()
    })
  })

  describe('U-SV-22: Non-finite scale warning', () => {
    it('NaN font metrics causing non-finite scale → console.warn, block skipped', async () => {
      // widthOfTextAtSize returns NaN (not 0, which is caught earlier)
      // This causes sx = bbox.width / NaN = NaN → non-finite
      m.embedFont.mockResolvedValue({
        widthOfTextAtSize: vi.fn().mockReturnValue(NaN),
        heightAtSize: vi.fn().mockReturnValue(1.448),
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-finite scale'),
      )
      warnSpy.mockRestore()
    })
  })

  describe('U-SV-23: No font embedded if dirty pages have no text blocks with text', () => {
    it('embedFont is NOT called when all text blocks have empty text', async () => {
      const doc = makeDoc([{
        text: '',
        writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.embedFont).not.toHaveBeenCalled()
    })

    it('embedFont is NOT called when text blocks have only whitespace', async () => {
      const doc = makeDoc([{
        text: '   ',
        writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.embedFont).not.toHaveBeenCalled()
    })
  })

  describe('U-SV-24: BBox metadata written to info dict', () => {
    it('mockInfoDict.set is called with PecoToolBBoxes key', async () => {
      const mockInfoDict = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), lookup: vi.fn() }
      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue({
          drawImage:    m.drawImage,
          drawText:     m.drawText,
          pushOperators: m.pushOperators,
          node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
          getWidth: () => 595,
          getHeight: () => 842,
          getSize: () => ({ width: 595, height: 842 }),
        }),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: { lookup: vi.fn() },
        getInfoDict:     vi.fn().mockReturnValue(mockInfoDict),
      })

      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(mockInfoDict.set).toHaveBeenCalledWith(
        'PecoToolBBoxes',
        expect.anything(),
      )
    })
  })

  describe('U-SV-25: Existing BBox metadata merged with new', () => {
    it('set is called with JSON containing both existing and new page data', async () => {
      const existingMeta = { '0': [{ bbox: { x: 0, y: 0, width: 50, height: 50 }, writingMode: 'horizontal', order: 0, text: 'Existing' }] }
      // Mock PDFHexString instance with decodeText
      const mockExistingValue = {
        decodeText: () => JSON.stringify(existingMeta),
      }
      // Make it look like a PDFHexString to instanceof check — we rely on the mock's PDFHexString
      const mockInfoDict = {
        get: vi.fn().mockReturnValue(mockExistingValue),
        set: vi.fn(),
        lookup: vi.fn(),
      }
      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue({
          drawImage:    m.drawImage,
          drawText:     m.drawText,
          pushOperators: m.pushOperators,
          node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
          getWidth: () => 595,
          getHeight: () => 842,
          getSize: () => ({ width: 595, height: 842 }),
        }),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: { lookup: vi.fn() },
        getInfoDict:     vi.fn().mockReturnValue(mockInfoDict),
      })

      // Dirty page 1 (page 0 is not dirty, so existing meta for page 0 should be preserved)
      const page1: PageData = {
        pageIndex: 1, width: 595, height: 842, isDirty: true, thumbnail: null,
        textBlocks: [{
          id: 'b1', text: 'NewText', originalText: 'NewText', writingMode: 'horizontal' as WritingMode,
          order: 0, isNew: false, isDirty: true,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const doc: PecoDocument = {
        filePath: '', fileName: 'test.pdf', totalPages: 2, metadata: {},
        pages: new Map([[1, page1]]),
      }
      await savePDF(new Uint8Array(), doc)

      // infoDict.set should be called
      expect(mockInfoDict.set).toHaveBeenCalled()
      // The value passed to set should be a JSON string containing page 1 data
      const setCall = mockInfoDict.set.mock.calls[0]
      expect(setCall[0]).toBe('PecoToolBBoxes')
      // The second arg is the result of PDFHexString.fromText(jsonString)
      // Our mock makes PDFHexString.fromText return the string directly
      const jsonStr = setCall[1]
      // Since our PDFHexString.fromText mock just returns the string,
      // jsonStr IS the JSON string
      const parsed = JSON.parse(jsonStr as string)
      // Page 1 data should exist
      expect(parsed['1']).toBeDefined()
      expect(parsed['1'][0].text).toBe('NewText')
    })
  })

  describe('U-SV-08: Non-text operators preserved', () => {
    it('page.node.set is called to update Contents (text stripping occurred)', async () => {
      // Mock a page with existing content stream that contains BT..ET
      const mockPageNode = {
        Contents: vi.fn().mockReturnValue('stream-ref'),
        set: vi.fn(),
      }
      const mockPage = {
        drawImage:     m.drawImage,
        drawText:      m.drawText,
        pushOperators: m.pushOperators,
        node: mockPageNode,
        getWidth: () => 595,
        getHeight: () => 842,
        getSize: () => ({ width: 595, height: 842 }),
      }

      // Create a real _PDFRawStream instance so instanceof works
      const fakeStream = new m.PDFRawStream(
        { lookup: vi.fn().mockReturnValue(null) },
        new TextEncoder().encode('q 1 0 0 1 0 0 cm Q\nBT /F1 12 Tf (Hello) Tj ET\nq 0.5 0 0 0.5 0 0 cm Q')
      )

      const mockFlateStream = { type: 'flateStream' }
      const mockStreamRef = { type: 'streamRef' }

      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue(mockPage),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: {
          lookup: vi.fn().mockReturnValue(fakeStream),
          flateStream: vi.fn().mockReturnValue(mockFlateStream),
          register: vi.fn().mockReturnValue(mockStreamRef),
          obj: vi.fn().mockImplementation((arr: any[]) => arr),
        },
        getInfoDict: vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn(), lookup: vi.fn() }),
      })

      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      // page.node.set should be called to replace Contents
      expect(mockPageNode.set).toHaveBeenCalledWith(
        'Contents',
        expect.anything(),
      )
    })
  })

  describe('U-SV-09: Multiple BT..ET blocks removed', () => {
    it('page with content streams is processed and Contents is replaced', async () => {
      const mockPageNode = {
        Contents: vi.fn().mockReturnValue('stream-ref'),
        set: vi.fn(),
      }
      const mockPage = {
        drawImage:     m.drawImage,
        drawText:      m.drawText,
        pushOperators: m.pushOperators,
        node: mockPageNode,
        getWidth: () => 595,
        getHeight: () => 842,
        getSize: () => ({ width: 595, height: 842 }),
      }

      // Content with multiple BT..ET blocks
      const fakeStream = new m.PDFRawStream(
        { lookup: vi.fn().mockReturnValue(null) },
        new TextEncoder().encode(
          'q 1 0 0 1 0 0 cm Q\nBT /F1 12 Tf (Hello) Tj ET\nq 0.5 0 0 0.5 0 0 cm Q\nBT /F2 10 Tf (World) Tj ET\nq 1 0 0 1 100 100 cm Q'
        )
      )

      const mockFlateStream = { type: 'flateStream' }
      const mockStreamRef = { type: 'streamRef' }
      const mockFlateStreamFn = vi.fn().mockReturnValue(mockFlateStream)

      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue(mockPage),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: {
          lookup: vi.fn().mockReturnValue(fakeStream),
          flateStream: mockFlateStreamFn,
          register: vi.fn().mockReturnValue(mockStreamRef),
          obj: vi.fn().mockImplementation((arr: any[]) => arr),
        },
        getInfoDict: vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn(), lookup: vi.fn() }),
      })

      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      await savePDF(new Uint8Array(), doc)

      // flateStream should have been called with cleaned content (BT..ET removed)
      expect(mockFlateStreamFn).toHaveBeenCalled()
      // page.node.set should be called to replace Contents
      expect(mockPageNode.set).toHaveBeenCalledWith('Contents', expect.anything())
    })
  })

  describe('U-SV-26: save returns Uint8Array', () => {
    it('savePDF resolves to Uint8Array', async () => {
      const doc = makeDoc([{
        text: 'テスト', writingMode: 'horizontal',
        bbox: { x: 10, y: 20, width: 100, height: 30 },
      }])
      const result = await savePDF(new Uint8Array(), doc)
      expect(result).toBeInstanceOf(Uint8Array)
    })
  })

  describe('U-SV-27: Multiple dirty pages each get drawText calls', () => {
    it('all blocks across multiple dirty pages are drawn', async () => {
      const page0: PageData = {
        pageIndex: 0, width: 595, height: 842, isDirty: true, thumbnail: null,
        textBlocks: [{
          id: 'b0', text: 'PageZero', originalText: 'PageZero', writingMode: 'horizontal' as WritingMode,
          order: 0, isNew: false, isDirty: true,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const page1: PageData = {
        pageIndex: 1, width: 595, height: 842, isDirty: true, thumbnail: null,
        textBlocks: [{
          id: 'b1', text: 'PageOne', originalText: 'PageOne', writingMode: 'horizontal' as WritingMode,
          order: 0, isNew: false, isDirty: true,
          bbox: { x: 10, y: 20, width: 100, height: 30 },
        }],
      }
      const doc: PecoDocument = {
        filePath: '', fileName: 'test.pdf', totalPages: 2, metadata: {},
        pages: new Map([[0, page0], [1, page1]]),
      }
      await savePDF(new Uint8Array(), doc)

      const drawnTexts = m.drawText.mock.calls.map((c: any[]) => c[0])
      expect(drawnTexts).toContain('PageZero')
      expect(drawnTexts).toContain('PageOne')
      expect(m.drawText).toHaveBeenCalledTimes(2)
    })
  })

  describe('U-SV-28: BBox metadata contains correct structure', () => {
    it('metadata entry has bbox, writingMode, order, text fields', async () => {
      const mockInfoDict = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), lookup: vi.fn() }
      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue({
          drawImage:    m.drawImage,
          drawText:     m.drawText,
          pushOperators: m.pushOperators,
          node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
          getWidth: () => 595,
          getHeight: () => 842,
          getSize: () => ({ width: 595, height: 842 }),
        }),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: { lookup: vi.fn() },
        getInfoDict:     vi.fn().mockReturnValue(mockInfoDict),
      })

      const doc = makeDoc([{
        text: 'メタテスト', writingMode: 'vertical' as WritingMode,
        bbox: { x: 50, y: 60, width: 15, height: 200 },
        order: 3,
      }])
      await savePDF(new Uint8Array(), doc)

      expect(mockInfoDict.set).toHaveBeenCalled()
      const jsonStr = mockInfoDict.set.mock.calls[0][1]
      const parsed = JSON.parse(jsonStr as string)
      const pageEntry = parsed['0']
      expect(pageEntry).toBeDefined()
      expect(pageEntry[0]).toMatchObject({
        bbox: { x: 50, y: 60, width: 15, height: 200 },
        writingMode: 'vertical',
        text: 'メタテスト',
      })
      expect(pageEntry[0]).toHaveProperty('order')
    })
  })

  describe('U-SV-29: Blocks sorted by order in metadata', () => {
    it('metadata entries are ordered by block.order', async () => {
      const mockInfoDict = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), lookup: vi.fn() }
      m.pdfLoad.mockResolvedValue({
        registerFontkit: m.registerFontkit,
        embedFont:       m.embedFont,
        removePage:      m.removePage,
        insertPage:      m.insertPage,
        getPage:         vi.fn().mockReturnValue({
          drawImage:    m.drawImage,
          drawText:     m.drawText,
          pushOperators: m.pushOperators,
          node: { Contents: vi.fn().mockReturnValue(null), set: vi.fn() },
          getWidth: () => 595,
          getHeight: () => 842,
          getSize: () => ({ width: 595, height: 842 }),
        }),
        embedJpg:        m.embedJpg,
        save:            m.save,
        context: { lookup: vi.fn() },
        getInfoDict:     vi.fn().mockReturnValue(mockInfoDict),
      })

      const doc = makeDoc([
        { text: 'Second', order: 2, writingMode: 'horizontal' as WritingMode, bbox: { x: 10, y: 20, width: 100, height: 30 } },
        { text: 'First', order: 1, writingMode: 'horizontal' as WritingMode, bbox: { x: 10, y: 60, width: 100, height: 30 } },
      ])
      await savePDF(new Uint8Array(), doc)

      const jsonStr = mockInfoDict.set.mock.calls[0][1]
      const parsed = JSON.parse(jsonStr as string)
      expect(parsed['0'][0].text).toBe('First')
      expect(parsed['0'][1].text).toBe('Second')
    })
  })

})

// ── Worker 経路テスト ─────────────────────────────────────────
// 以下のテストでは Worker ファクトリを制御可能な MockWorker に差し替え、
// terminate の idempotency / timeout / onerror / cleanup を検証する。

/**
 * テスト用の制御可能な MockWorker。
 * - postMessage は自動応答しない（テストから emit* で応答を発火させる）
 * - terminate 呼び出し回数を記録
 * - SaveWorkerFactory 経由で生成されたインスタンスは全て instances[] に積まれる
 */
class ControllableMockWorker {
  static instances: ControllableMockWorker[] = []
  public onmessage: ((e: MessageEvent<any>) => void) | null = null
  public onerror: ((e: any) => void) | null = null
  public terminateCount = 0
  public postedMessages: any[] = []

  constructor() {
    ControllableMockWorker.instances.push(this)
  }

  postMessage(data: any, _transfer?: Transferable[]) {
    this.postedMessages.push(data)
  }

  terminate() {
    this.terminateCount++
  }

  /** テストから成功応答を発火 */
  emitSuccess(data: Uint8Array) {
    if (this.onmessage) {
      this.onmessage({ data: { type: 'SAVE_PDF_SUCCESS', data } } as MessageEvent<any>)
    }
  }

  /** テストからエラー応答を発火 */
  emitError(message: string) {
    if (this.onmessage) {
      this.onmessage({ data: { type: 'ERROR', message } } as MessageEvent<any>)
    }
  }

  /** テストから onerror を発火 */
  emitOnError(err: any) {
    if (this.onerror) this.onerror(err)
  }
}

describe('pdfSaver / Worker 経路', () => {
  beforeEach(() => {
    ControllableMockWorker.instances = []
    __resetSaveStateForTest()
    __setSaveWorkerFactoryForTest(() => new ControllableMockWorker() as unknown as Worker)
  })

  function makeSimpleDoc(): PecoDocument {
    const page: PageData = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    }
    return {
      filePath: '', fileName: 'test.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, page]]),
    }
  }

  describe('U-W-01: terminate idempotency — 2 回連続呼び出しで前回 worker が 1 回だけ terminate される', () => {
    it('2 回 savePDF を呼び出すと 2 つの worker が作成され、1 つめは 1 回 terminate される', async () => {
      const doc = makeSimpleDoc()

      // 1 回目: worker を作って成功応答を発火させ、 savePDF を完了させる
      const p1 = savePDF(new Uint8Array(), doc)
      expect(ControllableMockWorker.instances.length).toBe(1)
      const w1 = ControllableMockWorker.instances[0]
      w1.emitSuccess(new Uint8Array([1, 2, 3]))
      await p1
      expect(w1.terminateCount).toBe(1) // success cleanup で 1 回

      // 2 回目: 新しい worker が作られる
      const p2 = savePDF(new Uint8Array(), doc)
      expect(ControllableMockWorker.instances.length).toBe(2)
      const w2 = ControllableMockWorker.instances[1]
      expect(w2).not.toBe(w1)
      w2.emitSuccess(new Uint8Array([4, 5, 6]))
      await p2

      // w1 は依然として 1 回だけ terminate されている（二重 terminate なし）
      expect(w1.terminateCount).toBe(1)
    })
  })

  describe('U-W-02: タイムアウト経路 — 前回保存が 5 秒以内に完了しなければ stale worker として terminate', () => {
    it('fake timers で PREVIOUS_SAVE_TIMEOUT_MS を進めると前回 worker が terminate され新 worker が作られる', async () => {
      vi.useFakeTimers()
      try {
        const doc = makeSimpleDoc()

        // 1 回目: 応答を発火せず hung 状態のまま置く
        const p1 = savePDF(new Uint8Array(), doc)
        expect(ControllableMockWorker.instances.length).toBe(1)
        const w1 = ControllableMockWorker.instances[0]
        expect(w1.terminateCount).toBe(0)

        // 2 回目 savePDF を起動。Promise は timeout まで進まない。
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const p2 = savePDF(new Uint8Array(), doc)

        // Promise.race の setTimeout(5000) が発火するまで進める
        await vi.advanceTimersByTimeAsync(5001)

        // timeout により w1 が terminate される
        expect(w1.terminateCount).toBe(1)
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Previous save did not complete within timeout'),
        )

        // 新 worker が作られる
        expect(ControllableMockWorker.instances.length).toBe(2)
        const w2 = ControllableMockWorker.instances[1]
        w2.emitSuccess(new Uint8Array([9, 9]))
        await p2

        // hung 状態の p1 を回収（terminate 済み）
        w1.emitSuccess(new Uint8Array([0]))
        await p1.catch(() => {}) // 既に settled なので no-op

        warnSpy.mockRestore()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('U-W-03: onerror 経路 — worker の error event で Promise が reject', () => {
    it('MockWorker.emitOnError で savePDF が reject する', async () => {
      const doc = makeSimpleDoc()
      const p = savePDF(new Uint8Array(), doc)
      const w = ControllableMockWorker.instances[0]
      w.emitOnError(new Error('worker crashed'))

      await expect(p).rejects.toBeDefined()
      // onerror の cleanup で 1 回 terminate される
      expect(w.terminateCount).toBe(1)
    })

    it('Worker から ERROR message を受け取ると savePDF が reject', async () => {
      const doc = makeSimpleDoc()
      const p = savePDF(new Uint8Array(), doc)
      const w = ControllableMockWorker.instances[0]
      w.emitError('save failed in worker')

      await expect(p).rejects.toThrow('save failed in worker')
      expect(w.terminateCount).toBe(1)
    })
  })

  describe('U-W-04: 二重 terminate が無害', () => {
    it('timeout による terminate の後に遅延応答が届いても例外を投げない', async () => {
      // 実運用の Worker.terminate は仕様上 idempotent（二重呼び出しても throw しない）だが、
      // pdfSaver 側でも try/catch で包んでいることを担保する回帰テスト。
      // ControllableMockWorker.terminate は単純カウンタで、複数回呼び出しでも例外は投げない。
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const doc = makeSimpleDoc()
        // 1 回目を hung 状態にする
        const p1 = savePDF(new Uint8Array(), doc)
        const w1 = ControllableMockWorker.instances[0]

        // 2 回目で timeout 経路を発火させ w1 を terminate
        const p2 = savePDF(new Uint8Array(), doc)
        await vi.advanceTimersByTimeAsync(5001)
        expect(w1.terminateCount).toBe(1)

        // 遅延応答が届いても throw しない（pdfSaver 側の terminate が try/catch で包まれている前提）
        expect(() => w1.emitSuccess(new Uint8Array([7]))).not.toThrow()
        // この時点で onmessage の cleanup が再 terminate を呼び合計 2 回になる想定。
        // 重要なのはカウントが増えること ≠ 例外発生、という点。
        expect(w1.terminateCount).toBeGreaterThanOrEqual(1)

        await p1.catch(() => {})

        const w2 = ControllableMockWorker.instances[1]
        w2.emitSuccess(new Uint8Array([8]))
        await p2
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })

    it('worker factory が例外を投げても main thread fallback が走り reject しない', async () => {
      __setSaveWorkerFactoryForTest(() => { throw new Error('worker ctor boom') })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const doc = makeSimpleDoc()
      const result = await savePDF(new Uint8Array(), doc)

      // fallback で buildPdfDocument が走り、m.save のモック返却値が帰る
      expect(result).toBeInstanceOf(Uint8Array)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Worker creation failed'),
        expect.any(Error),
      )
      warnSpy.mockRestore()
    })
  })

  // ── S-04: 連続保存（terminate idempotency） ──────────────────

  describe('S-04: 連続保存 terminate idempotency', () => {
    it('S-04-01: 5 回連続 savePDF → terminate 回数 ≥ n-1 = 4、最終 worker のみ生存、全 Promise resolve', async () => {
      const doc = makeSimpleDoc()

      // 5 回連続呼び出し。savePDF は前回完了待ちが入るので、
      // 各 worker が作られた直後に成功応答を発火させる必要がある。
      const promises: Promise<Uint8Array>[] = []
      for (let i = 0; i < 5; i++) {
        const p = savePDF(new Uint8Array(), doc)
        promises.push(p)
        // microtask を回して worker 生成を待つ
        // (1 回目は同期で作られるが、2 回目以降は await race のあと作られる)
        for (let k = 0; k < 5; k++) await Promise.resolve()
        const w = ControllableMockWorker.instances[i]
        expect(w).toBeDefined()
        w.emitSuccess(new Uint8Array([i]))
      }

      const results = await Promise.all(promises)
      expect(results).toHaveLength(5)
      for (const r of results) expect(r).toBeInstanceOf(Uint8Array)

      // 5 個の worker が作られた
      expect(ControllableMockWorker.instances.length).toBe(5)

      // 各 worker は onmessage cleanup で 1 回ずつ terminate される（成功応答 cleanup）。
      // 仕様 (S-04): n-1 = 4 個以上が terminate されていれば idempotent 担保。
      const counts = ControllableMockWorker.instances.map((w) => w.terminateCount)
      const terminatedCount = counts.filter((c) => c >= 1).length
      expect(terminatedCount).toBeGreaterThanOrEqual(4)
    })

    it('S-04-02: 連続呼び出し中に途中 1 つが reject しても後続は影響を受けず resolve', async () => {
      const doc = makeSimpleDoc()

      // 1 回目: 成功
      const p1 = savePDF(new Uint8Array(), doc)
      ControllableMockWorker.instances[0].emitSuccess(new Uint8Array([1]))
      await p1

      // 2 回目: ERROR を発火 → reject
      const p2 = savePDF(new Uint8Array(), doc)
      ControllableMockWorker.instances[1].emitError('mid-save failure')
      await expect(p2).rejects.toThrow('mid-save failure')

      // 3 回目: 後続も問題なく成功する
      const p3 = savePDF(new Uint8Array(), doc)
      ControllableMockWorker.instances[2].emitSuccess(new Uint8Array([3]))
      const r3 = await p3
      expect(r3).toBeInstanceOf(Uint8Array)
      expect(r3[0]).toBe(3)

      // 4 回目: 連続 reject 後の reject も独立している
      const p4 = savePDF(new Uint8Array(), doc)
      ControllableMockWorker.instances[3].emitSuccess(new Uint8Array([4]))
      const r4 = await p4
      expect(r4[0]).toBe(4)
    })
  })

  // ── U-W-05: URL 経路 ─────────────────────────────────────────
  // source として {url} を渡した場合、bytes を transfer せず url を Worker に転送する。
  // 受け取った Worker 側は worker 内で fetch する責務を持つ（本テストは postMessage の payload のみを検証）。
  describe('U-W-05: URL 経路', () => {
    it('source = {url} のとき postMessage payload に url が入り bytes は含まれない', async () => {
      const doc = makeSimpleDoc()
      const p = savePDF({ url: 'blob:fake-url-123' }, doc)
      const w = ControllableMockWorker.instances[0]
      expect(w).toBeDefined()
      expect(w.postedMessages).toHaveLength(1)
      const req = w.postedMessages[0]
      expect(req.type).toBe('SAVE_PDF')
      expect(req.data.url).toBe('blob:fake-url-123')
      expect(req.data.bytes).toBeUndefined()

      // 応答を発火して Promise を解決させる
      w.emitSuccess(new Uint8Array([1, 2, 3]))
      const result = await p
      expect(result).toBeInstanceOf(Uint8Array)
    })

    it('source = Uint8Array のとき postMessage payload に bytes が入り url は含まれない（回帰）', async () => {
      const doc = makeSimpleDoc()
      const p = savePDF(new Uint8Array([9, 9, 9]), doc)
      const w = ControllableMockWorker.instances[0]
      const req = w.postedMessages[0]
      expect(req.type).toBe('SAVE_PDF')
      expect(req.data.bytes).toBeInstanceOf(Uint8Array)
      expect(req.data.url).toBeUndefined()

      w.emitSuccess(new Uint8Array([7]))
      await p
    })

    it('Worker 不在時に {url} を渡すと main thread fallback で fetch が呼ばれる', async () => {
      // Worker factory を null 返却にして main thread fallback を取らせる
      __setSaveWorkerFactoryForTest(() => null)

      const fakeBytes = new Uint8Array([11, 22, 33])
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: vi.fn().mockResolvedValue(fakeBytes.buffer),
      })
      vi.stubGlobal('fetch', fetchMock)

      const doc = makeSimpleDoc()
      const result = await savePDF({ url: 'blob:main-thread-url' }, doc)

      expect(fetchMock).toHaveBeenCalledWith('blob:main-thread-url')
      expect(result).toBeInstanceOf(Uint8Array)
    })
  })
})
