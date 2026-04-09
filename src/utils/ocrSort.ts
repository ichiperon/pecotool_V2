import { OcrResultBlock } from '../types';
import { OcrSortSettings, RowOrder, ColumnOrder } from '../store/ocrSettingsStore';

function centerX(b: OcrResultBlock): number {
  return b.bbox.x + b.bbox.width / 2;
}

function centerY(b: OcrResultBlock): number {
  return b.bbox.y + b.bbox.height / 2;
}

function groupByTolerance(
  sorted: OcrResultBlock[],
  keyFn: (b: OcrResultBlock) => number,
  tolerance: number
): OcrResultBlock[][] {
  const groups: OcrResultBlock[][] = [];
  let current: OcrResultBlock[] = [];

  for (const block of sorted) {
    if (current.length === 0) {
      current.push(block);
    } else {
      const groupBase = keyFn(current[0]);
      const currVal = keyFn(block);
      if (Math.abs(currVal - groupBase) <= tolerance) {
        current.push(block);
      } else {
        groups.push(current);
        current = [block];
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function sortHorizontal(
  blocks: OcrResultBlock[],
  rowOrder: RowOrder,
  columnOrder: ColumnOrder,
  tolerance: number
): OcrResultBlock[] {
  const rowAsc = rowOrder === 'top-to-bottom';
  const colAsc = columnOrder === 'left-to-right';

  // 主軸: Y（行）でソート・グループ化
  const sorted = [...blocks].sort((a, b) =>
    rowAsc ? centerY(a) - centerY(b) : centerY(b) - centerY(a)
  );
  const groups = groupByTolerance(sorted, centerY, tolerance);

  // 副軸: 各行内をX（列）でソート
  for (const group of groups) {
    group.sort((a, b) =>
      colAsc ? centerX(a) - centerX(b) : centerX(b) - centerX(a)
    );
  }

  return groups.flat();
}

function sortVertical(
  blocks: OcrResultBlock[],
  columnOrder: ColumnOrder,
  rowOrder: RowOrder,
  tolerance: number
): OcrResultBlock[] {
  const colAsc = columnOrder === 'left-to-right';
  const rowAsc = rowOrder === 'top-to-bottom';

  // 主軸: X（列）でソート・グループ化
  const sorted = [...blocks].sort((a, b) =>
    colAsc ? centerX(a) - centerX(b) : centerX(b) - centerX(a)
  );
  const groups = groupByTolerance(sorted, centerX, tolerance);

  // 副軸: 各列内をY（行）でソート
  for (const group of groups) {
    group.sort((a, b) =>
      rowAsc ? centerY(a) - centerY(b) : centerY(b) - centerY(a)
    );
  }

  return groups.flat();
}

export function sortOcrBlocks(
  blocks: OcrResultBlock[],
  settings: OcrSortSettings
): OcrResultBlock[] {
  const { horizontal, vertical, groupTolerance, mixedOrder } = settings;

  const hBlocks = blocks.filter((b) => b.writingMode === 'horizontal');
  const vBlocks = blocks.filter((b) => b.writingMode === 'vertical');

  const sortedH = sortHorizontal(hBlocks, horizontal.rowOrder, horizontal.columnOrder, groupTolerance);
  const sortedV = sortVertical(vBlocks, vertical.columnOrder, vertical.rowOrder, groupTolerance);

  if (sortedH.length === 0) return sortedV;
  if (sortedV.length === 0) return sortedH;
  return mixedOrder === 'vertical-first'
    ? [...sortedV, ...sortedH]
    : [...sortedH, ...sortedV];
}
