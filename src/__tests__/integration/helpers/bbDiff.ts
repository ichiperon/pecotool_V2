import type { BBoxMetaEntry } from './realPdfFixtures';

export interface ExpectedBB {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  writingMode?: string;
}

export interface Mismatch {
  page: number;
  idx: number;
  field: 'count' | 'x' | 'y' | 'width' | 'height' | 'text' | 'writingMode';
  expected: unknown;
  actual: unknown;
  offByOne?: boolean;
}

const EPS = 1e-6;

function matchesExpected(entry: BBoxMetaEntry, expected: ExpectedBB): boolean {
  if (entry.text !== expected.text) return false;
  if (Math.abs(entry.bbox.x - expected.x) > EPS) return false;
  if (Math.abs(entry.bbox.y - expected.y) > EPS) return false;
  if (Math.abs(entry.bbox.width - expected.width) > EPS) return false;
  if (Math.abs(entry.bbox.height - expected.height) > EPS) return false;
  if (expected.writingMode && entry.writingMode !== expected.writingMode) return false;
  return true;
}

/**
 * Compare page-by-page, index-by-index.
 * Returns all mismatches. For each mismatch, determines whether the actual
 * entry at index i matches expected[i-1] or expected[i+1] (off-by-one bug).
 */
export function diffBBPages(
  expected: Map<number, ExpectedBB[]>,
  actual: Record<string, BBoxMetaEntry[]>,
): { mismatches: Mismatch[]; offByOnePages: number[] } {
  const mismatches: Mismatch[] = [];
  const offByOnePages = new Set<number>();

  for (const [page, expBlocks] of expected.entries()) {
    const actBlocks = actual[String(page)] ?? [];
    if (actBlocks.length !== expBlocks.length) {
      mismatches.push({
        page, idx: -1, field: 'count',
        expected: expBlocks.length, actual: actBlocks.length,
      });
      continue;
    }
    for (let i = 0; i < expBlocks.length; i++) {
      const exp = expBlocks[i];
      const got = actBlocks[i];
      if (!matchesExpected(got, exp)) {
        const prev = i > 0 ? expBlocks[i - 1] : null;
        const next = i < expBlocks.length - 1 ? expBlocks[i + 1] : null;
        const offPrev = prev ? matchesExpected(got, prev) : false;
        const offNext = next ? matchesExpected(got, next) : false;
        const isOffByOne = offPrev || offNext;
        if (isOffByOne) offByOnePages.add(page);
        if (got.text !== exp.text) {
          mismatches.push({
            page, idx: i, field: 'text',
            expected: exp.text, actual: got.text, offByOne: isOffByOne,
          });
        }
        if (Math.abs(got.bbox.x - exp.x) > EPS) {
          mismatches.push({
            page, idx: i, field: 'x',
            expected: exp.x, actual: got.bbox.x, offByOne: isOffByOne,
          });
        }
        if (Math.abs(got.bbox.y - exp.y) > EPS) {
          mismatches.push({
            page, idx: i, field: 'y',
            expected: exp.y, actual: got.bbox.y, offByOne: isOffByOne,
          });
        }
        if (Math.abs(got.bbox.width - exp.width) > EPS) {
          mismatches.push({
            page, idx: i, field: 'width',
            expected: exp.width, actual: got.bbox.width, offByOne: isOffByOne,
          });
        }
        if (Math.abs(got.bbox.height - exp.height) > EPS) {
          mismatches.push({
            page, idx: i, field: 'height',
            expected: exp.height, actual: got.bbox.height, offByOne: isOffByOne,
          });
        }
        if (exp.writingMode && got.writingMode !== exp.writingMode) {
          mismatches.push({
            page, idx: i, field: 'writingMode',
            expected: exp.writingMode, actual: got.writingMode, offByOne: isOffByOne,
          });
        }
      }
    }
  }

  return { mismatches, offByOnePages: Array.from(offByOnePages).sort((a, b) => a - b) };
}
