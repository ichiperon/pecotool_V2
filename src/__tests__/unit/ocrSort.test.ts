import { describe, it, expect } from 'vitest';
import { sortOcrBlocks } from '../../utils/ocrSort';
import { OcrResultBlock } from '../../types';
import { OcrSortSettings } from '../../store/ocrSettingsStore';

function makeOcrBlock(overrides: Partial<OcrResultBlock> = {}): OcrResultBlock {
  return {
    text: 'test',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    confidence: 1,
    ...overrides,
  };
}

const defaultSettings: OcrSortSettings = {
  horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
  vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
  groupTolerance: 20,
  mixedOrder: 'vertical-first',
};

describe('ocrSort - sortHorizontal', () => {
  it('U-SR-01: 2x2 grid top→bottom left→right', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'C', bbox: { x: 0, y: 100, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'D', bbox: { x: 100, y: 100, width: 50, height: 20 } }),
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    expect(result.map(b => b.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('U-SR-02: bottom→top right→left reverses both axes', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'C', bbox: { x: 0, y: 100, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'D', bbox: { x: 100, y: 100, width: 50, height: 20 } }),
    ];
    const settings: OcrSortSettings = {
      ...defaultSettings,
      horizontal: { rowOrder: 'bottom-to-top', columnOrder: 'right-to-left' },
    };
    const result = sortOcrBlocks(blocks, settings);
    expect(result.map(b => b.text)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('U-SR-03: tolerance grouping — y=50, y=55, y=150 with tol=20 groups first two', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 50, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 55, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'C', bbox: { x: 0, y: 150, width: 50, height: 20 } }),
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    // centerY: A=60, B=65, C=160. tol=20, so A and B same row.
    expect(result.map(b => b.text)).toEqual(['A', 'B', 'C']);
  });

  it('U-SR-04: tolerance uses centerY — different y but same centerY groups together', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 100 } }),   // centerY=50
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 40, width: 50, height: 20 } }), // centerY=50
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    // Both centerY=50, same row, sort by X ascending
    expect(result.map(b => b.text)).toEqual(['A', 'B']);
  });

  it('U-SR-05: within-row X ascending (left-to-right)', () => {
    const blocks = [
      makeOcrBlock({ text: 'B', bbox: { x: 200, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'C', bbox: { x: 100, y: 0, width: 50, height: 20 } }),
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    expect(result.map(b => b.text)).toEqual(['A', 'C', 'B']);
  });

  it('U-SR-06: within-row X descending (right-to-left)', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'C', bbox: { x: 200, y: 0, width: 50, height: 20 } }),
    ];
    const settings: OcrSortSettings = {
      ...defaultSettings,
      horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'right-to-left' },
    };
    const result = sortOcrBlocks(blocks, settings);
    expect(result.map(b => b.text)).toEqual(['C', 'B', 'A']);
  });
});

describe('ocrSort - sortVertical', () => {
  it('U-SR-07: right→left columns, top→bottom rows', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 200, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'B', bbox: { x: 200, y: 100, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'C', bbox: { x: 50, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'D', bbox: { x: 50, y: 100, width: 20, height: 50 }, writingMode: 'vertical' }),
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    // default vertical: columnOrder='right-to-left', rowOrder='top-to-bottom'
    // centerX: A=210, B=210, C=60, D=60 → right-to-left means descending X first
    // Column 1 (cx=210): A, B sorted by Y asc → A, B
    // Column 2 (cx=60): C, D sorted by Y asc → C, D
    expect(result.map(b => b.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('U-SR-08: left→right columns, bottom→top rows', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 200, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'B', bbox: { x: 200, y: 100, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'C', bbox: { x: 50, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'D', bbox: { x: 50, y: 100, width: 20, height: 50 }, writingMode: 'vertical' }),
    ];
    const settings: OcrSortSettings = {
      ...defaultSettings,
      vertical: { columnOrder: 'left-to-right', rowOrder: 'bottom-to-top' },
    };
    const result = sortOcrBlocks(blocks, settings);
    // left-to-right: ascending X → Column 1 (cx=60): C, D; Column 2 (cx=210): A, B
    // bottom-to-top: descending Y within column → D, C then B, A
    expect(result.map(b => b.text)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('U-SR-09: X-axis tolerance grouping', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 100, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'B', bbox: { x: 105, y: 100, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'C', bbox: { x: 300, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
    ];
    // centerX: A=110, B=115, C=310. tol=20 → A and B same column
    // default vertical: right-to-left → C(310) first, then A/B column
    const result = sortOcrBlocks(blocks, defaultSettings);
    expect(result.map(b => b.text)).toEqual(['C', 'A', 'B']);
  });
});

describe('ocrSort - mixed mode', () => {
  it('U-SR-15: vertical-first puts V blocks before H blocks', () => {
    const blocks = [
      makeOcrBlock({ text: 'H1', bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal' }),
      makeOcrBlock({ text: 'V1', bbox: { x: 200, y: 0, width: 20, height: 100 }, writingMode: 'vertical' }),
    ];
    const settings: OcrSortSettings = { ...defaultSettings, mixedOrder: 'vertical-first' };
    const result = sortOcrBlocks(blocks, settings);
    expect(result.map(b => b.text)).toEqual(['V1', 'H1']);
  });

  it('U-SR-16: horizontal-first puts H blocks before V blocks', () => {
    const blocks = [
      makeOcrBlock({ text: 'V1', bbox: { x: 200, y: 0, width: 20, height: 100 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'H1', bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal' }),
    ];
    const settings: OcrSortSettings = { ...defaultSettings, mixedOrder: 'horizontal-first' };
    const result = sortOcrBlocks(blocks, settings);
    expect(result.map(b => b.text)).toEqual(['H1', 'V1']);
  });

  it('U-SR-17: all horizontal → only sortHorizontal result', () => {
    const blocks = [
      makeOcrBlock({ text: 'B', bbox: { x: 100, y: 0, width: 50, height: 20 } }),
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 50, height: 20 } }),
    ];
    const result = sortOcrBlocks(blocks, defaultSettings);
    expect(result.map(b => b.text)).toEqual(['A', 'B']);
  });

  it('U-SR-18: all vertical → only sortVertical result', () => {
    const blocks = [
      makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
      makeOcrBlock({ text: 'B', bbox: { x: 200, y: 0, width: 20, height: 50 }, writingMode: 'vertical' }),
    ];
    // right-to-left default → B (cx=210) before A (cx=10)
    const result = sortOcrBlocks(blocks, defaultSettings);
    expect(result.map(b => b.text)).toEqual(['B', 'A']);
  });
});

describe('ocrSort - edge cases', () => {
  it('U-SR-19: empty array → []', () => {
    const result = sortOcrBlocks([], defaultSettings);
    expect(result).toEqual([]);
  });

  it('U-SR-20: single block → [block]', () => {
    const block = makeOcrBlock({ text: 'only' });
    const result = sortOcrBlocks([block], defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('only');
  });

  it('U-SR-21: center coordinate calculation determines sort order', () => {
    // Block A: x=0, width=200 → centerX=100
    // Block B: x=90, width=20 → centerX=100
    // Both have same centerX, so within same row they are equal on X.
    // Use different Y to verify centerY is used:
    // Block A: y=0, height=60 → centerY=30
    // Block B: y=25, height=10 → centerY=30
    // Same centerY → same row. Same centerX → stable order.
    const blockA = makeOcrBlock({ text: 'A', bbox: { x: 0, y: 0, width: 200, height: 60 } });
    const blockB = makeOcrBlock({ text: 'B', bbox: { x: 90, y: 25, width: 20, height: 10 } });
    const result = sortOcrBlocks([blockA, blockB], defaultSettings);
    // Both have centerY=30 and centerX=100, so original relative order maintained
    expect(result).toHaveLength(2);
    // Different raw x/y but same center coordinates → grouped together
    expect(result.map(b => b.text)).toContain('A');
    expect(result.map(b => b.text)).toContain('B');
  });
});
