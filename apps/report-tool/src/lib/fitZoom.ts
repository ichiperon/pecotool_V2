export type FitMode = "width" | "page" | "custom";

export interface ComputeFitZoomParams {
  fitMode: "width" | "page";
  containerWidth: number;
  containerHeight: number;
  pageWidth: number;
  pageHeight: number;
  padding?: number;
}

/**
 * コンテナとページサイズからフィットズーム率（%整数）を計算する。
 *
 * 不正入力（0以下または非有限の値）が含まれる場合は 0 を返す（呼び出し側は
 * 0 を「適用しない」サインとして扱う）。
 */
export function computeFitZoom(params: ComputeFitZoomParams): number {
  const {
    fitMode,
    containerWidth,
    containerHeight,
    pageWidth,
    pageHeight,
    padding = 32,
  } = params;

  // 不正入力ガード: 0以下または非有限なら計算不能
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(pageHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    pageWidth <= 0 ||
    pageHeight <= 0
  ) {
    return 0;
  }

  const widthFit = Math.floor(
    ((containerWidth - padding) / pageWidth) * 100
  );

  if (fitMode === "width") {
    return Math.max(25, Math.min(400, widthFit));
  }

  // fitMode === "page": 幅フィットと高さフィットの min
  const heightFit = Math.floor(
    ((containerHeight - padding) / pageHeight) * 100
  );
  const pageFit = Math.min(widthFit, heightFit);

  return Math.max(25, Math.min(400, pageFit));
}
