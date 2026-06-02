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
