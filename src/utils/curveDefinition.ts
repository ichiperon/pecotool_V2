import type { CurveDefinition } from '../types';

/**
 * CurveDefinition の構造妥当性を確認する type guard。
 * PecoToolBBoxes JSON から読み戻したエントリの curve フィールドや、
 * 外部由来 (バックアップ等) のデータを TextBlock に取り込む前に通す。
 *
 * 不正値は静かに drop される (curve なしの axis-aligned BB として扱われる)。
 *
 * 数値フィールドは Number.isFinite で検証する (typeof number だけでは Infinity/NaN が
 * 通過してしまい、外部データ取込の検証ゲートとして bbox 側 (isValidBBox は isFinite 必須)
 * と非対称になるため揃える)。
 */
export function isCurveDefinition(value: unknown): value is CurveDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'arc') {
    const center = v.center as Record<string, unknown> | null | undefined;
    if (!center || typeof center !== 'object') return false;
    return (
      Number.isFinite(center.x) &&
      Number.isFinite(center.y) &&
      Number.isFinite(v.radius) &&
      Number.isFinite(v.startAngle) &&
      Number.isFinite(v.endAngle)
    );
  }
  if (v.type === 'polyline') {
    const points = v.points;
    if (!Array.isArray(points) || points.length < 2) return false;
    return points.every(
      (p) =>
        !!p &&
        typeof p === 'object' &&
        Number.isFinite((p as Record<string, unknown>).x) &&
        Number.isFinite((p as Record<string, unknown>).y),
    );
  }
  return false;
}
