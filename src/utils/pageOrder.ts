export function displayToSourcePageIndex(pageOrder: number[] | undefined, displayIndex: number): number {
  return pageOrder?.[displayIndex] ?? displayIndex;
}

export function isIdentityPageOrder(pageOrder: number[] | undefined): boolean {
  return !pageOrder || pageOrder.length === 0 || pageOrder.every((sourceIndex, displayIndex) => sourceIndex === displayIndex);
}

/**
 * PCT-104 (A-lite): displayIndex → pageId への変換。
 * pageId の値は "src:" + pageOrder[displayIndex]（= 初期 source index）。
 * pageOrder が空または範囲外の場合は identity 前提で "src:" + displayIndex を返す。
 *
 * ②IDB temporary_changes を読み書きする全箇所はこの関数を必ず経由する（段階2以降）。
 */
export function resolvePageId(pageOrder: number[], displayIndex: number): string {
  const sourceIndex = pageOrder[displayIndex] ?? displayIndex;
  return `src:${sourceIndex}`;
}

/**
 * PCT-104 (A-lite): pageId → displayIndex への変換。
 * pageOrder を線形スキャンして "src:" + pageOrder[i] === pageId となる i を返す。
 * 見つからない場合は -1 を返す。
 *
 * ②IDB temporary_changes を読み書きする全箇所はこの関数を必ず経由する（段階2以降）。
 */
export function resolveDisplayIndex(pageOrder: number[], pageId: string): number {
  // pageId は "src:" + sourceIndex の形式
  const prefix = 'src:';
  if (!pageId.startsWith(prefix)) return -1;
  const sourceIndex = parseInt(pageId.slice(prefix.length), 10);
  if (!Number.isFinite(sourceIndex)) return -1;
  const idx = pageOrder.indexOf(sourceIndex);
  return idx;
}
