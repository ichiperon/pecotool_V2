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

/**
 * Sum of full-width(2)/half-width(1) weights for graphemes[0..idx-1].
 * Used to express a grapheme boundary as a weighted ratio (not a plain
 * character-count ratio) so that feeding the result back into
 * getSplitIndex reproduces the same idx (see getSplitRatioSnapped).
 */
function cumulativeWeightRatio(graphemes: string[], idx: number): number {
  let totalW = 0;
  let cumW = 0;
  for (let j = 0; j < graphemes.length; j++) {
    const w = graphemeWeight(graphemes[j]);
    totalW += w;
    if (j < idx) cumW += w;
  }
  return totalW > 0 ? cumW / totalW : 0;
}

/**
 * Converts a geometric ratio (0-1) to the nearest character boundary ratio.
 * Snaps to the closest grapheme boundary within 1..length-1 so the caller
 * can preview and perform splits that land exactly on a character edge.
 * Uses the same full-width(2)/half-width(1) weighted boundary calculation as
 * splitBlockAtRatio (via getSplitIndex) so the preview line always lands on
 * the exact position where the actual split will occur (#423 / PCT-192).
 *
 * The returned ratio is expressed as a *weighted* cumulative ratio (sum of
 * weights up to the snapped index / total weight), not a plain character-count
 * ratio. This matters because callers (useCanvasDrawing.trySplit) feed the
 * returned ratio back into splitBlockAtRatio, which re-derives the split index
 * via the same weighted getSplitIndex mapping. Returning a character-count
 * ratio here would make that second mapping land on a different index for
 * mixed full-width/half-width text (double-snap drift), splitting the text at
 * a different boundary than the bbox division line. The weighted ratio makes
 * the round trip idempotent: getSplitIndex(graphemes, cumulativeWeightRatio(idx)) === idx.
 *
 * Returns the original ratio unchanged when the block has 0 or 1 graphemes
 * (splitting is not meaningful; splitBlockAtRatio will return null for those).
 */
export function getSplitRatioSnapped(block: TextBlock, ratio: number): number {
  const graphemes = splitGraphemes(block.text);
  if (graphemes.length <= 1) return ratio;
  const clamped = Math.max(0, Math.min(1, ratio));
  const safeIdx = getSplitIndex(graphemes, clamped);
  return cumulativeWeightRatio(graphemes, safeIdx);
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
  // 8px 未満は分割すると Acrobat 上で 1〜2px 幅の子 BB ができ、選択時に空白扱いされる。
  if (!Number.isFinite(splitAxisSize) || splitAxisSize < 8) {
    return null;
  }

  // #423 / PCT-192: 分割元が curve 付きの場合、素朴な spread だと両子ブロックへ
  // 同一の curve（円弧/折れ線の全長）がそのまま複製され、分割後の2テキストが
  // それぞれ元の全長カーブに沿って再配置され二重レイアウトで保存される。
  // カーブは分割前提で定義された座標列のため、分割後は curve を解除し
  // 通常の axis-aligned bbox 配置にフォールバックする（安全側）。
  const b1: TextBlock = {
    ...block,
    id: crypto.randomUUID(),
    text: text1,
    originalText: text1,
    bbox: { ...block.bbox },
    curve: undefined,
    isDirty: true,
  };
  const b2: TextBlock = {
    ...block,
    id: crypto.randomUUID(),
    text: text2,
    originalText: text2,
    bbox: { ...block.bbox },
    curve: undefined,
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
