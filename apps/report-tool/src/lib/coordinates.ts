import type { BoundingBox } from "../types/report";

/**
 * ビューポートパラメータ。
 * zoom: ズームパーセンテージ（100 = 等倍）
 * dpr: devicePixelRatio
 */
export interface ViewportParams {
  zoom: number;
  dpr: number;
}

/**
 * page座標 → device(物理px)座標変換のスケールファクタを返す。
 *
 * factor = (zoom/100) * dpr
 * zoom<=0 の場合はゼロ除算ガードとして factor>0 を保証するため、
 * zoom を最小値 0.1 でクランプする。
 */
export function pageToDeviceFactor(p: ViewportParams): number {
  const safeZoom = Math.max(p.zoom, 0.1);
  return (safeZoom / 100) * p.dpr;
}

/**
 * page座標の BoundingBox を device(物理px)座標に変換する。
 * 全成分に factor を乗算する。
 */
export function pageRectToDevice(
  rect: BoundingBox,
  p: ViewportParams
): BoundingBox {
  const factor = pageToDeviceFactor(p);
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

/**
 * マウスの clientX/Y と canvas の getBoundingClientRect 結果から
 * page座標（scale=1.0, y下方向）を計算する。
 *
 * 変換式:
 *   cssLocal = client - canvasRect.left/top
 *   page = cssLocal * dpr / factor
 *        = cssLocal * dpr / ((zoom/100) * dpr)
 *        = cssLocal / (zoom/100)
 *
 * dpr は分子・分母で打ち消されて page座標に影響しないが、式中に明示的に残す。
 * 段階4でOCRが物理pxを要求した際にファクタの意味を追えるようにするため。
 */
export function clientPointToPage(
  client: { x: number; y: number },
  canvasRect: { left: number; top: number },
  p: ViewportParams
): { x: number; y: number } {
  const factor = pageToDeviceFactor(p);
  const cssLocalX = client.x - canvasRect.left;
  const cssLocalY = client.y - canvasRect.top;
  return {
    x: (cssLocalX * p.dpr) / factor,
    y: (cssLocalY * p.dpr) / factor,
  };
}

/**
 * ドラッグ開始点と終了点（どちらも clientX/Y）から page座標の BoundingBox を返す。
 *
 * Math.min / Math.abs で逆方向ドラッグを正規化するため、
 * width / height は常に正の値になる。
 */
export function dragToPageRect(
  startClient: { x: number; y: number },
  endClient: { x: number; y: number },
  canvasRect: { left: number; top: number },
  p: ViewportParams
): BoundingBox {
  const start = clientPointToPage(startClient, canvasRect, p);
  const end = clientPointToPage(endClient, canvasRect, p);

  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
