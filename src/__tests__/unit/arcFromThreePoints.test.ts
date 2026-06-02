import { describe, it, expect } from 'vitest'
import { arcFromThreePoints, arcHandlePositions } from '../../utils/arcFromThreePoints'

describe('arcFromThreePoints', () => {
  it('3 点が直線上のとき null を返す', () => {
    const p1 = { x: 0, y: 0 }
    const p2 = { x: 1, y: 1 }
    const p3 = { x: 2, y: 2 }
    expect(arcFromThreePoints(p1, p2, p3)).toBeNull()
  })

  it('半円弧を正しく算出する', () => {
    // 原点中心、半径 10 の半円 (y=0 の直径上 3 点)
    const p1 = { x: -10, y: 0 }
    const p2 = { x: 0, y: 10 } // 頂点 (上)
    const p3 = { x: 10, y: 0 }
    const arc = arcFromThreePoints(p1, p2, p3)
    expect(arc).not.toBeNull()
    expect(arc!.type).toBe('arc')
    expect(arc!.center.x).toBeCloseTo(0, 5)
    expect(arc!.center.y).toBeCloseTo(0, 5)
    expect(arc!.radius).toBeCloseTo(10, 5)
  })

  it('直角三角形の外接円を正しく算出する', () => {
    // 直角三角形: (0,0), (2,0), (0,2) → 外接円中心 (1,1), radius = sqrt(2)
    const p1 = { x: 0, y: 0 }
    const p2 = { x: 2, y: 0 }
    const p3 = { x: 0, y: 2 }
    const arc = arcFromThreePoints(p1, p2, p3)
    expect(arc).not.toBeNull()
    expect(arc!.center.x).toBeCloseTo(1, 5)
    expect(arc!.center.y).toBeCloseTo(1, 5)
    expect(arc!.radius).toBeCloseTo(Math.sqrt(2), 5)
    // 始点と終点はそれぞれ p1, p3 に対応する角度
    expect(arc!.startAngle).toBeCloseTo(Math.atan2(0 - 1, 0 - 1), 5)
    expect(arc!.endAngle).toBeCloseTo(Math.atan2(2 - 1, 0 - 1), 5)
  })

  it('ほぼ同一点のとき null を返す', () => {
    const p = { x: 5, y: 5 }
    expect(arcFromThreePoints(p, { x: 5.000001, y: 5 }, { x: 5, y: 5.000001 })).toBeNull()
  })
})

describe('arcHandlePositions', () => {
  it('始点・中点・終点を正しく返す', () => {
    const center = { x: 0, y: 0 }
    const radius = 10
    const startAngle = 0
    const endAngle = Math.PI
    const [h0, h1, h2] = arcHandlePositions(center, radius, startAngle, endAngle)

    // 始点: angle=0 → (10, 0)
    expect(h0.x).toBeCloseTo(10, 5)
    expect(h0.y).toBeCloseTo(0, 5)
    // 中点: angle=π/2 → (0, 10)
    expect(h1.x).toBeCloseTo(0, 5)
    expect(h1.y).toBeCloseTo(10, 5)
    // 終点: angle=π → (-10, 0)
    expect(h2.x).toBeCloseTo(-10, 5)
    expect(h2.y).toBeCloseTo(0, 5)
  })

  it('短弧 (delta < π): 中点が短弧側 (startAngle と endAngle の中間角) にある', () => {
    // startAngle=0, endAngle=π/2 (delta=π/2, 正方向・反時計回り)
    const center = { x: 0, y: 0 }
    const radius = 10
    const startAngle = 0
    const endAngle = Math.PI / 2
    const [, h1] = arcHandlePositions(center, radius, startAngle, endAngle)

    // 中点: angle=π/4 → (cos(π/4)*10, sin(π/4)*10)
    expect(h1.x).toBeCloseTo(10 * Math.cos(Math.PI / 4), 5)
    expect(h1.y).toBeCloseTo(10 * Math.sin(Math.PI / 4), 5)
  })

  it('長弧/負方向 (startAngle > endAngle, delta が [-π,0]): 中点が短弧側 (cw 方向) にある', () => {
    // startAngle=3π/4, endAngle=-3π/4 (delta = -3π/2 → normalize → -3π/2+2π = π/2... wait)
    // 具体的に: startAngle=π/2, endAngle=-π/2 で cw 半円
    // delta = -π/2 - π/2 = -π → normalize [-π, π]: -π (境界)
    // 別の例: startAngle=π/4, endAngle=-π/4 (cw 方向 π/2 の短弧)
    const center = { x: 0, y: 0 }
    const radius = 10
    const startAngle = Math.PI / 4
    const endAngle = -Math.PI / 4
    const [, h1] = arcHandlePositions(center, radius, startAngle, endAngle)

    // delta = -π/4 - π/4 = -π/2 (already in [-π,π])
    // midAngle = π/4 + (-π/2)/2 = π/4 - π/4 = 0
    // 中点: angle=0 → (10, 0)
    expect(h1.x).toBeCloseTo(10, 5)
    expect(h1.y).toBeCloseTo(0, 5)
  })

  it('0↔2π 跨ぎ (startAngle=3, endAngle=-3) でも短弧側中点が正しい', () => {
    // startAngle=3, endAngle=-3
    // delta = -3 - 3 = -6 → normalize: -6 + 2π ≈ -6 + 6.283 = 0.283 (正方向の短弧)
    const center = { x: 0, y: 0 }
    const radius = 10
    const startAngle = 3
    const endAngle = -3
    const [, h1] = arcHandlePositions(center, radius, startAngle, endAngle)

    // delta after normalize: -6 + 2π ≈ 0.2832
    const delta = -6 + 2 * Math.PI
    const expectedMidAngle = startAngle + delta / 2
    expect(h1.x).toBeCloseTo(10 * Math.cos(expectedMidAngle), 5)
    expect(h1.y).toBeCloseTo(10 * Math.sin(expectedMidAngle), 5)
  })
})
