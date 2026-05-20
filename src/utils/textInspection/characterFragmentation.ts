import type { TextBlock } from "../../types";
import { areCharacterAdjacent, areOrdersConsecutive, sortTextBlocksByOrder, unionBlockBoxes } from "./geometry";
import { countGraphemes, isSymbolOnly } from "./text";
import type { InspectionContext, InspectionIssue } from "./types";
import { makeInspectionIssueId } from "./types";

const MIN_FRAGMENT_RUN_LENGTH = 3;

function isSingleGraphemeBlock(block: TextBlock): boolean {
  const text = block.text.trim();
  return text.length > 0 && countGraphemes(text) === 1;
}

function canJoinFragmentRun(previous: TextBlock, next: TextBlock): boolean {
  return (
    previous.writingMode === next.writingMode &&
    isSingleGraphemeBlock(previous) &&
    isSingleGraphemeBlock(next) &&
    areOrdersConsecutive(previous, next) &&
    areCharacterAdjacent(previous, next)
  );
}

function createCharacterFragmentationIssue(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue | null {
  const text = blocks.map((block) => block.text.trim()).join("");
  if (isSymbolOnly(text)) return null;

  const blockIds = blocks.map((block) => block.id);
  return {
    id: makeInspectionIssueId("character_fragmentation", context.pageIndex, blockIds, "run"),
    pageIndex: context.pageIndex,
    category: "character_fragmentation",
    severity: "warning",
    title: "文字単位の BB 分断",
    message: `OCR の BB が文字ごとに分断されている可能性があります: 「${text}」`,
    blockIds,
    bbox: unionBlockBoxes(blocks),
    text,
    suggestion: "必要なら複数 BB を選択してグループ化してください",
    ignored: false,
  };
}

export function detectCharacterFragmentation(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const orderedBlocks = sortTextBlocksByOrder(blocks);
  const issues: InspectionIssue[] = [];
  let run: TextBlock[] = [];

  for (const block of orderedBlocks) {
    if (run.length === 0) {
      run = isSingleGraphemeBlock(block) ? [block] : [];
      continue;
    }

    const previous = run[run.length - 1];
    if (canJoinFragmentRun(previous, block)) {
      run.push(block);
      continue;
    }

    if (run.length >= MIN_FRAGMENT_RUN_LENGTH) {
      const issue = createCharacterFragmentationIssue(run, context);
      if (issue) issues.push(issue);
    }
    run = isSingleGraphemeBlock(block) ? [block] : [];
  }

  if (run.length >= MIN_FRAGMENT_RUN_LENGTH) {
    const issue = createCharacterFragmentationIssue(run, context);
    if (issue) issues.push(issue);
  }

  return issues;
}
