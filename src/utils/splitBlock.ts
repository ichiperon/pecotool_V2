import type { TextBlock } from "../types";

export interface SplitResult {
  b1: TextBlock;
  b2: TextBlock;
}

function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "grapheme" },
    ) => { segment(input: string): Iterable<{ segment: string }> };
  }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(
    new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
}

function graphemeWeight(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0;
  return code <= 0xff || (code >= 0xff61 && code <= 0xff9f) || code === 0x20 ? 1 : 2;
}

function getSplitIndex(graphemes: string[], ratio: number): number {
  if (graphemes.length <= 1) return 1;
  let totalW = 0;
  const weights: number[] = [];
  for (let j = 0; j < graphemes.length; j++) {
    const ww = graphemeWeight(graphemes[j]);
    weights.push(ww);
    totalW += ww;
  }
  const targetW = totalW * ratio;
  let currentW = 0;
  for (let j = 0; j < graphemes.length; j++) {
    currentW += weights[j];
    if (currentW >= targetW) {
      if (currentW - targetW < weights[j] / 2)
        return Math.min(graphemes.length - 1, Math.max(1, j + 1));
      return Math.min(graphemes.length - 1, Math.max(1, j));
    }
  }
  return Math.max(1, graphemes.length - 1);
}

export function splitBlockAtRatio(block: TextBlock, ratio: number): SplitResult | null {
  const graphemes = splitGraphemes(block.text);
  if (graphemes.length < 2) return null;
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const isVertical = block.writingMode === "vertical";
  const splitIdx = getSplitIndex(graphemes, clampedRatio);
  const text1 = graphemes.slice(0, splitIdx).join("");
  const text2 = graphemes.slice(splitIdx).join("");

  const splitAxisSize = isVertical ? block.bbox.height : block.bbox.width;
  if (!Number.isFinite(splitAxisSize) || splitAxisSize < 2) {
    return null;
  }

  const b1: TextBlock = {
    ...block,
    id: crypto.randomUUID(),
    text: text1,
    originalText: text1,
    bbox: { ...block.bbox },
    isDirty: true,
  };
  const b2: TextBlock = {
    ...block,
    id: crypto.randomUUID(),
    text: text2,
    originalText: text2,
    bbox: { ...block.bbox },
    isDirty: true,
  };

  if (!isVertical) {
    const dx = block.bbox.width * clampedRatio;
    const safeDx = Math.max(1, Math.min(block.bbox.width - 1, dx));
    b1.bbox = { ...block.bbox, width: safeDx };
    b2.bbox = {
      ...block.bbox,
      x: block.bbox.x + safeDx,
      width: block.bbox.width - safeDx,
    };
  } else {
    const dy = block.bbox.height * clampedRatio;
    const safeDy = Math.max(1, Math.min(block.bbox.height - 1, dy));
    b1.bbox = { ...block.bbox, height: safeDy };
    b2.bbox = {
      ...block.bbox,
      y: block.bbox.y + safeDy,
      height: block.bbox.height - safeDy,
    };
  }

  return { b1, b2 };
}
