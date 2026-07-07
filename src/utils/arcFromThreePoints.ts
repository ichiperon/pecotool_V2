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
  const rawEndAngle = Math.atan2(cy - uy, cx - ux);
  const midAngle = Math.atan2(by - uy, bx - ux);

  // 円周上の p2 (中点クリック) が start→end のどちら側の弧に乗るかを判定し、
  // endAngle を「startAngle から p2 を通って end へ向かう符号付き sweep」に
  // 正規化する。素朴に `atan2(p3) - atan2(p1)` を使うと、p1/p3 の角度が
  // atan2 の ±π 分岐 (継ぎ目) を跨ぐ配置 (例: p1=170°, p2=180°, p3=190°) の
  // とき p2 を無視した反対側の長弧 (この例だと ~340°) が選ばれてしまう。
  //
  // dStart2Mid / dStart2End は startAngle から反時計回り (CCW) に進んだときの
  // 弧長を [0, 2π) で測った値。p2 が「start→end の CCW 経路」上にあるか
  // (dStart2Mid <= dStart2End) で sweep の向き・大きさを決める。
  const TWO_PI = 2 * Math.PI;
  const normalizePositive = (angle: number): number => {
    let a = angle % TWO_PI;
    if (a < 0) a += TWO_PI;
    return a;
  };
  const dStart2Mid = normalizePositive(midAngle - startAngle);
  const dStart2End = normalizePositive(rawEndAngle - startAngle);
  // p2 が CCW 経路 (sweep = dStart2End, [0, 2π)) 上にあればそのまま採用、
  // そうでなければ CW 経路 (sweep = dStart2End - 2π, (-2π, 0)) を採用する。
  const sweep = dStart2Mid <= dStart2End ? dStart2End : dStart2End - TWO_PI;
  const endAngle = startAngle + sweep;

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
 * - handles[1]: 中点 (endAngle - startAngle の sweep をそのまま二等分した角度。
 *   arcFromThreePoints が返す curve では p2 を通る側の sweep になっている)
 * - handles[2]: 終点 (endAngle)
 */
export function arcHandlePositions(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  // sweep (endAngle - startAngle) をそのまま使い、その中間角を中点とする。
  // arcFromThreePoints は endAngle を「startAngle から p2 を通って end へ
  // 向かう符号付き sweep」になるよう正規化して返す (常に短弧とは限らず、
  // p2 が反対側にあれば 180° を超える sweep もあり得る)。ここで delta を
  // [-π, π] に丸めてしまうと sweep が π を超えるケースで中点が p2 と反対側に
  // ずれ、curveGlyphLayout (layoutOnArc) が使う生の sweep と食い違って
  // ハンドル位置とグリフ配置が分離するバグの原因になっていたため、丸めない。
  const delta = endAngle - startAngle;
  const midAngle = startAngle + delta / 2;

  const polar = (a: number) => ({
    x: center.x + radius * Math.cos(a),
    y: center.y + radius * Math.sin(a),
  });

  return [polar(startAngle), polar(midAngle), polar(endAngle)];
}
