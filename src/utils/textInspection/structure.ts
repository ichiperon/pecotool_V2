import type { BoundingBox, TextBlock } from "../../types";
import {
  areCharacterAdjacent,
  areNearbyInReadingOrder,
  bottom,
  horizontalGap,
  horizontalOverlap,
  isSameHorizontalLine,
  isSameVerticalColumn,
  right,
  sortTextBlocksByOrder,
  unionBlockBoxes,
  verticalGap,
  verticalOverlap,
} from "./geometry";
import { countGraphemes, isSymbolOnly } from "./text";
import type { InspectionCategory, InspectionContext, InspectionIssue, InspectionSeverity } from "./types";
import { makeInspectionIssueId } from "./types";

interface IssueDetails {
  severity: InspectionSeverity;
  title: string;
  message: string;
  suffix: string;
}

function createStructureIssue(
  category: InspectionCategory,
  context: InspectionContext,
  blocks: readonly TextBlock[],
  text: string,
  details: IssueDetails,
): InspectionIssue {
  const blockIds = blocks.map((block) => block.id);
  return {
    id: makeInspectionIssueId(category, context.pageIndex, blockIds, details.suffix),
    pageIndex: context.pageIndex,
    category,
    severity: details.severity,
    title: details.title,
    message: details.message,
    blockIds,
    bbox: blocks.length === 1 ? blocks[0].bbox : unionBlockBoxes(blocks),
    text,
    ignored: false,
  };
}

function hasFinitePositiveBox(block: TextBlock): boolean {
  const box = block.bbox;
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

function area(box: BoundingBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const width = Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
  return width * height;
}

function overlapRatio(overlap: number, sizeA: number, sizeB: number): number {
  const base = Math.min(sizeA, sizeB);
  return base <= 0 ? 0 : overlap / base;
}

function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const intersection = intersectionArea(a, b);
  const union = area(a) + area(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function boxDistance(a: BoundingBox, b: BoundingBox): number {
  const xGap = horizontalGap(a, b);
  const yGap = verticalGap(a, b);
  return Math.hypot(xGap, yGap);
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[center];
  return (sorted[center - 1] + sorted[center]) / 2;
}

function pageLimit(value: number | undefined, ratio: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(value * ratio, minimum)
    : minimum;
}

function describeBboxAnomaly(block: TextBlock, context: InspectionContext): IssueDetails | null {
  const box = block.bbox;
  const values = [box.x, box.y, box.width, box.height];
  const text = normalizedText(block.text);

  if (text.length === 0) {
    return {
      severity: "error",
      title: "空テキストの BB",
      message: "テキストが空の BB があります",
      suffix: `empty-text-${block.id}`,
    };
  }

  if (values.some((value) => !Number.isFinite(value))) {
    return {
      severity: "error",
      title: "BB の数値が不正です",
      message: "BB に有限でない座標またはサイズが含まれています",
      suffix: `non-finite-${block.id}`,
    };
  }

  if (box.width <= 0 || box.height <= 0) {
    return {
      severity: "error",
      title: "BB のサイズが不正です",
      message: `BB の幅または高さが 0 以下です: ${box.width} x ${box.height}`,
      suffix: `non-positive-${block.id}`,
    };
  }

  if (box.width < 1 || box.height < 1) {
    return {
      severity: "error",
      title: "BB が極小です",
      message: `BB の幅または高さが極端に小さいです: ${box.width} x ${box.height}`,
      suffix: `tiny-${block.id}`,
    };
  }

  const marginX = pageLimit(context.pageWidth, 0.02, 16);
  const marginY = pageLimit(context.pageHeight, 0.02, 16);

  if (typeof context.pageWidth === "number" && context.pageWidth > 0 && box.width > context.pageWidth + marginX) {
    return {
      severity: "warning",
      title: "BB がページ幅を大きく超えています",
      message: `BB の幅がページ幅を超えています: ${box.width} / ${context.pageWidth}`,
      suffix: `oversize-width-${block.id}`,
    };
  }

  if (typeof context.pageHeight === "number" && context.pageHeight > 0 && box.height > context.pageHeight + marginY) {
    return {
      severity: "warning",
      title: "BB がページ高を大きく超えています",
      message: `BB の高さがページ高を超えています: ${box.height} / ${context.pageHeight}`,
      suffix: `oversize-height-${block.id}`,
    };
  }

  const pageWidth = context.pageWidth;
  const pageHeight = context.pageHeight;
  const outsideX =
    typeof pageWidth === "number" &&
    pageWidth > 0 &&
    (right(box) < -marginX || box.x > pageWidth + marginX || box.x < -marginX || right(box) > pageWidth + marginX);
  const outsideY =
    typeof pageHeight === "number" &&
    pageHeight > 0 &&
    (bottom(box) < -marginY || box.y > pageHeight + marginY || box.y < -marginY || bottom(box) > pageHeight + marginY);

  if (outsideX || outsideY) {
    return {
      severity: "warning",
      title: "BB がページ範囲から外れています",
      message: "BB がページ境界を大きく外れています",
      suffix: `outside-page-${block.id}`,
    };
  }

  const graphemeCount = countGraphemes(text);
  const textAxisSize = block.writingMode === "vertical" ? box.height : box.width;
  const crossAxisSize = block.writingMode === "vertical" ? box.width : box.height;
  const sizePerGrapheme = graphemeCount > 0 ? textAxisSize / graphemeCount : textAxisSize;

  if (graphemeCount >= 2 && sizePerGrapheme < Math.max(1, crossAxisSize * 0.08)) {
    return {
      severity: "warning",
      title: "文字数に対して BB が小さすぎます",
      message: `文字数 ${graphemeCount} に対して BB の文字方向サイズが極端に小さいです`,
      suffix: `text-too-small-${block.id}`,
    };
  }

  if (graphemeCount >= 1 && sizePerGrapheme > Math.max(120, crossAxisSize * 8)) {
    return {
      severity: "warning",
      title: "文字数に対して BB が大きすぎます",
      message: `文字数 ${graphemeCount} に対して BB の文字方向サイズが極端に大きいです`,
      suffix: `text-too-large-${block.id}`,
    };
  }

  if (
    typeof context.pageWidth === "number" &&
    typeof context.pageHeight === "number" &&
    context.pageWidth > 0 &&
    context.pageHeight > 0 &&
    area(box) > context.pageWidth * context.pageHeight * 0.75 &&
    graphemeCount <= 4
  ) {
    return {
      severity: "warning",
      title: "短いテキストに対して BB が極大です",
      message: `短いテキスト「${text}」の BB がページの大部分を占めています`,
      suffix: `page-large-${block.id}`,
    };
  }

  return null;
}

export function detectBboxAnomalies(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const issues: InspectionIssue[] = [];

  for (const block of blocks) {
    const details = describeBboxAnomaly(block, context);
    if (!details) continue;
    issues.push(createStructureIssue("bbox_anomaly", context, [block], block.text.trim(), details));
  }

  return issues;
}

function areNearDuplicateBoxes(a: BoundingBox, b: BoundingBox): boolean {
  const directDelta =
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2;
  return directDelta || intersectionOverUnion(a, b) >= 0.9;
}

export function detectDuplicateBlocks(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const issues: InspectionIssue[] = [];
  const previousByText = new Map<string, TextBlock[]>();

  for (const block of sortTextBlocksByOrder(blocks)) {
    if (!hasFinitePositiveBox(block)) continue;
    const text = normalizedText(block.text);
    if (text.length === 0) continue;

    const previousBlocks = previousByText.get(text) ?? [];
    const duplicate = previousBlocks.find((previous) => areNearDuplicateBoxes(previous.bbox, block.bbox));
    if (duplicate) {
      issues.push(createStructureIssue("duplicate_block", context, [duplicate, block], text, {
        severity: "error",
        title: "重複した BB",
        message: `同じ文字列の BB がほぼ同じ位置に重複しています: 「${text}」`,
        suffix: `pair-${duplicate.id}-${block.id}`,
      }));
    }

    previousBlocks.push(block);
    previousByText.set(text, previousBlocks);
  }

  return issues;
}

function isPageNumberLike(text: string): boolean {
  return /^[\-－]?[0-9０-９]+[\-－]?$/u.test(text);
}

function isIsolatedCandidate(block: TextBlock, medianArea: number): boolean {
  const text = normalizedText(block.text);
  if (text.length === 0 || isPageNumberLike(text)) return false;

  const graphemeCount = countGraphemes(text);
  if (graphemeCount > 2 && !(isSymbolOnly(text) && graphemeCount <= 3)) return false;
  return medianArea <= 0 || area(block.bbox) <= medianArea * 0.6;
}

function hasNearbyBlock(block: TextBlock, others: readonly TextBlock[], medianHeight: number): boolean {
  const limit = Math.max(80, Math.max(block.bbox.width, block.bbox.height) * 8, medianHeight * 4);

  return others.some((other) => {
    if (other.id === block.id || !hasFinitePositiveBox(other)) return false;
    return boxDistance(block.bbox, other.bbox) <= limit;
  });
}

export function detectIsolatedBlocks(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const validBlocks = sortTextBlocksByOrder(blocks).filter(hasFinitePositiveBox);
  if (validBlocks.length < 3) return [];

  const medianArea = median(validBlocks.map((block) => area(block.bbox)));
  const medianHeight = median(validBlocks.map((block) => block.bbox.height));

  return validBlocks
    .filter((block) => isIsolatedCandidate(block, medianArea) && !hasNearbyBlock(block, validBlocks, medianHeight))
    .map((block) => {
      const text = normalizedText(block.text);
      return createStructureIssue("isolated_block", context, [block], text, {
        severity: "warning",
        title: "孤立した小さな BB",
        message: `短い BB が周囲の BB から離れています: 「${text}」`,
        suffix: `block-${block.id}`,
      });
    });
}

function createReadingOrderIssue(
  context: InspectionContext,
  blocks: readonly TextBlock[],
  title: string,
  message: string,
  suffix: string,
): InspectionIssue {
  return createStructureIssue("reading_order_anomaly", context, blocks, blocks.map((block) => block.text.trim()).join(""), {
    severity: "warning",
    title,
    message,
    suffix,
  });
}

function detectDuplicateOrders(blocks: readonly TextBlock[], context: InspectionContext): InspectionIssue[] {
  const byOrder = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (!Number.isFinite(block.order)) continue;
    const entries = byOrder.get(block.order) ?? [];
    entries.push(block);
    byOrder.set(block.order, entries);
  }

  const issues: InspectionIssue[] = [];
  for (const [order, entries] of byOrder) {
    if (entries.length < 2) continue;
    issues.push(createReadingOrderIssue(
      context,
      entries,
      "読み順番号が重複しています",
      `複数の BB に同じ読み順番号 ${order} が割り当てられています`,
      `duplicate-order-${order}`,
    ));
  }

  return issues;
}

function detectPairReadingOrder(previous: TextBlock, current: TextBlock, context: InspectionContext): InspectionIssue | null {
  if (
    previous.writingMode !== current.writingMode ||
    !hasFinitePositiveBox(previous) ||
    !hasFinitePositiveBox(current)
  ) {
    return null;
  }

  if (previous.writingMode === "vertical") {
    const tolerance = Math.max(4, ((previous.bbox.width + current.bbox.width) / 2) * 0.35);
    if (isSameVerticalColumn(previous.bbox, current.bbox) && current.bbox.y + tolerance < previous.bbox.y) {
      return createReadingOrderIssue(
        context,
        [previous, current],
        "読み順が列内で逆行しています",
        "同じ縦書き列で後続 BB が上方向に戻っています",
        `vertical-backtrack-${previous.id}-${current.id}`,
      );
    }

    const overlap = overlapRatio(verticalOverlap(previous.bbox, current.bbox), previous.bbox.height, current.bbox.height);
    if (overlap >= 0.6 && current.bbox.x > previous.bbox.x + tolerance) {
      return createReadingOrderIssue(
        context,
        [previous, current],
        "読み順が列方向で逆行しています",
        "縦書きの列移動が右方向に戻っています",
        `vertical-column-${previous.id}-${current.id}`,
      );
    }

    return null;
  }

  const tolerance = Math.max(4, ((previous.bbox.height + current.bbox.height) / 2) * 0.35);
  if (isSameHorizontalLine(previous.bbox, current.bbox) && current.bbox.x + tolerance < previous.bbox.x) {
    return createReadingOrderIssue(
      context,
      [previous, current],
      "読み順が行内で逆行しています",
      "同じ行で後続 BB が左方向に戻っています",
      `horizontal-backtrack-${previous.id}-${current.id}`,
    );
  }

  const overlap = overlapRatio(horizontalOverlap(previous.bbox, current.bbox), previous.bbox.width, current.bbox.width);
  if (overlap >= 0.6 && bottom(current.bbox) + tolerance < previous.bbox.y) {
    return createReadingOrderIssue(
      context,
      [previous, current],
      "読み順が行方向で逆行しています",
      "同じ列幅で後続 BB が上方向に戻っています",
      `horizontal-line-${previous.id}-${current.id}`,
    );
  }

  return null;
}

function pageDistanceLimit(context: InspectionContext, medianHeight: number): number {
  const pageWidth = typeof context.pageWidth === "number" && context.pageWidth > 0 ? context.pageWidth : 0;
  const pageHeight = typeof context.pageHeight === "number" && context.pageHeight > 0 ? context.pageHeight : 0;
  const pageBased = pageWidth > 0 || pageHeight > 0
    ? Math.hypot(pageWidth, pageHeight) * 0.22
    : 0;
  return Math.max(160, medianHeight * 10, pageBased);
}

function detectDistantAdjacentOrder(
  orderedBlocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const validBlocks = orderedBlocks.filter(hasFinitePositiveBox);
  const medianHeight = median(validBlocks.map((block) => block.bbox.height));
  const limit = pageDistanceLimit(context, medianHeight);
  const issues: InspectionIssue[] = [];

  for (let index = 1; index < orderedBlocks.length; index++) {
    const previous = orderedBlocks[index - 1];
    const current = orderedBlocks[index];
    if (
      previous.writingMode !== current.writingMode ||
      !hasFinitePositiveBox(previous) ||
      !hasFinitePositiveBox(current) ||
      current.order !== previous.order + 1
    ) {
      continue;
    }

    const distance = boxDistance(previous.bbox, current.bbox);
    if (
      distance > limit &&
      !areNearbyInReadingOrder(previous, current, context.pageWidth, context.pageHeight)
    ) {
      issues.push(createReadingOrderIssue(
        context,
        [previous, current],
        "読み順で隣接する BB が離れています",
        "order は隣接していますが、座標上の距離が大きすぎます",
        `distant-adjacent-${previous.id}-${current.id}`,
      ));
    }
  }

  return issues;
}

function detectNearbyNonAdjacentOrder(
  orderedBlocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const issues: InspectionIssue[] = [];
  const usedPairs = new Set<string>();

  for (let aIndex = 0; aIndex < orderedBlocks.length; aIndex++) {
    const a = orderedBlocks[aIndex];
    if (!hasFinitePositiveBox(a)) continue;

    for (let bIndex = aIndex + 1; bIndex < orderedBlocks.length; bIndex++) {
      const b = orderedBlocks[bIndex];
      const orderGap = Math.abs(a.order - b.order);
      if (
        orderGap <= 2 ||
        a.writingMode !== b.writingMode ||
        !hasFinitePositiveBox(b) ||
        !areCharacterAdjacent(a, b)
      ) {
        continue;
      }

      const pairKey = [a.id, b.id].sort().join(":");
      if (usedPairs.has(pairKey)) continue;
      usedPairs.add(pairKey);

      issues.push(createReadingOrderIssue(
        context,
        [a, b],
        "近接する BB の読み順が離れています",
        `座標上は近接していますが、order が ${orderGap} 離れています`,
        `near-non-adjacent-${a.id}-${b.id}`,
      ));
    }
  }

  return issues;
}

export function detectReadingOrderAnomalies(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const orderedBlocks = sortTextBlocksByOrder(blocks);
  const issues = detectDuplicateOrders(orderedBlocks, context);

  for (let index = 1; index < orderedBlocks.length; index++) {
    const issue = detectPairReadingOrder(orderedBlocks[index - 1], orderedBlocks[index], context);
    if (issue) issues.push(issue);
  }

  issues.push(...detectDistantAdjacentOrder(orderedBlocks, context));
  issues.push(...detectNearbyNonAdjacentOrder(orderedBlocks, context));

  return issues;
}
