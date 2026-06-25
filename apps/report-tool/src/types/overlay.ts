/**
 * FieldOverlayCanvas に渡すビューポートジオメトリ。
 * PdfViewer の描画 effect が viewport 確定後に生成して渡す。
 */
export interface OverlayGeom {
  /** PDF canvas の物理px幅（canvas.width）*/
  deviceWidth: number;
  /** PDF canvas の物理px高さ（canvas.height）*/
  deviceHeight: number;
  /** devicePixelRatio */
  dpr: number;
  /** ズームパーセンテージ（100 = 等倍）*/
  zoom: number;
}
