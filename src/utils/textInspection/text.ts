type GraphemeSegmenter = new (
  locale?: string | string[],
  options?: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

export function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
}

export function countGraphemes(text: string): number {
  return splitGraphemes(text).length;
}

export function isSymbolOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/[\p{L}\p{N}]/u.test(trimmed);
}

export function hasSentenceTerminal(text: string): boolean {
  return /[。？！?!]/u.test(text);
}
