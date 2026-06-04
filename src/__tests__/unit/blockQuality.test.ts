/**
 * Unit tests for src/utils/blockQuality.ts (PCT-048).
 *
 * Covers:
 *   - isEmptyBlock
 *   - findOverlappingBlockIds
 *   - getProblematicBlockIds
 *   - getProblematicReason
 */
import { describe, it, expect } from 'vitest';
import {
  BB_OVERLAP_RATIO,
  isEmptyBlock,
  findOverlappingBlockIds,
  getProblematicBlockIds,
  getProblematicReason,
} from '../../utils/blockQuality';
import type { TextBlock } from '../../types';

function makeBlock(id: string, text: string, x: number, y: number, w: number, h: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x, y, width: w, height: h },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
  };
}

// ── BB_OVERLAP_RATIO constant ──────────────────────────────────────────────

describe('BB_OVERLAP_RATIO', () => {
  it('is 0.5', () => {
    expect(BB_OVERLAP_RATIO).toBe(0.5);
  });
});

// ── isEmptyBlock ───────────────────────────────────────────────────────────

describe('isEmptyBlock', () => {
  it('returns true for empty string', () => {
    const block = makeBlock('b1', '', 0, 0, 100, 20);
    expect(isEmptyBlock(block)).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    const block = makeBlock('b1', '   ', 0, 0, 100, 20);
    expect(isEmptyBlock(block)).toBe(true);
  });

  it('returns true for tab and newline only', () => {
    const block = makeBlock('b1', '\t\n', 0, 0, 100, 20);
    expect(isEmptyBlock(block)).toBe(true);
  });

  it('returns false for a block with readable text', () => {
    const block = makeBlock('b1', 'hello', 0, 0, 100, 20);
    expect(isEmptyBlock(block)).toBe(false);
  });

  it('returns false for a block with leading/trailing whitespace around text', () => {
    const block = makeBlock('b1', '  hello  ', 0, 0, 100, 20);
    expect(isEmptyBlock(block)).toBe(false);
  });
});

// ── findOverlappingBlockIds ────────────────────────────────────────────────

describe('findOverlappingBlockIds', () => {
  it('returns empty set when there are no blocks', () => {
    expect(findOverlappingBlockIds([])).toEqual(new Set());
  });

  it('returns empty set for a single block', () => {
    const blocks = [makeBlock('b1', 'a', 0, 0, 100, 50)];
    expect(findOverlappingBlockIds(blocks)).toEqual(new Set());
  });

  it('returns empty set for two non-overlapping blocks', () => {
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 50),
      makeBlock('b2', 'b', 200, 0, 100, 50),
    ];
    expect(findOverlappingBlockIds(blocks)).toEqual(new Set());
  });

  it('returns empty set for two blocks that touch but do not overlap', () => {
    // b1: x=0..100, b2: x=100..200 → intersection width = 0
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 50),
      makeBlock('b2', 'b', 100, 0, 100, 50),
    ];
    expect(findOverlappingBlockIds(blocks)).toEqual(new Set());
  });

  it('detects two blocks where small block is fully contained in large block', () => {
    // b1 (large): 0,0,200,200 → area=40000
    // b2 (small): 50,50,100,100 → area=10000
    // intersection: 100x100=10000, min=10000, ratio=1.0 >= 0.5 → flagged
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 200, 200),
      makeBlock('b2', 'b', 50, 50, 100, 100),
    ];
    const result = findOverlappingBlockIds(blocks);
    expect(result.has('b1')).toBe(true);
    expect(result.has('b2')).toBe(true);
  });

  it('detects two blocks with significant partial overlap', () => {
    // b1: 0,0,100,100 → area=10000
    // b2: 60,0,100,100 → area=10000
    // intersection: x=60..100=40, y=0..100=100 → 4000
    // min=10000, ratio=0.4 < 0.5 → NOT flagged
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 100),
      makeBlock('b2', 'b', 60, 0, 100, 100),
    ];
    const result = findOverlappingBlockIds(blocks);
    expect(result.has('b1')).toBe(false);
    expect(result.has('b2')).toBe(false);
  });

  it('detects overlap exactly at BB_OVERLAP_RATIO threshold (= 0.5)', () => {
    // b1: 0,0,100,100 → area=10000
    // b2: 50,0,100,100 → area=10000
    // intersection: x=50..100=50, y=0..100=100 → 5000
    // min=10000, ratio=0.5 >= 0.5 → flagged
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 100),
      makeBlock('b2', 'b', 50, 0, 100, 100),
    ];
    const result = findOverlappingBlockIds(blocks);
    expect(result.has('b1')).toBe(true);
    expect(result.has('b2')).toBe(true);
  });

  it('does NOT flag two blocks overlapping below the threshold', () => {
    // b1: 0,0,100,100 → area=10000
    // b2: 51,0,100,100 → area=10000
    // intersection: x=51..100=49, y=0..100=100 → 4900
    // min=10000, ratio=0.49 < 0.5 → NOT flagged
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 100),
      makeBlock('b2', 'b', 51, 0, 100, 100),
    ];
    const result = findOverlappingBlockIds(blocks);
    expect(result.has('b1')).toBe(false);
    expect(result.has('b2')).toBe(false);
  });

  it('skips zero-area blocks', () => {
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 0, 100),   // width=0
      makeBlock('b2', 'b', 0, 0, 100, 100),
    ];
    expect(findOverlappingBlockIds(blocks)).toEqual(new Set());
  });

  it('handles three blocks where only two overlap', () => {
    // b1 and b2 overlap (identical bbox), b3 is far away
    const blocks = [
      makeBlock('b1', 'a', 0, 0, 100, 100),
      makeBlock('b2', 'b', 0, 0, 100, 100), // identical to b1 → fully overlapping
      makeBlock('b3', 'c', 500, 0, 100, 100),
    ];
    const result = findOverlappingBlockIds(blocks);
    expect(result.has('b1')).toBe(true);
    expect(result.has('b2')).toBe(true);
    expect(result.has('b3')).toBe(false);
  });
});

// ── getProblematicBlockIds ─────────────────────────────────────────────────

describe('getProblematicBlockIds', () => {
  it('returns empty set for an empty array', () => {
    expect(getProblematicBlockIds([])).toEqual(new Set());
  });

  it('flags an empty-text block', () => {
    const blocks = [makeBlock('b1', '', 0, 0, 100, 20)];
    const result = getProblematicBlockIds(blocks);
    expect(result.has('b1')).toBe(true);
  });

  it('flags overlapping blocks', () => {
    // b1 and b2 fully overlap
    const blocks = [
      makeBlock('b1', 'hello', 0, 0, 100, 100),
      makeBlock('b2', 'world', 0, 0, 100, 100),
    ];
    const result = getProblematicBlockIds(blocks);
    expect(result.has('b1')).toBe(true);
    expect(result.has('b2')).toBe(true);
  });

  it('flags a block that is both empty and overlapping', () => {
    const blocks = [
      makeBlock('b1', '', 0, 0, 100, 100),
      makeBlock('b2', 'text', 0, 0, 100, 100),
    ];
    const result = getProblematicBlockIds(blocks);
    expect(result.has('b1')).toBe(true); // empty + overlap
    expect(result.has('b2')).toBe(true); // overlap only
  });

  it('does not flag a normal non-overlapping non-empty block', () => {
    const blocks = [
      makeBlock('b1', 'hello', 0, 0, 100, 20),
      makeBlock('b2', 'world', 0, 200, 100, 20),
    ];
    const result = getProblematicBlockIds(blocks);
    expect(result.size).toBe(0);
  });
});

// ── getProblematicReason ───────────────────────────────────────────────────

describe('getProblematicReason', () => {
  it('returns null when block is not in problematicIds', () => {
    const block = makeBlock('b1', 'hello', 0, 0, 100, 20);
    const ids = new Set<string>();
    expect(getProblematicReason(block, ids)).toBeNull();
  });

  it('returns "空" for an empty block that is problematic', () => {
    const block = makeBlock('b1', '', 0, 0, 100, 20);
    const ids = new Set(['b1']);
    expect(getProblematicReason(block, ids)).toBe('空');
  });

  it('returns "重なり" for a non-empty block that is problematic', () => {
    const block = makeBlock('b1', 'text', 0, 0, 100, 20);
    const ids = new Set(['b1']);
    expect(getProblematicReason(block, ids)).toBe('重なり');
  });

  it('prioritises "空" over "重なり" when block is both empty and in ids', () => {
    // A block can be flagged for overlap AND be empty; "空" takes priority.
    const block = makeBlock('b1', '  ', 0, 0, 100, 20); // whitespace-only
    const ids = new Set(['b1']);
    expect(getProblematicReason(block, ids)).toBe('空');
  });
});
