import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDocument } from 'pdfjs-dist'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => path,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}))

vi.mock('../../utils/bitmapCache', () => ({
  clearBitmapCache: vi.fn(),
}))

import { loadPage, destroySharedPdfProxy, getSharedPdfProxy } from '../../utils/pdfLoader'

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

/** getDocument がこの pdf を返すようにセットアップ + globalSharedPdfProxy をプリシード */
function setupGetDocument(pdf: ReturnType<typeof makeMockPdf>) {
  (getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
    promise: Promise.resolve(pdf),
  })
  // Pre-seed the shared proxy so getCachedPageProxy doesn't increment globalLoadId
  return getSharedPdfProxy('test.pdf')
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

  describe('U-L-07: Y軸反転OCRテキストの bbox 位置', () => {
    it('transform の d が負 (Y軸反転) → bbox.y がベースライン位置に正しく配置される', async () => {
      // Y軸反転: transform = [12, 0, 0, -12, 100, 700]
      // 垂直方向ベクトルは (0, -1) = 下向き。ascent は下方向に展開されるべき。
      // viewport.height=842, convertToViewportPoint: y → 842 - y
      //   Corner 0: (100, 700) → viewport (100, 142)
      //   Corner 2: (100, 700 + (-1)*13.92) = (100, 686.08) → viewport (100, 155.92)
      // bbox.y = min(142, 155.92) = 142 ← ベースラインが上端
      const pdf = makeMockPdf([
        { str: 'X', transform: [12, 0, 0, -12, 100, 700], width: 10, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.y).toBeCloseTo(142, 1)
      expect(page.textBlocks[0].bbox.height).toBeCloseTo(13.92, 1)
    })

    it('通常の transform (d > 0) では bbox.y = viewportH - transform[5] - ascent', async () => {
      // 通常: transform = [12, 0, 0, 12, 100, 700]
      // 垂直方向ベクトルは (0, 1) = 上向き。ascent は上方向に展開される。
      //   Corner 0: (100, 700) → viewport (100, 142)
      //   Corner 2: (100, 713.92) → viewport (100, 128.08)
      // bbox.y = min(142, 128.08) = 128.08
      const pdf = makeMockPdf([
        { str: 'X', transform: [12, 0, 0, 12, 100, 700], width: 10, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.y).toBeCloseTo(128.08, 1)
      expect(page.textBlocks[0].bbox.height).toBeCloseTo(13.92, 1)
    })
  })

  describe('U-L-08: スケーリング付きY軸反転 (OCR cm パターン)', () => {
    it('0.24 0 0 -0.24 0 842 cm + 42Tf 相当の transform で正しい位置に配置される', async () => {
      // 典型的なOCR cm パターン: cm=[0.24,0,0,-0.24,0,842], Tf=42, Td=(208,58)
      // 合成 transform: [10.08, 0, 0, -10.08, 49.92, 828.08]
      // 垂直方向: (0, -1) = 下向き
      // ascent = 10.08 * 1.16 = 11.6928
      //   Corner 0: (49.92, 828.08) → viewport (49.92, 13.92)
      //   Corner 2: (49.92, 828.08 - 11.6928) = (49.92, 816.39) → viewport (49.92, 25.61)
      // bbox.y = min(13.92, 25.61) = 13.92
      const pdf = makeMockPdf([
        { str: 'テスト', transform: [10.08, 0, 0, -10.08, 49.92, 828.08], width: 30.24, height: 10.08 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks[0].bbox.y).toBeCloseTo(13.92, 1)
      expect(page.textBlocks[0].bbox.x).toBeCloseTo(49.92, 1)
    })
  })

  describe('U-PL-09: Page with no text items returns empty textBlocks', () => {
    it('empty items array → textBlocks is empty', async () => {
      const pdf = makeMockPdf([])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks).toHaveLength(0)
    })
  })

  describe('U-PL-10: Sequential order values', () => {
    it('textBlocks are assigned order 0, 1, 2 sequentially', async () => {
      const pdf = makeMockPdf([
        { str: 'First', transform: [1, 0, 0, 12, 100, 700], width: 30, height: 12 },
        { str: 'Second', transform: [1, 0, 0, 12, 200, 700], width: 40, height: 12 },
        { str: 'Third', transform: [1, 0, 0, 12, 300, 700], width: 35, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks).toHaveLength(3)
      expect(page.textBlocks[0].order).toBe(0)
      expect(page.textBlocks[1].order).toBe(1)
      expect(page.textBlocks[2].order).toBe(2)
    })
  })

  describe('U-PL-11: Whitespace-only items are filtered but non-empty trimmed results preserved', () => {
    it('items with leading/trailing whitespace that have non-empty content are included with original text', async () => {
      const pdf = makeMockPdf([
        { str: '  Hello  ', transform: [1, 0, 0, 12, 100, 700], width: 50, height: 12 },
        { str: '   ', transform: [1, 0, 0, 12, 200, 700], width: 10, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      // Whitespace-only is filtered, but '  Hello  ' passes trim() !== '' check
      expect(page.textBlocks).toHaveLength(1)
      // The original str is preserved (loadPage uses item.str directly, not trimmed)
      expect(page.textBlocks[0].text).toBe('  Hello  ')
    })
  })

  describe('U-PL-12: Multiple items at same position are all included', () => {
    it('no dedup at load time — items with identical positions are all returned', async () => {
      const pdf = makeMockPdf([
        { str: 'Alpha', transform: [1, 0, 0, 12, 100, 700], width: 30, height: 12 },
        { str: 'Beta', transform: [1, 0, 0, 12, 100, 700], width: 30, height: 12 },
        { str: 'Gamma', transform: [1, 0, 0, 12, 100, 700], width: 30, height: 12 },
      ])
      setupGetDocument(pdf)
      const page = await loadPage(pdf as any, 0, 'test.pdf')
      expect(page.textBlocks).toHaveLength(3)
      expect(page.textBlocks.map(b => b.text)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })
  })

})
