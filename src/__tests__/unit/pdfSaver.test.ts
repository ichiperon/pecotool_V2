import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => ({
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
}))

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument:      { load: m.pdfLoad },
  degrees:          (n: number) => ({ type: 'degrees', angle: n }),
  PDFName:          { of: vi.fn((s: string) => s) },
  PDFString:        { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  PDFHexString:     { of: vi.fn((s: string) => s), fromText: vi.fn((s: string) => s) },
  StandardFonts:    { Helvetica: 'Helvetica' },
  pushGraphicsState: m.pushGsFn,
  popGraphicsState:  m.popGsFn,
  translate:         m.translateFn,
  scale:             m.scaleFn,
}))

vi.mock('@pdf-lib/fontkit', () => ({ default: {} }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.pdfjsGetDocument,
}))

import { savePDF } from '../../utils/pdfSaver'

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

  // pdf-lib mock chain
  const mockPage = {
    drawImage:    m.drawImage,
    drawText:     m.drawText,
    pushOperators: m.pushOperators,
    node: { normalizedEntries: () => ({ Contents: undefined }) },
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

})
