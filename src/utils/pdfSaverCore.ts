/**
 * Shared helpers used by both pdfSaver.ts (main-thread path) and pdf.worker.ts (worker path).
 *
 * Rules:
 * - Pure functions only; no side-effects beyond the arguments passed in.
 * - No imports that are specific to either the main-thread or the Worker environment.
 * - Extracted verbatim from pdfSaver.ts / pdf.worker.ts to eliminate duplication (issue #211).
 */

import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFDict,
} from '@cantoo/pdf-lib';
import { deflate, inflate } from 'pako';
import { stripTextBlocks } from './pdfContentStream';
import {
  isPecoToolFontKey,
  isPecoToolGraphicsStateKey,
} from './pdfPecoToolMarkers';
import type { PDFRef } from '@cantoo/pdf-lib';

// Re-export types that callers reference together with these helpers.
export type { PDFRef };

// ---------------------------------------------------------------------------
// decodeStreamContents
// ---------------------------------------------------------------------------

/**
 * Returns decompressed stream contents, or null if decoding failed / unsupported filter.
 * Callers must skip stream modification when null is returned.
 *
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
export function decodeStreamContents(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();

  // Resolve filter names — Filter can be a single PDFName or a PDFArray of names.
  let filterNames: string[];
  if (filter instanceof PDFName) {
    filterNames = [filter.asString()];
  } else if (filter instanceof PDFArray) {
    // Use .asArray() — PDFArray does NOT expose a .array property
    // asArray() が返すのは PDFObject[] だが Filter 配列の実体は PDFName のみ
    filterNames = filter.asArray().map((f) => (f as PDFName).asString());
  } else if (!filter) {
    // No filter — raw bytes are already plain content operators
    return raw;
  } else {
    // Unknown filter type — skip modification to avoid corrupting the stream
    return null;
  }

  if (filterNames.length === 0) return raw;

  // Only handle a single /FlateDecode; multi-filter chains are left untouched.
  if (filterNames.length === 1 && filterNames[0] === '/FlateDecode') {
    try {
      return inflate(raw);
    } catch {
      return null;
    }
  }

  // Unsupported filter (LZW, ASCII85, multi-filter chain, etc.) — skip modification
  return null;
}

// ---------------------------------------------------------------------------
// bytesEqual
// ---------------------------------------------------------------------------

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// concatWithNewlines
// ---------------------------------------------------------------------------

export function concatWithNewlines(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
    out[offset++] = 0x0a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// isPdfRef
// ---------------------------------------------------------------------------

export function isPdfRef(value: unknown): value is PDFRef {
  return typeof value === 'object' && value !== null && value.constructor?.name === 'PDFRef';
}

// ---------------------------------------------------------------------------
// addRefCount
// ---------------------------------------------------------------------------

export function addRefCount(counts: Map<string, number>, value: unknown): void {
  if (!isPdfRef(value)) return;
  const key = value.toString();
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// collectPageContentRefCounts
// ---------------------------------------------------------------------------

export function collectPageContentRefCounts(pdfDoc: PDFDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const contentsKey = PDFName.of('Contents');
  const getPages = (pdfDoc as unknown as { getPages?: () => Array<{ node: { get?: (key: PDFName) => unknown; Contents?: () => unknown } }> }).getPages;
  if (typeof getPages !== 'function') return counts;

  for (const page of getPages.call(pdfDoc)) {
    const rawContents = page.node.get?.(contentsKey) ?? page.node.Contents?.();
    if (!rawContents) continue;

    addRefCount(counts, rawContents);
    const resolved = pdfDoc.context.lookup(rawContents as any);
    if (!(resolved instanceof PDFArray)) continue;

    for (const streamRef of resolved.asArray()) {
      addRefCount(counts, streamRef);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// deleteIfUniqueRef
// ---------------------------------------------------------------------------

export function deleteIfUniqueRef(
  context: typeof PDFDocument.prototype.context,
  value: unknown,
  contentRefCounts: Map<string, number>,
): void {
  if (!isPdfRef(value)) return;
  if (contentRefCounts.get(value.toString()) !== 1) return;
  context.delete(value);
}

// ---------------------------------------------------------------------------
// cleanContentStream
// ---------------------------------------------------------------------------

export function cleanContentStream(stream: PDFRawStream): boolean {
  const decoded = decodeStreamContents(stream);
  if (decoded === null) return false;

  const cleaned = stripTextBlocks(decoded);
  if (bytesEqual(cleaned, decoded)) return false;

  stream.updateContents(deflate(cleaned));
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.delete(PDFName.of('DecodeParms'));
  return true;
}

// ---------------------------------------------------------------------------
// isFormXObject
// ---------------------------------------------------------------------------

export function isFormXObject(stream: PDFRawStream): boolean {
  const subtype = stream.dict.lookup(PDFName.of('Subtype'));
  return subtype instanceof PDFName && subtype.asString() === '/Form';
}

// ---------------------------------------------------------------------------
// cleanFormXObjectsInResources
// ---------------------------------------------------------------------------

/**
 * Form XObject (Subtype=/Form) を再帰的に走査し、BT...ET ブロックを strip する。
 *
 * #82 visited Set の不変条件 (将来回帰防止のため明示):
 *   1. **冪等性**: `stripTextBlocks` は純粋な状態機械で副作用なし。同じ入力に
 *      対して同じ出力を返し、複数回呼んでも結果は変わらない。
 *   2. **早期 return**: `cleanContentStream` は strip 結果が原本とバイト等価なら
 *      `updateContents` を呼ばずに false を返す。すなわち「2 回目以降の strip は
 *      物理的に no-op」になる。
 *   3. **deep-first add**: 子 Resources を再帰する直前ではなく entries() ループの先頭で
 *      `visitedRefs.add(refKey)` する。つまり「visited に入っている ref は、本体・
 *      子 Resources 含めて既に処理済み」が保証される。
 *
 * 上記 (1)(2)(3) の合成により、`visitedRefs` を全ページで共有 (`sharedVisitedFormRefs`)
 * しても「あるページで処理した Form XObject を別ページで二重処理してしまう」可能性は
 * ない。共有することで:
 *   - 複数ページに跨る共有 Form XObject (Acrobat の typical 構造) を 1 回だけ deflate
 *     できファイル肥大化を防ぐ (issue #54)。
 *   - サイクリック参照があっても無限再帰しない (cycle detection)。
 */
export function cleanFormXObjectsInResources(
  resources: PDFDict | undefined,
  context: typeof PDFDocument.prototype.context,
  visitedRefs: Set<string> = new Set(),
): void {
  const xObjectDict = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjectDict) return;

  for (const [, value] of xObjectDict.entries()) {
    const refKey = isPdfRef(value) ? value.toString() : null;
    if (refKey !== null) {
      // 上の不変条件 (3) を満たすため、recurse する手前で先に mark する。
      // 既存マークありなら本体+子 Resources は前回処理で完結している。
      if (visitedRefs.has(refKey)) continue;
      visitedRefs.add(refKey);
    }

    const xObject = context.lookup(value);
    if (!(xObject instanceof PDFRawStream) || !isFormXObject(xObject)) continue;

    cleanContentStream(xObject);
    const childResources = xObject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    cleanFormXObjectsInResources(childResources, context, visitedRefs);
  }
}

// ---------------------------------------------------------------------------
// pruneStalePecoToolResources
// ---------------------------------------------------------------------------

export function pruneStalePecoToolResources(
  pageNode: { Resources?: () => PDFDict | undefined },
): void {
  const resources = pageNode.Resources?.();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);

  if (fontDict) {
    for (const [key] of fontDict.entries()) {
      if (!isPecoToolFontKey(key)) continue;
      fontDict.delete(key);
    }
  }

  const extGStateDict = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  if (extGStateDict) {
    for (const [key] of extGStateDict.entries()) {
      if (!isPecoToolGraphicsStateKey(key)) continue;
      extGStateDict.delete(key);
    }
  }
}
