import type { BoundingBox } from "../types/report";

/**
 * page座標の欄 rect と render_scale から、
 * オフスクリーン canvas 上のクロップ矩形（物理px）を計算する純関数。
 *
 * オフスクリーン canvas は render_scale 倍で描画されるため、
 * page座標 × render_scale = 物理px 上の座標になる。
 * canvas サイズの範囲にクランプして返す。
 *
 * @param fieldRect   page座標の欄矩形 (scale=1.0)
 * @param renderScale オフスクリーン canvas の描画スケール
 * @param canvasWidth オフスクリーン canvas の物理幅 (px)
 * @param canvasHeight オフスクリーン canvas の物理高さ (px)
 * @returns クロップ矩形 {x, y, width, height} (物理px)
 */
export function computeCropRect(
  fieldRect: BoundingBox,
  renderScale: number,
  canvasWidth: number,
  canvasHeight: number
): BoundingBox {
  const rawX = fieldRect.x * renderScale;
  const rawY = fieldRect.y * renderScale;
  const rawW = fieldRect.width * renderScale;
  const rawH = fieldRect.height * renderScale;

  // 左上をクランプ
  const x = Math.max(0, Math.floor(rawX));
  const y = Math.max(0, Math.floor(rawY));

  // 右下もクランプして幅・高さを再計算
  const x2 = Math.min(canvasWidth, Math.ceil(rawX + rawW));
  const y2 = Math.min(canvasHeight, Math.ceil(rawY + rawH));

  const width = Math.max(0, x2 - x);
  const height = Math.max(0, y2 - y);

  return { x, y, width, height };
}

/**
 * オフスクリーン canvas から指定クロップ矩形を部分コピーし、
 * PNG bytes (Uint8Array) を返す。
 *
 * canvas 操作を含むため jsdom テスト不可。
 * クロップ領域の計算は computeCropRect 純関数に分離してテスト可能化している。
 *
 * @param sourceCanvas 描画済みのオフスクリーン canvas
 * @param crop         クロップ矩形 (物理px)
 * @returns PNG bytes (Uint8Array)
 */
export async function cropCanvasToPng(
  sourceCanvas: HTMLCanvasElement,
  crop: BoundingBox
): Promise<Uint8Array> {
  const { x, y, width, height } = crop;

  if (width <= 0 || height <= 0) {
    // 欄が canvas の外にある場合などは空の PNG を返す
    const empty = document.createElement("canvas");
    empty.width = 1;
    empty.height = 1;
    const blob = await new Promise<Blob>((res) =>
      empty.toBlob((b) => res(b!), "image/png")
    );
    empty.width = 0;
    empty.height = 0;
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = width;
  cropCanvas.height = height;
  const ctx = cropCanvas.getContext("2d")!;
  ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);

  const blob = await new Promise<Blob>((res) =>
    cropCanvas.toBlob((b) => res(b!), "image/png")
  );
  cropCanvas.width = 0;
  cropCanvas.height = 0;

  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * pdfjs-dist の PDFDocumentProxy から指定ページをオフスクリーン canvas に
 * render_scale 倍で描画し、canvas と viewport サイズを返す。
 *
 * canvas 操作を含むため jsdom テスト不可。
 *
 * @param pdfDoc      pdfjs-dist の PDFDocumentProxy
 * @param pageNumber  1 始まりのページ番号
 * @param renderScale 描画スケール（OCR 精度向上のため 2.0〜3.0 推奨）
 * @returns { canvas, pageWidth, pageHeight }
 *   canvas: 描画済みオフスクリーン canvas（呼び出し元で破棄すること）
 *   pageWidth/pageHeight: scale=1.0 のページ寸法
 */
export async function renderPageOffscreen(
  // PDFDocumentProxy の具体的な型はビルド依存が大きいため unknown で受けてキャスト
  // pdfjs-dist v5 の型定義との不整合を避けるための措置
  pdfDoc: unknown,
  pageNumber: number,
  renderScale: number,
  // ユーザー回転（90°刻み）。ページ固有 /Rotate に加算合成する。
  // 表示側（PdfViewer/ConfirmPdfPane）と同じ値を使わないと欄座標が全ずれするため、
  // 呼び出し元は pdfStore.rotation を渡すこと（既定 0 は後方互換）。
  userRotation: number = 0
): Promise<{ canvas: HTMLCanvasElement; pageWidth: number; pageHeight: number }> {
  type PdfDoc = { getPage(n: number): Promise<PdfPage> };
  type PdfPage = {
    rotate?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getViewport(opts: { scale: number; rotation?: number }): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(opts: any): { promise: Promise<void> };
    cleanup(): void;
  };
  const doc = pdfDoc as PdfDoc;
  const page = await doc.getPage(pageNumber);
  const canvas = document.createElement("canvas");

  try {
    // pdfjs の rotation 指定はページ固有 /Rotate の「上書き」なので加算合成する
    const rotation = ((((page.rotate ?? 0) + userRotation) % 360) + 360) % 360;
    const viewport1 = page.getViewport({ scale: 1.0, rotation });
    const pageWidth = viewport1.width;
    const pageHeight = viewport1.height;

    const viewport = page.getViewport({ scale: renderScale, rotation });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    return { canvas, pageWidth, pageHeight };
  } catch (e) {
    canvas.width = 0;
    canvas.height = 0;
    throw e;
  } finally {
    page.cleanup();
  }
}
