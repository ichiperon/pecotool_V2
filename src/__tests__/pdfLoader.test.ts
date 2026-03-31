import { describe, it, expect, vi } from 'vitest'

// pdfjs-dist をモック（module-level の GlobalWorkerOptions 代入をスタブ化）
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

// ?url インポートを空文字に差し替え
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

import { loadPage } from '../utils/pdfLoader'

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
      getViewport: vi.fn().mockReturnValue({ width: viewportWidth, height: viewportHeight }),
      getTextContent: vi.fn().mockResolvedValue({ items }),
    }),
  } as unknown as import('pdfjs-dist').PDFDocumentProxy
}

// ── テスト ────────────────────────────────────────────────────

describe('pdfLoader / loadPage', () => {

  describe('U-L-01: 縦書き検出', () => {
    it('|transform[0]| < |transform[1]| → writingMode = vertical', async () => {
      const pdf = makeMockPdf([
        { str: 'あ', transform: [0, 1, -1, 0, 100, 700], width: 12, height: 12 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].writingMode).toBe('vertical')
    })
  })

  describe('U-L-02: 横書き検出', () => {
    it('|transform[0]| >= |transform[1]| → writingMode = horizontal', async () => {
      const pdf = makeMockPdf([
        { str: 'A', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].writingMode).toBe('horizontal')
    })
  })

  describe('U-L-03: Y座標変換', () => {
    it('bbox.y = viewportHeight - transform[5] - height * 0.85', async () => {
      // viewport.height=800, transform[5]=700, height=20
      // 期待値: 800 - 700 - 20*0.85 = 83
      const pdf = makeMockPdf(
        [{ str: 'X', transform: [1, 0, 0, 20, 50, 700], width: 10, height: 20 }],
        595,
        800,
      )
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].bbox.y).toBeCloseTo(83, 5)
    })
  })

  describe('U-L-04: 幅フォールバック', () => {
    it('item.width=0 → bbox.width = height × str.length × 0.6', async () => {
      // height=12, str="ABC"(3文字) → 12 * 3 * 0.6 = 21.6
      const pdf = makeMockPdf([
        { str: 'ABC', transform: [1, 0, 0, 12, 100, 700], width: 0, height: 12 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].bbox.width).toBeCloseTo(21.6, 5)
    })
  })

  describe('U-L-05: 空文字フィルタリング', () => {
    it('空白のみの item は TextBlock に含まれない', async () => {
      const pdf = makeMockPdf([
        { str: '   ', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
        { str: 'Hello', transform: [1, 0, 0, 12, 200, 700], width: 30, height: 12 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks).toHaveLength(1)
      expect(page.textBlocks[0].text).toBe('Hello')
    })

    it('全要素が空白のとき textBlocks が空になる', async () => {
      const pdf = makeMockPdf([
        { str: '\t', transform: [1, 0, 0, 12, 100, 700], width: 10, height: 12 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks).toHaveLength(0)
    })
  })

  describe('U-L-06: height フォールバック', () => {
    it('item.height=0 → |transform[3]| が bbox.height になる', async () => {
      const pdf = makeMockPdf([
        { str: 'X', transform: [1, 0, 0, 14, 100, 700], width: 10, height: 0 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].bbox.height).toBe(14)
    })

    it('item.height=0 かつ transform[3]=0 → デフォルト値 12 になる', async () => {
      const pdf = makeMockPdf([
        { str: 'X', transform: [1, 0, 0, 0, 100, 700], width: 10, height: 0 },
      ])
      const page = await loadPage(pdf, 0)
      expect(page.textBlocks[0].bbox.height).toBe(12)
    })
  })

})
