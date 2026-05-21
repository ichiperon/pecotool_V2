import type { BoundingBox, TextBlock } from "../../types";

export function centerX(box: BoundingBox): number {
  return box.x + box.width / 2;
}

export function centerY(box: BoundingBox): number {
  return box.y + box.height / 2;
}

export function right(box: BoundingBox): number {
  return box.x + box.width;
}

export function bottom(box: BoundingBox): number {
  return box.y + box.height;
}

function rangeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function rangeGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}

function overlapRatio(overlap: number, sizeA: number, sizeB: number): number {
  const base = Math.min(sizeA, sizeB);
  return base <= 0 ? 0 : overlap / base;
}

export function horizontalOverlap(a: BoundingBox, b: BoundingBox): number {
  return rangeOverlap(a.x, right(a), b.x, right(b));
}

export function verticalOverlap(a: BoundingBox, b: BoundingBox): number {
  return rangeOverlap(a.y, bottom(a), b.y, bottom(b));
}

export function horizontalGap(a: BoundingBox, b: BoundingBox): number {
  return rangeGap(a.x, right(a), b.x, right(b));
}

export function verticalGap(a: BoundingBox, b: BoundingBox): number {
  return rangeGap(a.y, bottom(a), b.y, bottom(b));
}

export function isSameHorizontalLine(a: BoundingBox, b: BoundingBox): boolean {
  const averageHeight = (a.height + b.height) / 2;
  if (averageHeight <= 0) return false;
  return (
    Math.abs(centerY(a) - centerY(b)) <= averageHeight * 0.45 &&
    overlapRatio(verticalOverlap(a, b), a.height, b.height) >= 0.5
  );
}

export function isSameVerticalColumn(a: BoundingBox, b: BoundingBox): boolean {
  const averageWidth = (a.width + b.width) / 2;
  if (averageWidth <= 0) return false;
  return (
    Math.abs(centerX(a) - centerX(b)) <= averageWidth * 0.45 &&
    overlapRatio(horizontalOverlap(a, b), a.width, b.width) >= 0.5
  );
}

export function areCharacterAdjacent(a: TextBlock, b: TextBlock): boolean {
  if (a.writingMode !== b.writingMode) return false;
  if (a.writingMode === "vertical") {
    const averageWidth = (a.bbox.width + b.bbox.width) / 2;
    return isSameVerticalColumn(a.bbox, b.bbox) && verticalGap(a.bbox, b.bbox) <= averageWidth * 1.2;
  }

  const averageHeight = (a.bbox.height + b.bbox.height) / 2;
  return isSameHorizontalLine(a.bbox, b.bbox) && horizontalGap(a.bbox, b.bbox) <= averageHeight * 1.2;
}

function finitePageLimit(value: number | undefined, ratio: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value * ratio, fallback)
    : fallback;
}

export function areNearbyInReadingOrder(
  a: TextBlock,
  b: TextBlock,
  pageWidth?: number,
  pageHeight?: number,
): boolean {
  if (a.writingMode !== b.writingMode) return false;

  if (a.writingMode === "vertical") {
    const averageWidth = (a.bbox.width + b.bbox.width) / 2;
    const inlineLimit = finitePageLimit(pageHeight, 0.35, averageWidth * 8);
    const nextColumnLimit = finitePageLimit(pageWidth, 0.15, averageWidth * 3);
    if (isSameVerticalColumn(a.bbox, b.bbox)) return verticalGap(a.bbox, b.bbox) <= inlineLimit;
    return horizontalGap(a.bbox, b.bbox) <= nextColumnLimit;
  }

  const averageHeight = (a.bbox.height + b.bbox.height) / 2;
  const inlineLimit = finitePageLimit(pageWidth, 0.35, averageHeight * 8);
  const nextLineLimit = finitePageLimit(pageHeight, 0.15, averageHeight * 3);
  if (isSameHorizontalLine(a.bbox, b.bbox)) return horizontalGap(a.bbox, b.bbox) <= inlineLimit;
  return verticalGap(a.bbox, b.bbox) <= nextLineLimit;
}

export function unionBoundingBoxes(boxes: readonly BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => right(box)));
  const maxY = Math.max(...boxes.map((box) => bottom(box)));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionBlockBoxes(blocks: readonly TextBlock[]): BoundingBox {
  return unionBoundingBoxes(blocks.map((block) => block.bbox));
}

export function sortTextBlocksByOrder(blocks: readonly TextBlock[]): TextBlock[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.order - b.block.order || a.index - b.index)
    .map((entry) => entry.block);
}

export function areOrdersConsecutive(a: TextBlock, b: TextBlock): boolean {
  return b.order === a.order + 1;
}
