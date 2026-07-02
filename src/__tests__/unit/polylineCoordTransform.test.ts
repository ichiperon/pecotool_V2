/**
 * #205: polyline 作成 UI で使う座標変換の代数的性質（往復変換・スケール式）のユニットテスト。
 * canvas 座標 (zoom 適用済み) <-> viewport 座標 (zoom 等倍) の変換を検証。
 *
 * 注意 (#409 / PCT-178): このファイルの canvasToPdf/pdfToCanvas は製品コードを import しない
 * 複製実装であり、実装側の回帰は検出できない（代数的な変換公式そのものの検証に限定）。
 * 実装 (useCurveEditor.ts の canvasToViewport) を直接 import して回帰を検出するテストは
 * useCurveEditor.test.ts の `describe('useCurveEditor — canvasToViewport', ...)` および
 * `describe('useCurveEditor — polyline creation flow', ...)` 内の zoom!=100 ケース
 * （#409 regression guard とコメントしたテスト）を参照すること。
 * canvasToViewport は useCurveEditor フックのクロージャとして定義されており、
 * renderHook を介さずに素の関数として import できないため、このファイル単体を
 * 実装 import 版へ置き換えることはできない。pdfToCanvas 相当の逆変換関数は
 * 現状 PdfCanvas.tsx 側にインライン実装のみで export された関数が存在しないため
 * （#409 は座標変換の共有 util 抽出を提案しているが、PdfCanvas.tsx は別担当が
 * 変更中のため本セッションでは触らない）、同様に複製検証のまま据え置く。
 */
import { describe, it, expect } from 'vitest'

// PdfCanvas 内の canvasToPdf / pdfToCanvas に相当するインライン実装を検証
// (製品コード非 import。実装回帰の検出は useCurveEditor.test.ts が担う。上記注意参照)
function canvasToPdf(pos: { x: number; y: number }, zoom: number): { x: number; y: number } {
  const scale = zoom / 100
  return { x: pos.x / scale, y: pos.y / scale }
}

function pdfToCanvas(pos: { x: number; y: number }, zoom: number): { x: number; y: number } {
  const scale = zoom / 100
  return { x: pos.x * scale, y: pos.y * scale }
}

describe('canvasToPdf', () => {
  it('zoom=100 では変換なし', () => {
    const result = canvasToPdf({ x: 100, y: 200 }, 100)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(200)
  })

  it('zoom=200 では座標が半分になる', () => {
    const result = canvasToPdf({ x: 200, y: 400 }, 200)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(200)
  })

  it('zoom=50 では座標が 2 倍になる', () => {
    const result = canvasToPdf({ x: 50, y: 75 }, 50)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(150)
  })

  it('zoom=150 では正しいスケールを返す', () => {
    const result = canvasToPdf({ x: 150, y: 300 }, 150)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(200)
  })
})

describe('pdfToCanvas', () => {
  it('zoom=100 では変換なし', () => {
    const result = pdfToCanvas({ x: 100, y: 200 }, 100)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(200)
  })

  it('zoom=200 では座標が 2 倍になる', () => {
    const result = pdfToCanvas({ x: 100, y: 200 }, 200)
    expect(result.x).toBeCloseTo(200)
    expect(result.y).toBeCloseTo(400)
  })
})

describe('canvasToPdf / pdfToCanvas 往復変換', () => {
  it('任意 zoom で往復変換すると元の値に戻る', () => {
    const original = { x: 123.456, y: 789.012 }
    for (const zoom of [50, 100, 125, 150, 200]) {
      const canvas = pdfToCanvas(original, zoom)
      const back = canvasToPdf(canvas, zoom)
      expect(back.x).toBeCloseTo(original.x, 5)
      expect(back.y).toBeCloseTo(original.y, 5)
    }
  })
})

describe('polyline draft 点の操作', () => {
  it('点を順次追加すると配列が正しく伸びる', () => {
    let points: Array<{ x: number; y: number }> = []
    const addPoint = (p: { x: number; y: number }) => {
      points = [...points, p]
    }

    addPoint({ x: 10, y: 20 })
    addPoint({ x: 30, y: 40 })
    addPoint({ x: 50, y: 60 })

    expect(points).toHaveLength(3)
    expect(points[0]).toEqual({ x: 10, y: 20 })
    expect(points[2]).toEqual({ x: 50, y: 60 })
  })

  it('1 点以下では CurveDefinition として不正（最低 2 点必要）', () => {
    const isValidPolyline = (pts: Array<{ x: number; y: number }>) => pts.length >= 2
    expect(isValidPolyline([])).toBe(false)
    expect(isValidPolyline([{ x: 0, y: 0 }])).toBe(false)
    expect(isValidPolyline([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(true)
  })
})
