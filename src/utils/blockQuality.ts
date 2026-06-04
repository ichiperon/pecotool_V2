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

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];

      const aArea = a.bbox.width * a.bbox.height;
      const bArea = b.bbox.width * b.bbox.height;

      // Skip degenerate (zero-area) boxes.
      if (aArea <= 0 || bArea <= 0) continue;

      // Compute intersection rectangle.
      const ix = Math.max(a.bbox.x, b.bbox.x);
      const iy = Math.max(a.bbox.y, b.bbox.y);
      const iw = Math.min(a.bbox.x + a.bbox.width,  b.bbox.x + b.bbox.width)  - ix;
      const ih = Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height) - iy;

      if (iw <= 0 || ih <= 0) continue; // No intersection.

      const intersectionArea = iw * ih;
      const minArea = Math.min(aArea, bArea);

      if (intersectionArea / minArea >= BB_OVERLAP_RATIO) {
        result.add(a.id);
        result.add(b.id);
      }
    }
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
  const overlapping = findOverlappingBlockIds(blocks);
  const result = new Set<string>(overlapping);

  for (const block of blocks) {
    if (isEmptyBlock(block)) {
      result.add(block.id);
    }
  }

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
