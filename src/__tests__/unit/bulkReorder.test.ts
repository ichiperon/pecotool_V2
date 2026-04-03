import { describe, it, expect } from 'vitest';
import { classifyDirection, reorderBlocks, DragDirection } from '../../utils/bulkReorder';
import { TextBlock } from '../../types';

describe('bulkReorder - classifyDirection', () => {
  it('should classify horizontal movements correctly', () => {
    expect(classifyDirection(10, 0)).toBe('left-right');
    expect(classifyDirection(-10, 0)).toBe('right-left');
  });

  it('should classify vertical movements correctly', () => {
    // 画面座標系なので dy > 0 は下方向 (up-down)
    expect(classifyDirection(0, 10)).toBe('up-down');
    // dy < 0 は上方向 (down-up)
    expect(classifyDirection(0, -10)).toBe('down-up');
  });

  it('should classify diagonal movements correctly', () => {
    expect(classifyDirection(10, 10)).toBe('topleft-bottomright');
    expect(classifyDirection(-10, -10)).toBe('bottomright-topleft');
    expect(classifyDirection(10, -10)).toBe('bottomleft-topright');
    expect(classifyDirection(-10, 10)).toBe('topright-bottomleft');
  });

  it('should return null for small movements', () => {
    expect(classifyDirection(2, 2)).toBeNull();
  });
});

describe('bulkReorder - reorderBlocks', () => {
  const mockBlocks: TextBlock[] = [
    { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', order: 0, pageIndex: 0 },
    { id: '2', bbox: { x: 200, y: 100, width: 50, height: 20 }, text: 'B', order: 1, pageIndex: 0 },
    { id: '3', bbox: { x: 100, y: 150, width: 50, height: 20 }, text: 'C', order: 2, pageIndex: 0 },
  ];

  it('should reorder blocks from left to right', () => {
    // A(100,100), B(200,100), C(100,150)
    // left-right: Primary axis X (dir 1), Secondary axis Y (dir 1), threshold TVX
    // Sort A then B (same Y-ish), then C (different Y but we are sorting by X primarily?)
    // WAIT: reorderBlocks for 'left-right' uses comparePrimarySecondary(a, b, 'x', 'y', 1, 1, tvX)
    // So it sorts by X first, then Y.
    const result = reorderBlocks(mockBlocks, 'left-right', 50);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('C'); // A(100) and C(100) are same X, so Y (100 vs 150) decides.
    expect(result[2].text).toBe('B'); // B(200) is last.
  });

  it('should reorder blocks from up to down', () => {
    // up-down: Primary axis Y (dir 1), Secondary axis X (dir 1), threshold TVY
    // A(100,100), B(200,100) -> same Y (within threshold), so X decides. A(100) < B(200).
    // C(100,150) -> Y=150 is > 100 + tvY (avgH=20, threshold=50% -> tvY=10).
    // So C is after A and B.
    const result = reorderBlocks(mockBlocks, 'up-down', 50);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
    expect(result[2].text).toBe('C');
  });

  it('should handle small vertical offsets within threshold for horizontal sorting', () => {
    const multiLineBlocks: TextBlock[] = [
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', order: 0, pageIndex: 0 },
      { id: '2', bbox: { x: 200, y: 105, width: 50, height: 20 }, text: 'B', order: 1, pageIndex: 0 }, // Slightly lower but Y-offset is only 5
    ];
    // up-down sorting (typical reading order)
    // avgH = 20. threshold = 50% -> tvY = 10.
    // |yA - yB| = 5. 5 <= 10. So same "line". Sort by X.
    // Result: A, B
    const result = reorderBlocks(multiLineBlocks, 'up-down', 50);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');

    // With 10% threshold -> tvY = 2.
    // 5 > 2. Different "line". Sort by Y.
    // Result: A, B (still A, B but because yA < yB)
    // If B was slightly higher (y=95):
    const reversedBlocks: TextBlock[] = [
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', order: 0, pageIndex: 0 },
      { id: '2', bbox: { x: 200, y: 95, width: 50, height: 20 }, text: 'B', order: 1, pageIndex: 0 },
    ];
    // threshold 50% -> tvY = 10. 5 <= 10. Same line. Sort by X. Result: A, B.
    const resSameLine = reorderBlocks(reversedBlocks, 'up-down', 50);
    expect(resSameLine[0].text).toBe('A');
    expect(resSameLine[1].text).toBe('B');

    // threshold 10% -> tvY = 2. 5 > 2. Different line. Sort by Y. Result: B, A.
    const resDiffLine = reorderBlocks(reversedBlocks, 'up-down', 10);
    expect(resDiffLine[0].text).toBe('B');
    expect(resDiffLine[1].text).toBe('A');
  });

  it('should handle overlapping or very close blocks deterministically', () => {
    const overlappingBlocks: TextBlock[] = [
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', order: 0, pageIndex: 0 },
      { id: '2', bbox: { x: 102, y: 102, width: 50, height: 20 }, text: 'B', order: 1, pageIndex: 0 },
    ];
    // Threshold 50% -> tvY = 10. |100-102| = 2. Same line. Sort by X.
    // Result: A(100) then B(102)
    const result = reorderBlocks(overlappingBlocks, 'up-down', 50);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
  });
});
