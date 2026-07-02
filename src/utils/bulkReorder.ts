import { TextBlock } from '../types';

export type DragDirection = 
  | 'up-down' | 'down-up' | 'left-right' | 'right-left'
  | 'topleft-bottomright' | 'bottomright-topleft'
  | 'topright-bottomleft' | 'bottomleft-topright';

export function classifyDirection(dx: number, dy: number): DragDirection | null {
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < 5) return null;

  // 画面の座標系から標準的な数学の座標系へ変換 (-dy)
  let angle = Math.atan2(-dy, dx) * (180 / Math.PI);
  if (angle < 0) angle += 360;

  // angle は (-180, 180] → 上で +360 して [0, 360) に正規化済み。境界判定はすべて `< X.5` で統一。
  if ((angle >= 337.5 && angle < 360) || (angle >= 0 && angle < 22.5)) return 'left-right';
  if (angle >= 22.5 && angle < 67.5) return 'bottomleft-topright';
  if (angle >= 67.5 && angle < 112.5) return 'down-up';
  if (angle >= 112.5 && angle < 157.5) return 'bottomright-topleft';
  if (angle >= 157.5 && angle < 202.5) return 'right-left';
  if (angle >= 202.5 && angle < 247.5) return 'topright-bottomleft';
  if (angle >= 247.5 && angle < 292.5) return 'up-down';
  if (angle >= 292.5 && angle < 337.5) return 'topleft-bottomright';

  return null;
}

export function getDirectionLabel(dir: DragDirection | null): string {
  switch (dir) {
    case 'up-down': return '↓ 上→下';
    case 'down-up': return '↑ 下→上';
    case 'left-right': return '→ 左→右';
    case 'right-left': return '← 右→左';
    case 'topleft-bottomright': return '↘ 左上→右下';
    case 'bottomright-topleft': return '↖ 右下→左上';
    case 'topright-bottomleft': return '↙ 右上→左下';
    case 'bottomleft-topright': return '↗ 左下→右上';
    default: return '';
  }
}

type BlockCenter = {
  block: TextBlock;
  cx: number;
  cy: number;
  w: number;
  h: number;
};

/**
 * 許容差（tolerance）でグループ化する。ocrSort.ts の groupByTolerance と同じ方式:
 * 事前に主軸で厳密ソート済みの配列を、隣接要素との差が tolerance 以下なら同一グループに
 * まとめる。閾値付き comparator（隣接ペアの差だけで直接ソートする方式）と異なり、
 * 「a≈b かつ b≈c だが a と c は閾値超」という非推移的な関係が生じても、ソートでなく
 * グループ化として扱うため揺れが発生しない（#426: bulkReorder の旧実装は推移律を破る
 * 閾値付き comparator を Array.sort に渡していたため、傾きスキャン原稿で読み順が
 * 非決定的になっていた）。
 */
function groupByTolerance(
  sorted: BlockCenter[],
  keyFn: (c: BlockCenter) => number,
  tolerance: number
): BlockCenter[][] {
  const groups: BlockCenter[][] = [];
  let current: BlockCenter[] = [];

  for (const c of sorted) {
    if (current.length === 0) {
      current.push(c);
    } else {
      const groupBase = keyFn(current[0]);
      const currVal = keyFn(c);
      if (Math.abs(currVal - groupBase) <= tolerance) {
        current.push(c);
      } else {
        groups.push(current);
        current = [c];
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function reorderBlocks(
  blocks: TextBlock[],
  direction: DragDirection,
  thresholdPercent: number
): TextBlock[] {
  const centers: BlockCenter[] = blocks.map(b => ({
    block: b,
    cx: b.bbox.x + b.bbox.width / 2,
    cy: b.bbox.y + b.bbox.height / 2,
    w: b.bbox.width,
    h: b.bbox.height
  }));

  const avgH = centers.length ? centers.reduce((sum, c) => sum + c.h, 0) / centers.length : 0;
  const avgW = centers.length ? centers.reduce((sum, c) => sum + c.w, 0) / centers.length : 0;
  const tvY = avgH * (thresholdPercent / 100);
  const tvX = avgW * (thresholdPercent / 100);

  // direction ごとの主軸/副軸・昇降順・閾値を決定する。
  // 主軸: 厳密ソート → 許容差でグループ化。副軸: 各グループ内で厳密ソート。
  let primaryKey: (c: BlockCenter) => number;
  let secondaryKey: (c: BlockCenter) => number;
  let primaryAsc: boolean;
  let secondaryAsc: boolean;
  let tolerance: number;

  switch (direction) {
    case 'up-down':
    case 'topleft-bottomright':
      primaryKey = (c) => c.cy; secondaryKey = (c) => c.cx;
      primaryAsc = true; secondaryAsc = true; tolerance = tvY;
      break;
    case 'down-up':
    case 'bottomright-topleft':
      primaryKey = (c) => c.cy; secondaryKey = (c) => c.cx;
      primaryAsc = false; secondaryAsc = false; tolerance = tvY;
      break;
    case 'left-right':
      primaryKey = (c) => c.cx; secondaryKey = (c) => c.cy;
      primaryAsc = true; secondaryAsc = true; tolerance = tvX;
      break;
    case 'right-left':
      primaryKey = (c) => c.cx; secondaryKey = (c) => c.cy;
      primaryAsc = false; secondaryAsc = false; tolerance = tvX;
      break;
    case 'topright-bottomleft':
      primaryKey = (c) => c.cy; secondaryKey = (c) => c.cx;
      primaryAsc = true; secondaryAsc = false; tolerance = tvY;
      break;
    case 'bottomleft-topright':
      primaryKey = (c) => c.cy; secondaryKey = (c) => c.cx;
      primaryAsc = false; secondaryAsc = true; tolerance = tvY;
      break;
    default:
      primaryKey = (c) => c.cy; secondaryKey = (c) => c.cx;
      primaryAsc = true; secondaryAsc = true; tolerance = tvY;
  }

  const sorted = [...centers].sort((a, b) =>
    primaryAsc ? primaryKey(a) - primaryKey(b) : primaryKey(b) - primaryKey(a)
  );
  const groups = groupByTolerance(sorted, primaryKey, tolerance);
  for (const group of groups) {
    group.sort((a, b) =>
      secondaryAsc ? secondaryKey(a) - secondaryKey(b) : secondaryKey(b) - secondaryKey(a)
    );
  }
  const ordered = groups.flat();

  return ordered.map((c, i) => ({
    ...c.block,
    order: i,
    isDirty: true
  }));
}
