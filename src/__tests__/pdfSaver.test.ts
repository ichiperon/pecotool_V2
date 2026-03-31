import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../types'

// ── hoisted mocks ──────────────────────────────────────────────
const m = vi.hoisted(() => ({
  drawText:        vi.fn(),
  drawImage:       vi.fn(),
  removePage:      vi.fn(),
  insertPage:      vi.fn(),
  embedJpg:        vi.fn(),
  save:            vi.fn(),
  embedFont:       vi.fn(),
  registerFontkit: vi.fn(),
  pdfLoad:         vi.fn(),
  pdfjsGetDocument: vi.fn(),
}))

vi.mock('pdf-lib', () => ({
  PDFDocument: { load: m.pdfLoad },
  degrees: (n: number) => ({ type: 'degrees', angle: n }),
}))

vi.mock('@pdf-lib/fontkit', () => ({ default: {} }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: m.pdfjsGetDocument,
}))

import { savePDF } from '../utils/pdfSaver'

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

// viewport1x: scale=1.0 → height=842*1=842
const PAGE_HEIGHT = 842

// ── setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // pdf-lib mock chain
  const mockPage = { drawImage: m.drawImage, drawText: m.drawText }
  m.insertPage.mockReturnValue(mockPage)
  m.embedJpg.mockResolvedValue({})
  m.save.mockResolvedValue(new Uint8Array([1, 2, 3]))
  m.embedFont.mockResolvedValue({ type: 'mock-font' })
  m.pdfLoad.mockResolvedValue({
    registerFontkit: m.registerFontkit,
    embedFont:       m.embedFont,
    removePage:      m.removePage,
    insertPage:      m.insertPage,
    embedJpg:        m.embedJpg,
    save:            m.save,
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
})

// ── テスト ────────────────────────────────────────────────────

describe('pdfSaver / savePDF', () => {

  describe('U-S-01: 横書きブロックの Y 座標', () => {
    it('y = viewport.height - bbox.y - bbox.height * 0.85（ベースライン補正あり）', async () => {
      const doc = makeDoc([{
        writingMode: 'horizontal',
        bbox: { x: 10, y: 100, width: 200, height: 20 },
      }])
      await savePDF(new Uint8Array(), doc)

      const opts = m.drawText.mock.calls[0][1]
      // 842 - 100 - 20 * 0.85 = 842 - 100 - 17 = 725
      expect(opts.y).toBeCloseTo(PAGE_HEIGHT - 100 - 20 * 0.85, 5)
    })
  })

  describe('U-S-02: 縦書きブロックの Y 座標', () => {
    it('y = viewport.height - bbox.y', async () => {
      const doc = makeDoc([{
        writingMode: 'vertical',
        bbox: { x: 10, y: 100, width: 15, height: 200 },
      }])
      await savePDF(new Uint8Array(), doc)

      const opts = m.drawText.mock.calls[0][1]
      expect(opts.y).toBe(PAGE_HEIGHT - 100) // 742
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
    it('size = bbox.width', async () => {
      const doc = makeDoc([{
        writingMode: 'vertical',
        bbox: { x: 10, y: 100, width: 15, height: 200 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText.mock.calls[0][1].size).toBe(15)
    })
  })

  describe('U-S-05: 横書きブロックのフォントサイズ', () => {
    it('size = bbox.height', async () => {
      const doc = makeDoc([{
        writingMode: 'horizontal',
        bbox: { x: 10, y: 100, width: 200, height: 20 },
      }])
      await savePDF(new Uint8Array(), doc)

      expect(m.drawText.mock.calls[0][1].size).toBe(20)
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
        'Skipping text block due to encoding error:',
        '壊れたテキスト',
        expect.any(Error),
      )
      // 2件ともdrawText が呼ばれる（1件目は例外で落ちた後もループ継続）
      expect(m.drawText).toHaveBeenCalledTimes(2)

      warnSpy.mockRestore()
    })
  })

})
