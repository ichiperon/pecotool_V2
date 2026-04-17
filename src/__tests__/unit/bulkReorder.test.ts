import { describe, it, expect } from 'vitest';
import { classifyDirection, reorderBlocks, getDirectionLabel } from '../../utils/bulkReorder';
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
    { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    { id: '2', bbox: { x: 200, y: 100, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false },
    { id: '3', bbox: { x: 100, y: 150, width: 50, height: 20 }, text: 'C', originalText: 'C', writingMode: 'horizontal', order: 2, isNew: false, isDirty: false },
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
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
      { id: '2', bbox: { x: 200, y: 105, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false }, // Slightly lower but Y-offset is only 5
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
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
      { id: '2', bbox: { x: 200, y: 95, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false },
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
      { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
      { id: '2', bbox: { x: 102, y: 102, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false },
    ];
    // Threshold 50% -> tvY = 10. |100-102| = 2. Same line. Sort by X.
    // Result: A(100) then B(102)
    const result = reorderBlocks(overlappingBlocks, 'up-down', 50);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
  });
});

describe('bulkReorder - classifyDirection (additional)', () => {
  it('U-BR-10: Exactly distance=5 is valid', () => {
    expect(classifyDirection(5, 0)).toBe('left-right');
  });

  it('U-BR-11: Angle boundary ~22.4° stays left-right', () => {
    // atan2(41, 100) ≈ 22.28°, which is < 22.5° → left-right
    // Note: classifyDirection uses atan2(-dy, dx), so dy=-(-41)=41 maps to angle ≈ 22.28°
    expect(classifyDirection(100, -41)).toBe('left-right');
  });

  it('U-BR-12: Angle boundary ~23.3° becomes diagonal', () => {
    // atan2(43, 100) ≈ 23.27°, which is >= 22.5° → bottomleft-topright
    expect(classifyDirection(100, -43)).toBe('bottomleft-topright');
  });
});

describe('bulkReorder - reorderBlocks (additional)', () => {
  const mockBlocks: TextBlock[] = [
    { id: '1', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    { id: '2', bbox: { x: 200, y: 100, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false },
    { id: '3', bbox: { x: 100, y: 150, width: 50, height: 20 }, text: 'C', originalText: 'C', writingMode: 'horizontal', order: 2, isNew: false, isDirty: false },
  ];

  it('U-BR-17: All output blocks have isDirty=true', () => {
    const result = reorderBlocks(mockBlocks, 'left-right', 50);
    for (const block of result) {
      expect(block.isDirty).toBe(true);
    }
  });

  it('U-BR-18: All output blocks have sequential order (0,1,2...)', () => {
    const result = reorderBlocks(mockBlocks, 'up-down', 50);
    result.forEach((block, i) => {
      expect(block.order).toBe(i);
    });
  });

  it('U-BR-19: Empty input → empty array', () => {
    const result = reorderBlocks([], 'left-right', 50);
    expect(result).toEqual([]);
  });

  it('U-BR-20: Single block → order=0, isDirty=true', () => {
    const single: TextBlock[] = [
      { id: '1', bbox: { x: 0, y: 0, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 5, isNew: false, isDirty: false },
    ];
    const result = reorderBlocks(single, 'left-right', 50);
    expect(result).toHaveLength(1);
    expect(result[0].order).toBe(0);
    expect(result[0].isDirty).toBe(true);
  });

  it('U-BR-21: topright-bottomleft direction (Y asc, X desc within threshold)', () => {
    const blocks: TextBlock[] = [
      { id: '1', bbox: { x: 200, y: 0, width: 50, height: 20 }, text: 'A', originalText: 'A', writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
      { id: '2', bbox: { x: 100, y: 100, width: 50, height: 20 }, text: 'B', originalText: 'B', writingMode: 'horizontal', order: 1, isNew: false, isDirty: false },
      { id: '3', bbox: { x: 0, y: 200, width: 50, height: 20 }, text: 'C', originalText: 'C', writingMode: 'horizontal', order: 2, isNew: false, isDirty: false },
    ];
    // topright-bottomleft: primary Y asc (dir=1), secondary X desc (dir=-1)
    // Y values are well separated, so primary Y ordering: A(y=10), B(y=110), C(y=210)
    const result = reorderBlocks(blocks, 'topright-bottomleft', 50);
    expect(result.map(b => b.text)).toEqual(['A', 'B', 'C']);
  });
});

describe('bulkReorder - getDirectionLabel', () => {
  it('U-BR-22: All 8 directions return non-empty string with arrow character', () => {
    const directions = [
      'up-down', 'down-up', 'left-right', 'right-left',
      'topleft-bottomright', 'bottomright-topleft',
      'topright-bottomleft', 'bottomleft-topright',
    ] as const;
    for (const dir of directions) {
      const label = getDirectionLabel(dir);
      expect(label.length).toBeGreaterThan(0);
      // Check that it contains an arrow character (Unicode arrows: ←→↑↓↗↘↙↖)
      expect(label).toMatch(/[←→↑↓↗↘↙↖]/);
    }
  });

  it('U-BR-23: null → empty string', () => {
    expect(getDirectionLabel(null)).toBe('');
  });
});
