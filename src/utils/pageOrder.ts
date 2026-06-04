export function displayToSourcePageIndex(pageOrder: number[] | undefined, displayIndex: number): number {
  return pageOrder?.[displayIndex] ?? displayIndex;
}

export function isIdentityPageOrder(pageOrder: number[] | undefined): boolean {
  return !pageOrder || pageOrder.length === 0 || pageOrder.every((sourceIndex, displayIndex) => sourceIndex === displayIndex);
}
