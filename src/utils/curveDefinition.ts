import type { CurveDefinition } from '../types';

/**
 * CurveDefinition の構造妥当性を確認する type guard。
 * PecoToolBBoxes JSON から読み戻したエントリの curve フィールドや、
 * 外部由来 (バックアップ等) のデータを TextBlock に取り込む前に通す。
 *
 * 不正値は静かに drop される (curve なしの axis-aligned BB として扱われる)。
 */
export function isCurveDefinition(value: unknown): value is CurveDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'arc') {
    const center = v.center as Record<string, unknown> | null | undefined;
    if (!center || typeof center !== 'object') return false;
    return (
      typeof center.x === 'number' &&
      typeof center.y === 'number' &&
      typeof v.radius === 'number' &&
      typeof v.startAngle === 'number' &&
      typeof v.endAngle === 'number'
    );
  }
  if (v.type === 'polyline') {
    const points = v.points;
    if (!Array.isArray(points) || points.length < 2) return false;
    return points.every(
      (p) =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as Record<string, unknown>).x === 'number' &&
        typeof (p as Record<string, unknown>).y === 'number',
    );
  }
  return false;
}
