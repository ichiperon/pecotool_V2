import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDocument } from 'pdfjs-dist'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

import { loadPage, destroySharedPdfProxy } from '../../utils/pdfLoader'

// ── ヘルパー ──────────────────────────────────────────────────

interface FakeItem {
  str: string
  transform: number[]
  width: number
  height: number
}

function makeMockPdf(
  items: FakeItem[],
  viewportWidth = 595,
  viewportHeight = 842,
) {
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

/** getDocument がこの pdf を返すようにセットアップ */
function setupGetDocument(pdf: ReturnType<typeof makeMockPdf>) {
  (getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
    promise: Promise.resolve(pdf),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  destroySharedPdfProxy() // globalSharedPdfProxy と pageProxyCache をリセット
})

// ── テスト ────────────────────────────────────────────────────

describe('pdfLoader / loadPage', () => {

  describe('U-L-01: 縦書き検出', () => {
    it('|transform[0]| < |transform[1]| → writingMode = vertical', async () => {
      const pdf = makeMockPdf([
        { str: 'あ', transform: [0, 1, -1, 0, 100, 700], width: 12, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].writingMode).toBe('vertical')
    })
  })

  describe('U-L-02: 横書き検出', () => {
    it('|transform[0]| >= |transform[1]| → writingMode = horizontal', async () => {
      const pdf = makeMockPdf([
        { str: 'A', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].writingMode).toBe('horizontal')
    })
  })

  describe('U-L-03: Y座標変換', () => {
    it('bbox.y = viewportHeight - transform[5] - thickness * 1.16', async () => {
      // viewport.height=800, transform[5]=700, height=20
      // 期待値: 800 - 700 - 20*1.16 = 76.8
      const pdf = makeMockPdf(
        [{ str: 'X', transform: [1, 0, 0, 20, 50, 700], width: 10, height: 20 }],
        595,
        800,
      )
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.y).toBeCloseTo(76.8, 1)
    })
  })

  describe('U-L-04: 幅フォールバック', () => {
    it('item.width=0 → bbox.width = mag × str.length × 0.6', async () => {
      // mag=12 (transform[0]=12), str="ABC"(3文字) → 12 * 3 * 0.6 = 21.6
      const pdf = makeMockPdf([
        { str: 'ABC', transform: [12, 0, 0, 12, 100, 700], width: 0, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.width).toBeCloseTo(21.6, 5)
    })
  })

  describe('U-L-05: 空文字フィルタリング', () => {
    it('空白のみの item は TextBlock に含まれない', async () => {
      const pdf = makeMockPdf([
        { str: '   ', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
        { str: 'Hello', transform: [1, 0, 0, 12, 200, 700], width: 30, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks).toHaveLength(1)
      expect(page.textBlocks[0].text).toBe('Hello')
    })

    it('全要素が空白のとき textBlocks が空になる', async () => {
      const pdf = makeMockPdf([
        { str: '\t', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks).toHaveLength(0)
    })
  })

  describe('U-L-06: height フォールバック', () => {
    it('item.height=0 → sqrt(tx[2]^2+tx[3]^2) が thickness となり bbox.height = thickness * 1.16', async () => {
      // thickness = sqrt(0 + 14^2) = 14, bbox.height = 14 * 1.16 = 16.24
      const pdf = makeMockPdf([
        { str: 'X', transform: [1, 0, 0, 14, 100, 700], width: 10, height: 0 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.height).toBeCloseTo(16.24, 1)
    })

    it('item.height=0 かつ transform[3]=0 → mag がフォールバックとして使われる', async () => {
      // mag=12 (transform[0]=12), thickness=12, bbox.height = 12 * 1.16 = 13.92
      const pdf = makeMockPdf([
        { str: 'X', transform: [12, 0, 0, 0, 100, 700], width: 10, height: 0 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.height).toBeCloseTo(13.92, 1)
    })
  })

})
