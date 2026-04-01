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

  if ((angle >= 337.5 && angle <= 360) || (angle >= 0 && angle < 22.5)) return 'left-right';
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

export function reorderBlocks(
  blocks: TextBlock[],
  direction: DragDirection,
  thresholdPercent: number
): TextBlock[] {
  const centers = blocks.map(b => ({
    block: b,
    cx: b.bbox.x + b.bbox.width / 2,
    cy: b.bbox.y + b.bbox.height / 2,
    w: b.bbox.width,
    h: b.bbox.height
  }));

  const avgH = centers.length ? centers.reduce((sum, c) => sum + c.h, 0) / centers.length : 0;
  const avgW = centers.length ? centers.reduce((sum, c) => sum + c.w, 0) / centers.length : 0;

  const comparePrimarySecondary = (
    a: typeof centers[0],
    b: typeof centers[0],
    axisPrimary: 'x' | 'y',
    axisSecondary: 'x' | 'y',
    dirPrimary: 1 | -1,
    dirSecondary: 1 | -1,
    thresholdValue: number
  ) => {
    const valA = axisPrimary === 'x' ? a.cx : a.cy;
    const valB = axisPrimary === 'x' ? b.cx : b.cy;

    if (Math.abs(valA - valB) > thresholdValue) {
      return (valA - valB) * dirPrimary;
    }
    
    const secA = axisSecondary === 'x' ? a.cx : a.cy;
    const secB = axisSecondary === 'x' ? b.cx : b.cy;
    return (secA - secB) * dirSecondary;
  };

  const tvY = avgH * (thresholdPercent / 100);
  const tvX = avgW * (thresholdPercent / 100);

  centers.sort((a, b) => {
    switch (direction) {
      case 'up-down':
        return comparePrimarySecondary(a, b, 'y', 'x', 1, 1, tvY);
      case 'down-up':
        return comparePrimarySecondary(a, b, 'y', 'x', -1, -1, tvY);
      case 'left-right':
        return comparePrimarySecondary(a, b, 'x', 'y', 1, 1, tvX);
      case 'right-left':
        return comparePrimarySecondary(a, b, 'x', 'y', -1, -1, tvX);
      case 'topleft-bottomright':
        return comparePrimarySecondary(a, b, 'y', 'x', 1, 1, tvY);
      case 'bottomright-topleft':
        return comparePrimarySecondary(a, b, 'y', 'x', -1, -1, tvY);
      case 'topright-bottomleft':
        return comparePrimarySecondary(a, b, 'y', 'x', 1, -1, tvY);
      case 'bottomleft-topright':
        return comparePrimarySecondary(a, b, 'y', 'x', -1, 1, tvY);
      default:
        return 0;
    }
  });

  return centers.map((c, i) => ({
    ...c.block,
    order: i,
    isDirty: true
  }));
}
