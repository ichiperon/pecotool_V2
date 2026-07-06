/**
 * coordTransform.ts (#409 / PCT-178)
 *
 * viewport 座標 (zoom 非適用 = PDF page.getViewport({ scale: 1.0 }) 相当の空間) と
 * canvas/screen 座標 (zoom 適用済み = 実際に canvas へ描画・hit-test する空間) の
 * 相互変換を担う純粋関数群。
 *
 * 抽出元:
 *   - PdfCanvas.tsx の複数箇所にインラインだった `const scale = zoom / 100; x = value * scale`
 *     (viewport → canvas 方向、bbox の描画座標算出・hit-test 判定に使用)
 *   - useCurveEditor.ts の canvasToViewport (canvas → viewport 方向の逆変換、
 *     curve/polyline のクリック座標を viewport 空間へ戻すのに使用)
 *
 * 両者は同一のスケール係数 (zoom / 100) の順変換・逆変換であり、本ファイルへ統合した。
 * 挙動は抽出前と完全に同一 (同じ式・同じ演算順序)。
 */

/** zoom (%) から canvas 描画スケール係数を算出する。zoom=100 のとき 1。 */
export function getZoomScale(zoom: number): number {
  return zoom / 100;
}

/**
 * viewport 座標 (zoom 非適用) → canvas/screen 座標 (zoom 適用済み) の順変換。
 * PdfCanvas.tsx の bbox 描画座標算出 (旧: `bbox.x * scale` 等) に相当。
 */
export function viewportToCanvas(
  pos: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const scale = getZoomScale(zoom);
  return { x: pos.x * scale, y: pos.y * scale };
}

/**
 * canvas/screen 座標 (zoom 適用済み) → viewport 座標 (zoom 非適用) の逆変換。
 * useCurveEditor.ts の canvasToViewport (旧: `pos.x / scale` 等) に相当。
 * curveDefinition / arcFromThreePoints は zoom 非適用の viewport 座標で扱うため、
 * クリック座標 (canvas 空間) をここで viewport 空間へ戻す。
 */
export function canvasToViewport(
  pos: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const scale = getZoomScale(zoom);
  return { x: pos.x / scale, y: pos.y / scale };
}
