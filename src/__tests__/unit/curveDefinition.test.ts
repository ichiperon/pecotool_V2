/**
 * Unit tests for src/utils/curveDefinition.ts (issue #186)
 *
 * 検証:
 *  - arc / polyline の正規な値を受理
 *  - 不正な type / 欠損フィールド / 型違いの値を rejectionsly drop
 *  - undefined / null / 非 object を reject
 */
import { describe, expect, it } from 'vitest';
import { isCurveDefinition } from '../../utils/curveDefinition';

describe('isCurveDefinition / arc', () => {
  it('全フィールドが揃った arc を受理する', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 100, y: 200 },
        radius: 50,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toBe(true);
  });

  it('center 欠損で reject', () => {
    expect(
      isCurveDefinition({ type: 'arc', radius: 50, startAngle: 0, endAngle: 1 }),
    ).toBe(false);
  });

  it('center.x が string で reject', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: '100', y: 200 },
        radius: 50,
        startAngle: 0,
        endAngle: 1,
      }),
    ).toBe(false);
  });

  it('radius が string で reject', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: '50',
        startAngle: 0,
        endAngle: 1,
      }),
    ).toBe(false);
  });
});

describe('isCurveDefinition / polyline', () => {
  it('2 点以上の points を持つ polyline を受理する', () => {
    expect(
      isCurveDefinition({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 50 },
        ],
      }),
    ).toBe(true);
  });

  it('3 点の polyline も受理する', () => {
    expect(
      isCurveDefinition({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 100, y: 50 },
        ],
      }),
    ).toBe(true);
  });

  it('1 点のみは reject (折れ線にならない)', () => {
    expect(
      isCurveDefinition({ type: 'polyline', points: [{ x: 0, y: 0 }] }),
    ).toBe(false);
  });

  it('points が array でないと reject', () => {
    expect(isCurveDefinition({ type: 'polyline', points: 'foo' })).toBe(false);
  });

  it('points 内の点が x/y を欠くと reject', () => {
    expect(
      isCurveDefinition({
        type: 'polyline',
        points: [{ x: 0, y: 0 }, { x: 100 }],
      }),
    ).toBe(false);
  });
});

describe('isCurveDefinition / 不正値', () => {
  it('未知の type は reject', () => {
    expect(
      isCurveDefinition({ type: 'bezier', p0: { x: 0, y: 0 } }),
    ).toBe(false);
  });

  it('type 欠損は reject', () => {
    expect(isCurveDefinition({ center: { x: 0, y: 0 }, radius: 1 })).toBe(false);
  });

  it('null / undefined / 文字列 / 数値 は reject', () => {
    expect(isCurveDefinition(null)).toBe(false);
    expect(isCurveDefinition(undefined)).toBe(false);
    expect(isCurveDefinition('arc')).toBe(false);
    expect(isCurveDefinition(42)).toBe(false);
    expect(isCurveDefinition([])).toBe(false);
  });
});

// ─── 境界値・追加 edge cases ──────────────────────────────────────────────────

describe('isCurveDefinition / arc boundary values', () => {
  it('AB-arc-01: radius が 0 でも accept (実装的に valid)', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 0,
        startAngle: 0,
        endAngle: 0,
      }),
    ).toBe(true);
  });

  it('AB-arc-02: radius が負数 — accept (型バリデーションのみ)', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: -1,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toBe(true);
  });

  it('AB-arc-03: startAngle > endAngle — accept (逆向き arc として有効)', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 10,
        startAngle: Math.PI,
        endAngle: 0,
      }),
    ).toBe(true);
  });

  it('AB-arc-04: radius が Infinity — accept (型バリデーションのみ)', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: Infinity,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toBe(true);
  });

  it('AB-arc-05: radius が NaN — accept (NaN は typeof number)', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: NaN,
        startAngle: 0,
        endAngle: Math.PI,
      }),
    ).toBe(true);
  });

  it('AB-arc-06: center.y が undefined — reject', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0 },
        radius: 10,
        startAngle: 0,
        endAngle: 1,
      }),
    ).toBe(false);
  });

  it('AB-arc-07: center が null — reject', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: null,
        radius: 10,
        startAngle: 0,
        endAngle: 1,
      }),
    ).toBe(false);
  });

  it('AB-arc-08: startAngle 欠損 — reject', () => {
    expect(
      isCurveDefinition({
        type: 'arc',
        center: { x: 0, y: 0 },
        radius: 10,
        endAngle: 1,
      }),
    ).toBe(false);
  });
});

describe('isCurveDefinition / polyline boundary values', () => {
  it('AB-poly-01: points が空配列 — reject (2点未満)', () => {
    expect(isCurveDefinition({ type: 'polyline', points: [] })).toBe(false);
  });

  it('AB-poly-02: points が undefined — reject', () => {
    expect(isCurveDefinition({ type: 'polyline' })).toBe(false);
  });

  it('AB-poly-03: points 内の点が number でなく object 型違い — reject', () => {
    expect(
      isCurveDefinition({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: '100', y: 50 },
        ],
      }),
    ).toBe(false);
  });

  it('AB-poly-04: 非常に多い点 (1000点) でも accept', () => {
    const manyPoints = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i }));
    expect(
      isCurveDefinition({ type: 'polyline', points: manyPoints }),
    ).toBe(true);
  });

  it('AB-poly-05: 同一座標の 2 点 (degenerate) でも accept (型バリデーション通過)', () => {
    expect(
      isCurveDefinition({
        type: 'polyline',
        points: [{ x: 5, y: 5 }, { x: 5, y: 5 }],
      }),
    ).toBe(true);
  });
});
