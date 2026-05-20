import type { TextBlock } from "../../types";
import { sortTextBlocksByOrder, unionBlockBoxes } from "./geometry";
import { splitGraphemes } from "./text";
import type { InspectionContext, InspectionIssue } from "./types";
import { makeInspectionIssueId } from "./types";

export const SYMBOL_PAIRS = new Map<string, string>([
  ["（", "）"],
  ["(", ")"],
  ["「", "」"],
  ["『", "』"],
  ["【", "】"],
  ["[", "]"],
  ["〔", "〕"],
  ["〈", "〉"],
  ["《", "》"],
]);

const CLOSING_TO_OPENING = new Map(
  Array.from(SYMBOL_PAIRS.entries(), ([opening, closing]) => [closing, opening]),
);

const LINE_START_SYMBOLS = new Set(["、", "。", "）", "」"]);
const LINE_END_SYMBOLS = new Set(["「", "（"]);

interface SymbolStackEntry {
  opening: string;
  expectedClosing: string;
  block: TextBlock;
  offset: number;
}

function createSymbolIssue(
  context: InspectionContext,
  blocks: readonly TextBlock[],
  text: string,
  suffix: string,
  title: string,
  message: string,
): InspectionIssue {
  const blockIds = Array.from(new Set(blocks.map((block) => block.id)));
  return {
    id: makeInspectionIssueId("symbol_structure", context.pageIndex, blockIds, suffix),
    pageIndex: context.pageIndex,
    category: "symbol_structure",
    severity: "warning",
    title,
    message,
    blockIds,
    bbox: unionBlockBoxes(blocks),
    text,
    ignored: false,
  };
}

function findLastMatchingStackIndex(stack: readonly SymbolStackEntry[], closing: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].expectedClosing === closing) return index;
  }
  return -1;
}

function detectLineBoundarySymbols(block: TextBlock, context: InspectionContext): InspectionIssue[] {
  const trimmed = block.text.trim();
  if (trimmed.length === 0) return [];

  const graphemes = splitGraphemes(trimmed);
  const first = graphemes[0];
  const last = graphemes[graphemes.length - 1];
  const issues: InspectionIssue[] = [];

  if (LINE_START_SYMBOLS.has(first)) {
    issues.push(createSymbolIssue(
      context,
      [block],
      first,
      `line-start-${block.id}`,
      "行頭の記号構造が不自然です",
      `行頭が「${first}」で始まっています`,
    ));
  }

  if (LINE_END_SYMBOLS.has(last)) {
    issues.push(createSymbolIssue(
      context,
      [block],
      last,
      `line-end-${block.id}`,
      "行末の記号構造が不自然です",
      `行末が「${last}」で終わっています`,
    ));
  }

  return issues;
}

export function detectSymbolStructure(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const issues: InspectionIssue[] = [];
  const stack: SymbolStackEntry[] = [];

  for (const block of sortTextBlocksByOrder(blocks)) {
    issues.push(...detectLineBoundarySymbols(block, context));

    const graphemes = splitGraphemes(block.text);
    for (let offset = 0; offset < graphemes.length; offset++) {
      const grapheme = graphemes[offset];
      const expectedClosing = SYMBOL_PAIRS.get(grapheme);
      if (expectedClosing) {
        stack.push({ opening: grapheme, expectedClosing, block, offset });
        continue;
      }

      if (!CLOSING_TO_OPENING.has(grapheme)) continue;

      const top = stack[stack.length - 1];
      if (!top) {
        issues.push(createSymbolIssue(
          context,
          [block],
          grapheme,
          `close-only-${block.id}-${offset}`,
          "対応する開き記号がありません",
          `閉じ記号「${grapheme}」に対応する開き記号がありません`,
        ));
        continue;
      }

      if (top.expectedClosing === grapheme) {
        stack.pop();
        continue;
      }

      const matchingIndex = findLastMatchingStackIndex(stack, grapheme);
      if (matchingIndex >= 0) {
        const mismatchedEntries = stack.slice(matchingIndex);
        issues.push(createSymbolIssue(
          context,
          [...mismatchedEntries.map((entry) => entry.block), block],
          `${mismatchedEntries.map((entry) => entry.opening).join("")}${grapheme}`,
          `nesting-${block.id}-${offset}`,
          "記号の入れ子が崩れています",
          `記号の対応が崩れている可能性があります: 「${top.opening}」と「${grapheme}」`,
        ));
        stack.splice(matchingIndex);
        continue;
      }

      issues.push(createSymbolIssue(
        context,
        [block],
        grapheme,
        `close-only-${block.id}-${offset}`,
        "対応する開き記号がありません",
        `閉じ記号「${grapheme}」に対応する開き記号がありません`,
      ));
    }
  }

  for (const entry of stack) {
    issues.push(createSymbolIssue(
      context,
      [entry.block],
      entry.opening,
      `unclosed-${entry.block.id}-${entry.offset}`,
      "記号が閉じられていません",
      `開き記号「${entry.opening}」に対応する閉じ記号「${entry.expectedClosing}」がありません`,
    ));
  }

  return issues;
}
