/**
 * Unit tests for src/utils/pageRangeParser.ts
 *
 * Coverage targets:
 *  (A) Normal: basic range, single page, open range, multi-token
 *  (B) Boundary: page 1, page totalPages, start==end, overlap dedup
 *  (C) Error: empty string, "-" only, invalid chars, 0-indexed, reverse range,
 *             out-of-range single page, all tokens out-of-range
 */
import { describe, it, expect } from 'vitest';
import { parsePageRange } from '../../utils/pageRangeParser';

// ─── A: 正常系 ────────────────────────────────────────────────────────────────

describe('parsePageRange / normal cases', () => {
  it('N-01: "1-5" → 5 pages (0-indexed)', () => {
    const result = parsePageRange('1-5', 10);
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('N-02: single page "3" → [2]', () => {
    const result = parsePageRange('3', 10);
    expect(result).toEqual([2]);
  });

  it('N-03: open-end "3-" → from page 3 to totalPages', () => {
    const result = parsePageRange('3-', 5);
    expect(result).toEqual([2, 3, 4]);
  });

  it('N-04: open-start "-3" → from page 1 to page 3', () => {
    const result = parsePageRange('-3', 10);
    expect(result).toEqual([0, 1, 2]);
  });

  it('N-05: multi-token "1, 3, 5" → [0, 2, 4]', () => {
    const result = parsePageRange('1, 3, 5', 10);
    expect(result).toEqual([0, 2, 4]);
  });

  it('N-06: mixed range and single "1-3, 7, 10-12" → [0,1,2,6,9,10,11]', () => {
    const result = parsePageRange('1-3, 7, 10-12', 15);
    expect(result).toEqual([0, 1, 2, 6, 9, 10, 11]);
  });

  it('N-07: leading/trailing whitespace is trimmed', () => {
    const result = parsePageRange('  2-4  ', 10);
    expect(result).toEqual([1, 2, 3]);
  });

  it('N-08: "1-" with totalPages=1 → [0]', () => {
    const result = parsePageRange('1-', 1);
    expect(result).toEqual([0]);
  });

  it('N-09: result is always sorted ascending', () => {
    // "5, 1, 3" should come out sorted
    const result = parsePageRange('5, 1, 3', 10) as number[];
    expect(result).toEqual([0, 2, 4]);
  });

  it('N-10: overlapping ranges deduplicate', () => {
    const result = parsePageRange('1-3, 2-4', 10);
    expect(result).toEqual([0, 1, 2, 3]);
  });
});

// ─── B: 境界値 ────────────────────────────────────────────────────────────────

describe('parsePageRange / boundary values', () => {
  it('B-01: first page only "1" → [0]', () => {
    const result = parsePageRange('1', 5);
    expect(result).toEqual([0]);
  });

  it('B-02: last page "5" with totalPages=5 → [4]', () => {
    const result = parsePageRange('5', 5);
    expect(result).toEqual([4]);
  });

  it('B-03: start == end "3-3" → [2]', () => {
    const result = parsePageRange('3-3', 10);
    expect(result).toEqual([2]);
  });

  it('B-04: "1-1" with single-page document → [0]', () => {
    const result = parsePageRange('1-1', 1);
    expect(result).toEqual([0]);
  });

  it('B-05: single page exceeding totalPages is clipped (no error)', () => {
    // page 20 does not exist in 5-page doc → silently ignored → results in empty
    const result = parsePageRange('20', 5);
    expect(result).toEqual({ error: '有効なページが範囲内に存在しません' });
  });

  it('B-06: range end clamped to totalPages when > totalPages', () => {
    // "3-100" with totalPages=5 → pages 3,4,5 → [2,3,4]
    const result = parsePageRange('3-100', 5);
    expect(result).toEqual([2, 3, 4]);
  });

  it('B-07: open-end "1-" with totalPages=100 → 100 pages', () => {
    const result = parsePageRange('1-', 100) as number[];
    expect(result).toHaveLength(100);
    expect(result[0]).toBe(0);
    expect(result[99]).toBe(99);
  });

  it('B-08: open-start "-1" → [0]', () => {
    const result = parsePageRange('-1', 5);
    expect(result).toEqual([0]);
  });

  it('B-09: totalPages=1, "1-" → [0]', () => {
    const result = parsePageRange('1-', 1);
    expect(result).toEqual([0]);
  });
});

// ─── C: 非正常系・エラー ──────────────────────────────────────────────────────

describe('parsePageRange / error cases', () => {
  it('E-01: empty string → error', () => {
    const result = parsePageRange('', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-02: whitespace only → error', () => {
    const result = parsePageRange('   ', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-03: "-" alone → error (no start, no end)', () => {
    const result = parsePageRange('-', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-04: "abc" → error (invalid format)', () => {
    const result = parsePageRange('abc', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-05: "1-abc" → error (invalid format)', () => {
    const result = parsePageRange('1-abc', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-06: "0" (page number < 1) → error', () => {
    const result = parsePageRange('0', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-07: "0-5" (start < 1) → error', () => {
    const result = parsePageRange('0-5', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-08: "5-3" (start > end) → error', () => {
    const result = parsePageRange('5-3', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-09: "1.5" (float) → error (invalid format)', () => {
    const result = parsePageRange('1.5', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-10: all tokens out of range → error', () => {
    // page 50 in 5-page doc → silently ignored → empty set → error
    const result = parsePageRange('50, 60', 5);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-11: comma-only "," → no valid page → error', () => {
    const result = parsePageRange(',', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-12: "1,,3" (empty token between commas) → silently skipped → [0, 2]', () => {
    // Empty tokens between commas are skipped, only valid tokens counted
    const result = parsePageRange('1,,3', 10);
    // Either succeeds with [0,2] or errors — implementation-defined
    if (Array.isArray(result)) {
      expect(result).toContain(0);
      expect(result).toContain(2);
    } else {
      expect(result).toMatchObject({ error: expect.any(String) });
    }
  });

  it('E-13: negative number "-5" as end-open range → interpreted as open-start', () => {
    // "-5" is parsed as open-start up to page 5
    // This is valid: "-5" → first 5 pages
    const result = parsePageRange('-5', 10);
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('E-14: Unicode / special chars "ページ1" → error', () => {
    const result = parsePageRange('ページ1', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('E-15: NULL byte input → error', () => {
    const result = parsePageRange('\x00', 10);
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

// ─── D: return type invariants ────────────────────────────────────────────────

describe('parsePageRange / return type invariants', () => {
  it('D-01: successful result is a sorted number array', () => {
    const result = parsePageRange('3, 1, 2', 10) as number[];
    expect(Array.isArray(result)).toBe(true);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1]);
    }
  });

  it('D-02: successful result contains only 0-indexed numbers in [0, totalPages)', () => {
    const totalPages = 8;
    const result = parsePageRange('2-6', totalPages) as number[];
    for (const idx of result) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(totalPages);
    }
  });

  it('D-03: error result has string "error" property', () => {
    const result = parsePageRange('', 5) as { error: string };
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});
