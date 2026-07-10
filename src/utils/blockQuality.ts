/**
 * Block quality utilities for PCT-048.
 *
 * Provides heuristic detection of "problematic" OCR blocks that should be
 * flagged for user review.  The judgment intentionally avoids the per-block
 * confidence score (which is a coarse 3-bucket estimate from Rust) and uses
 * structural signals instead:
 *
 *   1. Empty text — block.text.trim() === ''
 *   2. Significant bounding-box overlap with another block on the same page.
 *      A pair is considered overlapping when the intersection area is at least
 *      BB_OVERLAP_RATIO of the smaller block's area.
 *
 * These helpers are shared by pdfCanvasRender.ts (canvas overlay) and
 * OcrCard.tsx (sidebar badge) to avoid duplicating the logic.
 */
import type { TextBlock } from '../types';

/**
 * Overlap threshold: if (intersection area / min(area_a, area_b)) >= this
 * value, the two blocks are considered significantly overlapping.
 * Named constant so callers can reference it for documentation purposes.
 */
export const BB_OVERLAP_RATIO = 0.5;

const MIN_Y_CELL_SIZE = 16;
const MAX_BUCKETS_PER_BLOCK = 256;

interface IndexedBlock {
  block: TextBlock;
  left: number;
  right: number;
  top: number;
  bottom: number;
  area: number;
}

// A textBlocks array is the page-quality revision in the store: every page edit
// replaces the array. PdfCanvas and OcrEditor can therefore share the same
// calculation without introducing another store subscription or revision state.
const problematicIdsByRevision = new WeakMap<TextBlock[], Set<string>>();

/** Returns true when the block has no readable text content. */
export function isEmptyBlock(block: TextBlock): boolean {
  return block.text.trim() === '';
}

/**
 * Computes the set of block IDs that have significant bounding-box overlap
 * with at least one other block in the supplied array.
 *
 * Overlap criterion:
 *   intersection_area / min(area_a, area_b) >= BB_OVERLAP_RATIO
 *
 * Only blocks whose bounding-box area is > 0 participate in the check.
 *
 * @param blocks - All TextBlock entries for a single page.
 * @returns A Set of block IDs that overlap significantly with another block.
 */
export function findOverlappingBlockIds(blocks: TextBlock[]): Set<string> {
  const result = new Set<string>();

  const indexed: IndexedBlock[] = [];
  const heights: number[] = [];
  for (const block of blocks) {
    const { x, y, width, height } = block.bbox;
    if (width <= 0 || height <= 0) continue;
    const area = width * height;
    indexed.push({ block, left: x, right: x + width, top: y, bottom: y + height, area });
    heights.push(height);
  }
  if (indexed.length < 2) return result;

  indexed.sort((a, b) => a.left - b.left || a.right - b.right);
  heights.sort((a, b) => a - b);
  const cellSize = Math.max(MIN_Y_CELL_SIZE, heights[Math.floor(heights.length / 2)]);
  const buckets = new Map<number, IndexedBlock[]>();
  const largeBlocks: IndexedBlock[] = [];
  const seenBlocks: IndexedBlock[] = [];

  for (const current of indexed) {
    const firstCell = Math.floor(current.top / cellSize);
    const lastCell = Math.floor(current.bottom / cellSize);
    const bucketCount = lastCell - firstCell + 1;
    const candidates = new Set<IndexedBlock>();

    if (bucketCount > MAX_BUCKETS_PER_BLOCK) {
      // Very tall boxes are uncommon. Avoid creating an unbounded number of
      // buckets while preserving exact results by comparing them with the
      // x-active prefix.
      for (const candidate of seenBlocks) {
        if (candidate.right > current.left) candidates.add(candidate);
      }
    } else {
      for (let cell = firstCell; cell <= lastCell; cell++) {
        const bucket = buckets.get(cell);
        if (!bucket) continue;
        const active = bucket.filter((candidate) => candidate.right > current.left);
        if (active.length === 0) buckets.delete(cell);
        else buckets.set(cell, active);
        for (const candidate of active) candidates.add(candidate);
      }
      for (const candidate of largeBlocks) {
        if (candidate.right > current.left) candidates.add(candidate);
      }
    }

    for (const candidate of candidates) {
      const iw = Math.min(candidate.right, current.right) - current.left;
      const ih = Math.min(candidate.bottom, current.bottom) - Math.max(candidate.top, current.top);
      if (iw <= 0 || ih <= 0) continue;
      if ((iw * ih) / Math.min(candidate.area, current.area) >= BB_OVERLAP_RATIO) {
        result.add(candidate.block.id);
        result.add(current.block.id);
      }
    }

    if (bucketCount > MAX_BUCKETS_PER_BLOCK) {
      largeBlocks.push(current);
    } else {
      for (let cell = firstCell; cell <= lastCell; cell++) {
        const bucket = buckets.get(cell);
        if (bucket) bucket.push(current);
        else buckets.set(cell, [current]);
      }
    }
    seenBlocks.push(current);
  }

  return result;
}

/**
 * Returns the set of block IDs that are "problematic" and should be flagged
 * for user review.  A block is problematic when it is empty OR when it
 * significantly overlaps with another block on the same page.
 *
 * This is the single entry-point that both the canvas renderer and the OcrCard
 * badge should use.
 *
 * @param blocks - All TextBlock entries for a single page.
 * @returns A Set of block IDs that are considered problematic.
 */
export function getProblematicBlockIds(blocks: TextBlock[]): Set<string> {
  const cached = problematicIdsByRevision.get(blocks);
  if (cached) return cached;

  const overlapping = findOverlappingBlockIds(blocks);
  const result = new Set<string>(overlapping);

  for (const block of blocks) {
    if (isEmptyBlock(block)) {
      result.add(block.id);
    }
  }

  problematicIdsByRevision.set(blocks, result);
  return result;
}

/**
 * Returns a human-readable reason label for why a block is flagged.
 * When a block qualifies for multiple reasons, "空" (empty) takes priority
 * because it is the more fundamental issue.
 *
 * Returns null when the block is not problematic.
 *
 * @param block  - The block to inspect.
 * @param problematicIds - Pre-computed set from getProblematicBlockIds().
 */
export function getProblematicReason(
  block: TextBlock,
  problematicIds: Set<string>,
): '空' | '重なり' | null {
  if (!problematicIds.has(block.id)) return null;
  if (isEmptyBlock(block)) return '空';
  return '重なり';
}
