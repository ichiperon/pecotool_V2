import type { BoundingBox } from "../types/report";
import type { PageOffset } from "../types/report";

/**
 * 欄の rect にページオフセットを適用して補正済み BoundingBox を返す純関数。
 *
 * PageOffset (dx, dy) は scale=1.0 のページ座標系で指定する。
 * width / height は変化しない（平行移動のみ）。
 *
 * @param fieldRect  欄の元 rect (scale=1.0)
 * @param offset     ページ補正オフセット
 * @returns          補正済み BoundingBox
 */
export function effectiveRectForPage(fieldRect: BoundingBox, offset: PageOffset): BoundingBox {
  return {
    x: fieldRect.x + offset.dx,
    y: fieldRect.y + offset.dy,
    width: fieldRect.width,
    height: fieldRect.height,
  };
}
