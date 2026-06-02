/**
 * Unit tests for src/utils/curveGlyphLayout.ts (issue #187)
 *
 * 検証:
 *  - arc: 各文字が円周上 (中心から radius ±0.01) に乗ること
 *  - arc: rotation が startAngle→endAngle に沿って単調変化
 *  - polyline: 文字が各セグメントの中央付近に配分される
 *  - viewport y-down → PDF y-up flip が正しい (y_pdf = pageHeight - y_viewport)
 *  - 空文字列で空配列
 */
import { describe, expect, it } from 'vitest';
import { layoutTextOnCurve } from '../../utils/curveGlyphLayout';
import type { CurveDefinition } from '../../types';

describe('layoutTextOnCurve / arc', () => {
  it('上半円 (startAngle=π, endAngle=2π) で 6 文字: 各文字が円周上に位置する', () => {
    const pageHeight = 200;
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: Math.PI,
      endAngle: 2 * Math.PI,
    };
    const glyphs = layoutTextOnCurve('ABCDEF', arc, 12, pageHeight);
    expect(glyphs).toHaveLength(6);
    for (const g of glyphs) {
      // viewport 中心は y=100、PDF 反転後の中心 y_pdf = pageHeight - 100 = 100
      const cxPdf = 100;
      const cyPdf = pageHeight - 100;
      const dist = Math.hypot(g.x - cxPdf, g.y - cyPdf);
      expect(dist).toBeCloseTo(50, 1);
    }
  });

  it('arc の rotation が startAngle 付近から endAngle 付近まで monotonic に変化する', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 100,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };
    const glyphs = layoutTextOnCurve('123456', arc, 12, 0);
    expect(glyphs).toHaveLength(6);
    // 接線方向は viewport では theta + π/2、PDF 反転後は -(theta + π/2)。
    // theta が増加するなら PDF rotation は単調減少。
    for (let i = 1; i < glyphs.length; i++) {
      expect(glyphs[i].rotation).toBeLessThan(glyphs[i - 1].rotation);
    }
  });

  it('arc は char 順 (順方向) で配置される', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };
    const glyphs = layoutTextOnCurve('ABC', arc, 12, 0);
    expect(glyphs.map((g) => g.char)).toEqual(['A', 'B', 'C']);
  });

  it('逆向き arc (endAngle < startAngle) でも反転せず char 順を維持', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: Math.PI / 2,
      endAngle: 0,
    };
    const glyphs = layoutTextOnCurve('ABC', arc, 12, 0);
    expect(glyphs.map((g) => g.char)).toEqual(['A', 'B', 'C']);
    // 時計回り進行: 接線 viewport = theta - π/2 → 反転後 PDF rotation = -(theta - π/2)
    // theta が減少するなら PDF rotation は単調増加。
    for (let i = 1; i < glyphs.length; i++) {
      expect(glyphs[i].rotation).toBeGreaterThan(glyphs[i - 1].rotation);
    }
  });
});

describe('layoutTextOnCurve / polyline', () => {
  it('L 字 2 セグメント + 4 文字: 前 2 文字が 1st segment, 後 2 文字が 2nd segment', () => {
    // (0,0)→(100,0): 水平 / (100,0)→(100,100): 垂直 (viewport y-down)
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    };
    const pageHeight = 200;
    const glyphs = layoutTextOnCurve('WXYZ', polyline, 12, pageHeight);
    expect(glyphs).toHaveLength(4);
    // 1 文字目: d = 0.125 * 200 = 25 (1st segment 上)
    expect(glyphs[0].x).toBeCloseTo(25, 5);
    expect(glyphs[0].y).toBeCloseTo(pageHeight - 0, 5);
    // 2 文字目: d = 0.375 * 200 = 75 (1st segment 上)
    expect(glyphs[1].x).toBeCloseTo(75, 5);
    expect(glyphs[1].y).toBeCloseTo(pageHeight - 0, 5);
    // 3 文字目: d = 0.625 * 200 = 125 → 1st 終点 (100) + 25 → 2nd segment 上
    expect(glyphs[2].x).toBeCloseTo(100, 5);
    expect(glyphs[2].y).toBeCloseTo(pageHeight - 25, 5);
    // 4 文字目: d = 0.875 * 200 = 175 → 1st 終点 + 75
    expect(glyphs[3].x).toBeCloseTo(100, 5);
    expect(glyphs[3].y).toBeCloseTo(pageHeight - 75, 5);
  });

  it('水平セグメント上の rotation は 0 (PDF 座標系)', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
    };
    const glyphs = layoutTextOnCurve('AB', polyline, 12, 100);
    // viewport tangent atan2(0, 100) = 0 → PDF rotation = -0 = 0
    for (const g of glyphs) {
      expect(g.rotation).toBeCloseTo(0, 6);
    }
  });

  it('viewport y-down → PDF y-up flip が pageHeight に対して正しい', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 20 },
        { x: 100, y: 20 },
      ],
    };
    const pageHeight = 200;
    const glyphs = layoutTextOnCurve('AB', polyline, 12, pageHeight);
    expect(glyphs[0].y).toBeCloseTo(pageHeight - 20, 6); // 180
    expect(glyphs[1].y).toBeCloseTo(pageHeight - 20, 6);
  });

  it('長さ 0 のセグメントを含む polyline は無視して残りで配置', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0 }, // 重複点 → len=0
        { x: 100, y: 0 },
      ],
    };
    const glyphs = layoutTextOnCurve('XY', polyline, 12, 100);
    expect(glyphs).toHaveLength(2);
    // 1 segment 100 長として配置されたか確認
    expect(glyphs[0].x).toBeCloseTo(25, 5);
    expect(glyphs[1].x).toBeCloseTo(75, 5);
  });

  it('全て 0 長セグメント (degenerate) は空配列', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    };
    expect(layoutTextOnCurve('A', polyline, 12, 100)).toEqual([]);
  });
});

describe('layoutTextOnCurve / edge cases', () => {
  it('空文字列で空配列を返す (arc)', () => {
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI,
    };
    expect(layoutTextOnCurve('', arc, 12, 100)).toEqual([]);
  });

  it('空文字列で空配列を返す (polyline)', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    expect(layoutTextOnCurve('', polyline, 12, 100)).toEqual([]);
  });

  it('サロゲートペア (絵文字) を 1 cluster として扱う', () => {
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    };
    // 🦊 (U+1F98A) は UTF-16 surrogate pair。
    const glyphs = layoutTextOnCurve('🦊A', polyline, 12, 100);
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].char).toBe('🦊');
    expect(glyphs[1].char).toBe('A');
  });
});
