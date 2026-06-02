import type { CurveDefinition } from '../types';

/**
 * 3 点 (p1, p2, p3) を通る円弧の CurveDefinition を算出する (issue #189)。
 *
 * 座標系: viewport 座標 (y-down)。
 * 戻り値 null: 3 点が直線上またはほぼ同一点 (ε 以下) のとき。
 */
export function arcFromThreePoints(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): (CurveDefinition & { type: 'arc' }) | null {
  // 外接円の中心を perpendicular bisector 2 本の交点で求める
  // a=p1, b=p2, c=p3 (外接円計算の慣習的略称)
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;

  // 行列式: D = 2 * (ax*(by - cy) + bx*(cy - ay) + cx*(ay - by))
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const EPS = 1e-6;
  if (Math.abs(D) < EPS) return null; // 3 点共線

  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;

  const radius = Math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2);
  if (radius < EPS) return null;

  const startAngle = Math.atan2(ay - uy, ax - ux);
  const endAngle   = Math.atan2(cy - uy, cx - ux);

  return {
    type: 'arc',
    center: { x: ux, y: uy },
    radius,
    startAngle,
    endAngle,
  };
}

/**
 * arc の 3 ハンドル位置を viewport 座標で返す。
 * - handles[0]: 始点 (startAngle)
 * - handles[1]: 中点 (sweep 方向を考慮した短弧側)
 * - handles[2]: 終点 (endAngle)
 */
export function arcHandlePositions(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  // delta を [-π, π] に正規化して sweep 方向を保持した短弧側の中点を求める
  let delta = endAngle - startAngle;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const midAngle = startAngle + delta / 2;

  const polar = (a: number) => ({
    x: center.x + radius * Math.cos(a),
    y: center.y + radius * Math.sin(a),
  });

  return [polar(startAngle), polar(midAngle), polar(endAngle)];
}
