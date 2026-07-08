import type { BoundingBox, PageOffset } from "../types/report";

/**
 * ページ回転に伴う座標空間の変換（純関数）。
 *
 * 欄 rect・ページオフセットは「現在表示している viewport のページ座標
 * （scale=1・y下向き）」で保持されている。ユーザーがビューを ±90° 回すと
 * 座標空間ごと回るため、既存の欄・オフセットを新空間へ機械的に写像する。
 * 表示・OCR クロップは同じ回転値の viewport を使うので、この写像さえ正しければ
 * 欄は紙面上の同じ物理領域を指し続ける（cells / confidences / edited は保持できる）。
 *
 * 回転の向きは pdfjs の rotation と同じ「正 = 時計回り（CW）」。
 * 幅 W × 高さ H の空間を +90°CW すると新空間は H × W になり、
 * 旧座標 (x, y) は新座標 (H - y, x) に写る。
 */

/** ページ固有 /Rotate とユーザー回転を合成し 0/90/180/270 に正規化する。 */
export function effectiveRotation(pageRotate: number, userRotation: number): number {
  return (((pageRotate + userRotation) % 360) + 360) % 360;
}

/** rect を +90°CW 回転後の空間へ写像する。pageWidth/pageHeight は回転前の空間の寸法。 */
export function rotateRectCW(
  rect: BoundingBox,
  _pageWidth: number,
  pageHeight: number
): BoundingBox {
  // 新空間での左上は、旧 rect の左下角 (x, y+h) の写像 (H-(y+h), x)
  return {
    x: pageHeight - rect.y - rect.height,
    y: rect.x,
    width: rect.height,
    height: rect.width,
  };
}

/** rect を -90°CCW 回転後の空間へ写像する。 */
export function rotateRectCCW(
  rect: BoundingBox,
  pageWidth: number,
  _pageHeight: number
): BoundingBox {
  // 新空間での左上は、旧 rect の右上角 (x+w, y) の写像 (y, W-(x+w))
  return {
    x: rect.y,
    y: pageWidth - rect.x - rect.width,
    width: rect.height,
    height: rect.width,
  };
}

/** オフセット（変位ベクトル）を +90°CW 回転後の空間へ写像する。 */
export function rotateOffsetCW(offset: PageOffset): PageOffset {
  // 旧 +x（右）→ 新 +y（下）・旧 +y（下）→ 新 -x（左）
  // `|| 0` は -0 の正規化（dy=0 のとき -dy が -0 になり、疎保持の 0 判定や
  // テストの厳密比較を乱すため）
  return { dx: -offset.dy || 0, dy: offset.dx };
}

/** オフセットを -90°CCW 回転後の空間へ写像する。 */
export function rotateOffsetCCW(offset: PageOffset): PageOffset {
  return { dx: offset.dy, dy: -offset.dx || 0 };
}
