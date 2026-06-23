/**
 * canvasRotation.ts
 *
 * UI rotation（pageRotation: 0/90/180/270）に伴う
 * bbox 座標系 ↔ スクリーン座標系の変換を担う純粋関数群。
 *
 * 座標系の定義:
 *   - bbox 空間: page.getViewport({ scale: 1.0 }) の viewport 空間
 *     (PDF /Rotate 反映済み・UI rotation 未適用)
 *   - スクリーン空間 (zoom 適用前): bbox * scale した後の UI rotation 前空間
 *     (= rotation=0 のときの canvas 空間)
 *   - rotated screen 空間: UI rotation を加えた実際の描画キャンバス空間
 *
 * overlay 描画では「bbox 空間 → scale → rotated screen 空間」の変換が必要。
 * マウス hit-test では逆変換「rotated screen 空間 → scale 逆数 → bbox 空間」が必要。
 *
 * pdfSaverCore.getViewportSize と方向整合:
 *   rotation=90/270 のとき vw/vh (= rotated canvas の width/height) は
 *   元の pageW/pageH が swap される。これは pdfSaverCore.getViewportSize と同一。
 */

export interface CanvasRotationParams {
  /** UI rotation (0 | 90 | 180 | 270) */
  rotation: number;
  /**
   * rotation 後の canvas width (px)。
   * 90/270 のときは元の pageH * scale に相当。
   */
  vw: number;
  /**
   * rotation 後の canvas height (px)。
   * 90/270 のときは元の pageW * scale に相当。
   */
  vh: number;
}

/**
 * bbox 空間のスクリーン座標 (= bbox * scale) を
 * rotation 後の rotated screen 空間に変換する。
 *
 * r=0 は恒等変換（既存コードと完全に同じ結果）。
 */
export function bboxToRotatedScreen(
  x: number,
  y: number,
  { rotation, vw, vh }: CanvasRotationParams,
): { x: number; y: number } {
  const r = ((rotation % 360) + 360) % 360;
  switch (r) {
    case 0:
      return { x, y };
    case 90:
      // (x, y) → (vw - y, x)
      // キャンバスは (vw=元height*s, vh=元width*s) に swap 済み。
      // pdfjs getViewport(R=90) と一致（PCT-119: 旧実装は vh/vw 取り違えで
      // 非正方形ページの BB がずれていた）。
      return { x: vw - y, y: x };
    case 180:
      // (x, y) → (vw - x, vh - y)
      return { x: vw - x, y: vh - y };
    case 270:
      // (x, y) → (y, vh - x)
      return { x: y, y: vh - x };
    default:
      return { x, y };
  }
}

/**
 * rotated screen 空間のマウス座標を
 * bbox 空間のスクリーン座標 (= bbox * scale 相当) に逆変換する。
 *
 * r=0 は恒等変換（既存コードと完全に同じ結果）。
 */
export function rotatedScreenToBbox(
  rx: number,
  ry: number,
  { rotation, vw, vh }: CanvasRotationParams,
): { x: number; y: number } {
  const r = ((rotation % 360) + 360) % 360;
  switch (r) {
    case 0:
      return { x: rx, y: ry };
    case 90:
      // 逆変換: bboxToRotatedScreen(x, y) = (vw-y, x)
      // → x = ry, y = vw - rx
      return { x: ry, y: vw - rx };
    case 180:
      // 逆変換: bboxToRotatedScreen(x, y) = (vw-x, vh-y)
      // → x = vw - rx, y = vh - ry
      return { x: vw - rx, y: vh - ry };
    case 270:
      // 逆変換: bboxToRotatedScreen(x, y) = (y, vh-x)
      // → x = vh - ry, y = rx
      return { x: vh - ry, y: rx };
    default:
      return { x: rx, y: ry };
  }
}

/**
 * canvas context に UI rotation 分の変換を適用する。
 * この関数を ctx.save() 直後に呼び、描画後に ctx.restore() を呼ぶこと。
 *
 * bbox * scale した座標で drawRect 等を呼べば、
 * rotation 後の正しい位置に描画される。
 *
 * r=0 は setTransform を呼ばない（既存コードと完全に同じ結果）。
 */
export function applyRotationTransform(
  ctx: CanvasRenderingContext2D,
  { rotation, vw, vh }: CanvasRotationParams,
): void {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 0) return;
  switch (r) {
    case 90:
      ctx.transform(0, 1, -1, 0, vw, 0);
      break;
    case 180:
      ctx.transform(-1, 0, 0, -1, vw, vh);
      break;
    case 270:
      ctx.transform(0, -1, 1, 0, 0, vh);
      break;
    default:
      break;
  }
}
