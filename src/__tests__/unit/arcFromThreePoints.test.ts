import { describe, it, expect } from 'vitest'
import { arcFromThreePoints, arcHandlePositions } from '../../utils/arcFromThreePoints'
import { layoutTextOnCurveViewport } from '../../utils/curveGlyphLayout'

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

  it('startAngle=3, endAngle=-3 (|delta|=6, π を超える sweep) は丸めず生の delta で中点を取る', () => {
    // 以前は delta=-6 を [-π,π] へ正規化して短弧側 (delta≈0.283) の中点を
    // 返していたが、arcFromThreePoints が返す endAngle は既に「p2 を通る
    // 符号付き sweep」として正規化済みのため、ここで再度 [-π,π] に丸めると
    // sweep が π を超えるケースで中点が p2 と反対側にずれてしまう。
    // 現仕様: 生の delta (= endAngle - startAngle) をそのまま二等分する。
    const center = { x: 0, y: 0 }
    const radius = 10
    const startAngle = 3
    const endAngle = -3
    const [, h1] = arcHandlePositions(center, radius, startAngle, endAngle)

    const delta = endAngle - startAngle // -6 (丸めない)
    const expectedMidAngle = startAngle + delta / 2
    expect(h1.x).toBeCloseTo(10 * Math.cos(expectedMidAngle), 5)
    expect(h1.y).toBeCloseTo(10 * Math.sin(expectedMidAngle), 5)
  })
})

describe('arcFromThreePoints — p2 (中点クリック) 側の sweep を保持する (bug-hunt round3 Wave3)', () => {
  const TWO_PI = 2 * Math.PI
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const pointOnCircle = (deg: number, radius = 100) => ({
    x: radius * Math.cos(toRad(deg)),
    y: radius * Math.sin(toRad(deg)),
  })
  // startAngle から終点方向への CCW 弧長を [0, 2π) で測った、符号付き sweep の絶対値相当。
  const angularDistance = (a: number, b: number) => {
    let d = Math.abs(a - b) % TWO_PI
    if (d > Math.PI) d = TWO_PI - d
    return d
  }

  // #189 の 3 点クリックは「p1 → p2 (中点) → p3」の順で収集される。
  // p1/p2/p3 を各象限の境界 (0°/90°/180°/270°) をまたぐ位置に置き、
  // p2 側の短弧 (20°) が選ばれることを確認する。180° のケースが
  // atan2 の ±π 分岐 (継ぎ目) を実際にまたぐ回帰ケース、他の象限は
  // 非跨ぎ (従来から正しい) ケースの非デグレ確認。
  describe.each([
    { label: '0°/360° 境界 (非跨ぎ)', base: 0 },
    { label: '90° 境界 (非跨ぎ)', base: 90 },
    { label: '180° 境界 (atan2 ±π 分岐を実際にまたぐ)', base: 180 },
    { label: '270°/-90° 境界 (非跨ぎ)', base: 270 },
  ])('$label: p1=base-10°, p2=base, p3=base+10°', ({ base }) => {
    const p1 = pointOnCircle(base - 10)
    const p2 = pointOnCircle(base)
    const p3 = pointOnCircle(base + 10)

    it('sweep の絶対値は 20° (p2 を通る短弧) であり、反対側の 340° 長弧にはならない', () => {
      const arc = arcFromThreePoints(p1, p2, p3)
      expect(arc).not.toBeNull()
      const sweepDeg = ((arc!.endAngle - arc!.startAngle) * 180) / Math.PI
      expect(Math.abs(sweepDeg)).toBeCloseTo(20, 5)
    })

    it('arcHandlePositions の中点ハンドルは p2 の実座標に一致する (グリフ配置と同じ側)', () => {
      const arc = arcFromThreePoints(p1, p2, p3)
      expect(arc).not.toBeNull()
      const [, mid] = arcHandlePositions(arc!.center, arc!.radius, arc!.startAngle, arc!.endAngle)
      expect(mid.x).toBeCloseTo(p2.x, 5)
      expect(mid.y).toBeCloseTo(p2.y, 5)
    })

    it('layoutOnArc (viewport) の全グリフが p2 の角度から sweep/2 以内 (=p2 を含む短弧区間) に収まる', () => {
      const arc = arcFromThreePoints(p1, p2, p3)
      expect(arc).not.toBeNull()
      const glyphs = layoutTextOnCurveViewport('ABCDE', arc!, 12)
      expect(glyphs).toHaveLength(5)
      const p2Angle = Math.atan2(p2.y - arc!.center.y, p2.x - arc!.center.x)
      const halfSweepDeg = 10 // sweep 20° の半分
      for (const g of glyphs) {
        const glyphAngle = Math.atan2(g.y - arc!.center.y, g.x - arc!.center.x)
        const distDeg = (angularDistance(glyphAngle, p2Angle) * 180) / Math.PI
        expect(distDeg).toBeLessThanOrEqual(halfSweepDeg + 1e-6)
      }
    })
  })

  it('非跨ぎの既存ケース (0°→90°象限内) は挙動不変: 生の atan2 差分と一致する', () => {
    // p1=0°, p2=45°, p3=90°: 従来の素朴な atan2(p3)-atan2(p1) と
    // p2 を考慮した正規化後の結果が一致することを確認する (回帰なし)。
    const p1 = pointOnCircle(0)
    const p2 = pointOnCircle(45)
    const p3 = pointOnCircle(90)
    const arc = arcFromThreePoints(p1, p2, p3)
    expect(arc).not.toBeNull()
    const rawStart = Math.atan2(p1.y, p1.x)
    const rawEnd = Math.atan2(p3.y, p3.x)
    expect(arc!.startAngle).toBeCloseTo(rawStart, 5)
    expect(arc!.endAngle).toBeCloseTo(rawEnd, 5)
  })
})
