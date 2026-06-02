import { usePecoStore } from '../store/pecoStore';
import { flushActiveOcrCardText } from './ocrEditFlush';

/**
 * Store-aware wrapper for flushing the active OcrCard's uncommitted text to
 * the store before save operations.
 *
 * Extracted from OcrCard.tsx to break the transitive dependency on
 * @dnd-kit/core (issue #270): callers such as useFileOperations only need
 * the store + DOM flush logic, not the full React component tree.
 */
export function commitActiveOcrCardEdit(): boolean {
  const { updatePageData, document } = usePecoStore.getState();
  return flushActiveOcrCardText(updatePageData, document);
}
