import type { SkippedPdfTextChar, SkippedPdfTextReason } from './pdfWorkerTypes';

export type SkippedTextCollector = Map<string, SkippedPdfTextChar>;

const UNSAFE_PDF_COPY_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function createSkippedTextCollector(): SkippedTextCollector {
  return new Map();
}

export function stripUnsafePdfCopyChars(text: string): string {
  return text.replace(UNSAFE_PDF_COPY_CHARS, '');
}

export function sanitizeTextForPdfCopy(
  text: string,
  collector?: SkippedTextCollector,
  pageIndex?: number,
): string {
  return text.replace(UNSAFE_PDF_COPY_CHARS, (char) => {
    if (collector) recordSkippedTextChar(collector, 'control-character', char, pageIndex);
    return '';
  });
}

export function recordSkippedTextChar(
  collector: SkippedTextCollector,
  reason: SkippedPdfTextReason,
  char: string,
  pageIndex?: number,
): void {
  const codePoint = formatCodePoint(char);
  const key = `${reason}:${codePoint}`;
  const existing = collector.get(key);
  const pageNumber = Number.isInteger(pageIndex) ? (pageIndex as number) + 1 : null;

  if (existing) {
    existing.count += 1;
    if (pageNumber !== null && !existing.pages.includes(pageNumber)) existing.pages.push(pageNumber);
    return;
  }

  collector.set(key, {
    char,
    codePoint,
    count: 1,
    pages: pageNumber === null ? [] : [pageNumber],
    reason,
  });
}

export function getSkippedTextChars(collector: SkippedTextCollector): SkippedPdfTextChar[] {
  return [...collector.values()]
    .map((item) => ({ ...item, pages: [...item.pages].sort((a, b) => a - b) }))
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.codePoint.localeCompare(b.codePoint));
}

function formatCodePoint(char: string): string {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 'U+????';
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
