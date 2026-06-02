import type { CurveDefinition } from '../types';

export interface GlyphTransform {
  /** 文字 (1 Unicode コードポイント、surrogate pair は 1 GlyphTransform にまとめる) */
  char: string;
  /** PDF 座標系での描画原点 x (PDF Y-up を考慮した文字 baseline 起点) */
  x: number;
  /** PDF 座標系での描画原点 y */
  y: number;
  /** baseline 接線方向の回転角 (radian、PDF +x 軸を 0 とする反時計回り正) */
  rotation: number;
}

/**
 * 文字列を curve に沿って等弧長で配置し、各文字の Tm 行列を構成する transform を返す
 * (issue #187)。
 *
 * 座標変換:
 *   curve (TextBlock.bbox と同じく viewport 座標, y-down) から
 *   PDF 座標 (y-up) へは y_pdf = pageHeight - y_viewport で flip する。
 *   接線方向の角度も y 軸反転により符号が反転する: rotation_pdf = -rotation_viewport
 *
 * 字幅処理:
 *   フォントメトリクス非依存の簡易等弧長配置。クラスタ単位 (UTF-16 surrogate pair 配慮)
 *   で `count` 個に均等分割し、各クラスタを中央 (i + 0.5) / n の位置に配置する。
 *   fontSize は将来の "弧長 < text 全幅" の早期警告などで参照する余地のため受け取るが、
 *   現実装では使用しない (Phase 3 では axis-aligned 経路と同じく "bbox を full に使う"
 *   原則の curve 版として弧長均等配置で十分視認できる)。
 *
 * @param text 描画文字列 (空文字は空配列)
 * @param curve arc または polyline
 * @param fontSize  font size (point) — 現実装では未使用、将来拡張のため interface に維持
 * @param pageHeight  PDF 座標系 (y-up) への flip に使うページ高さ
 */
export function layoutTextOnCurve(
  text: string,
  curve: CurveDefinition,
  fontSize: number,
  pageHeight: number,
): GlyphTransform[] {
  void fontSize; // 将来用 (現実装では弧長均等配置のため未使用)

  // UTF-16 サロゲートペアを 1 文字として扱う。
  const chars: string[] = [];
  for (const ch of text) chars.push(ch);
  if (chars.length === 0) return [];

  if (curve.type === 'arc') {
    return layoutOnArc(chars, curve, pageHeight);
  }
  return layoutOnPolyline(chars, curve, pageHeight);
}

function layoutOnArc(
  chars: string[],
  curve: Extract<CurveDefinition, { type: 'arc' }>,
  pageHeight: number,
): GlyphTransform[] {
  const { center, radius, startAngle, endAngle } = curve;
  const n = chars.length;
  const sweep = endAngle - startAngle; // 符号付き (反時計回り正)
  const dir = sweep >= 0 ? 1 : -1; // 配置進行方向 (テキストが逆向きにならないよう接線方向に反映)

  const result: GlyphTransform[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n; // 0..1 の中央パラメータ
    const theta = startAngle + t * sweep; // viewport 座標系 (y-down) での角度
    const xV = center.x + radius * Math.cos(theta);
    const yV = center.y + radius * Math.sin(theta);
    // viewport y-down 座標系で円周上の接線は theta + π/2 (反時計回り進行) / theta - π/2 (時計回り)
    const tangentV = theta + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    // PDF (y-up) へ変換: y 反転 → 角度の符号反転
    const xPdf = xV;
    const yPdf = pageHeight - yV;
    const rotationPdf = -tangentV;
    result.push({ char: chars[i], x: xPdf, y: yPdf, rotation: rotationPdf });
  }
  return result;
}

function layoutOnPolyline(
  chars: string[],
  curve: Extract<CurveDefinition, { type: 'polyline' }>,
  pageHeight: number,
): GlyphTransform[] {
  const { points } = curve;
  // セグメント (begin, end, length, cumulative)
  type Seg = { x0: number; y0: number; x1: number; y1: number; len: number; cum: number };
  const segs: Seg[] = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue; // 0 長セグメントは無視
    segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, len, cum: total });
    total += len;
  }
  if (segs.length === 0 || total === 0) return [];

  const n = chars.length;
  const result: GlyphTransform[] = [];
  for (let i = 0; i < n; i++) {
    const d = ((i + 0.5) / n) * total; // 累積弧長上の中央位置
    // 二分探索ではなく順次走査 (segs は通常 4 個以下、最大でも数十個)。
    let seg = segs[segs.length - 1];
    for (const s of segs) {
      if (d <= s.cum + s.len) {
        seg = s;
        break;
      }
    }
    const localT = (d - seg.cum) / seg.len; // 0..1
    const xV = seg.x0 + localT * (seg.x1 - seg.x0);
    const yV = seg.y0 + localT * (seg.y1 - seg.y0);
    // viewport (y-down) での接線方向。
    const tangentV = Math.atan2(seg.y1 - seg.y0, seg.x1 - seg.x0);
    const xPdf = xV;
    const yPdf = pageHeight - yV;
    const rotationPdf = -tangentV;
    result.push({ char: chars[i], x: xPdf, y: yPdf, rotation: rotationPdf });
  }
  return result;
}
