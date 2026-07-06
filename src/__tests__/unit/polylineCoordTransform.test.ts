/**
 * #205: polyline 作成 UI で使う座標変換の代数的性質（往復変換・スケール式）のユニットテスト。
 * canvas 座標 (zoom 適用済み) <-> viewport 座標 (zoom 等倍) の変換を検証。
 *
 * #409 (PCT-178): 従来はこのファイル内に canvasToPdf/pdfToCanvas を複製実装しており、
 * 製品コード非 import のため PdfCanvas.tsx / useCurveEditor.ts 側の実装回帰を検出できな
 * かった。座標変換の実体は src/utils/coordTransform.ts (canvasToViewport / viewportToCanvas)
 * へ抽出済みのため、ここでは複製をやめてその実装を直接 import して検証する。
 * PdfCanvas.tsx の bbox 描画・hit-test 変換 (旧インライン `zoom / 100` 式) と
 * useCurveEditor.ts の canvasToViewport は両方とも coordTransform.ts を参照しているため、
 * この import 経由で両者の回帰を同時に検出できる。
 * (useCurveEditor フック経由の統合検証は useCurveEditor.test.ts の
 * `describe('useCurveEditor — canvasToViewport', ...)` を参照。)
 */
import { describe, it, expect } from 'vitest'
import { canvasToViewport as canvasToPdf, viewportToCanvas as pdfToCanvas } from '../../utils/coordTransform'

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
