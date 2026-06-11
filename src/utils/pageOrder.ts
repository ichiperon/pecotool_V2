export function displayToSourcePageIndex(pageOrder: number[] | undefined, displayIndex: number): number {
  return pageOrder?.[displayIndex] ?? displayIndex;
}

/** PCT-104: pageId の標準プレフィックス */
const PAGE_ID_PREFIX = 'src:';

/**
 * PCT-104: sourceIndex を pageId 文字列に変換する。
 * 'src:' リテラルを一箇所に集約するためのファクトリ関数。
 */
export function makePageId(sourceIndex: number): string {
  return `${PAGE_ID_PREFIX}${sourceIndex}`;
}

/**
 * PCT-104: pageId 文字列から sourceIndex を取り出す。
 * 'src:' プレフィックスを持たない場合や非有限数の場合は null を返す。
 */
export function parsePageId(pageId: string): number | null {
  if (!pageId.startsWith(PAGE_ID_PREFIX)) return null;
  const n = parseInt(pageId.slice(PAGE_ID_PREFIX.length), 10);
  return Number.isFinite(n) ? n : null;
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
  return makePageId(sourceIndex);
}

/**
 * PCT-104 (A-lite): pageId → displayIndex への変換。
 * pageOrder を線形スキャンして "src:" + pageOrder[i] === pageId となる i を返す。
 * 見つからない場合は -1 を返す。
 *
 * ②IDB temporary_changes を読み書きする全箇所はこの関数を必ず経由する（段階2以降）。
 */
export function resolveDisplayIndex(pageOrder: number[], pageId: string): number {
  const sourceIndex = parsePageId(pageId);
  if (sourceIndex === null) return -1;
  return pageOrder.indexOf(sourceIndex);
}
