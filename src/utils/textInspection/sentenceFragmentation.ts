import type { TextBlock } from "../../types";
import { areNearbyInReadingOrder, sortTextBlocksByOrder, unionBlockBoxes } from "./geometry";
import { countGraphemes, hasSentenceTerminal } from "./text";
import type { InspectionContext, InspectionIssue } from "./types";
import { makeInspectionIssueId } from "./types";

const PARTICLE_ENDINGS = ["が", "を", "に", "で", "と", "の", "は", "も", "へ"];
const CONNECTIVE_ENDINGS = ["ため", "ので", "または", "および"];
const TERMINAL_ENDINGS = ["。", "？", "！", "?", "!", "」", "』", "）", ")"];

function endsWithContinuation(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.endsWith("、") ||
    PARTICLE_ENDINGS.some((ending) => trimmed.endsWith(ending)) ||
    CONNECTIVE_ENDINGS.some((ending) => trimmed.endsWith(ending))
  );
}

function endsWithTerminal(text: string): boolean {
  const trimmed = text.trim();
  return TERMINAL_ENDINGS.some((ending) => trimmed.endsWith(ending));
}

function startsWithExcludedPrefix(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length === 0 ||
    /^[。？！?!」』）)]/u.test(trimmed) ||
    /^[・\-※]/u.test(trimmed) ||
    /^[0-9０-９]+[.)．）]/u.test(trimmed) ||
    /^[第]?[0-9０-９一二三四五六七八九十]+[章節項]/u.test(trimmed)
  );
}

function areContinuousSentenceBlocks(a: TextBlock, b: TextBlock, context: InspectionContext): boolean {
  return areNearbyInReadingOrder(a, b, context.pageWidth, context.pageHeight);
}

function createSentenceIssue(
  blocks: readonly TextBlock[],
  context: InspectionContext,
  suffix: string,
): InspectionIssue {
  const blockIds = blocks.map((block) => block.id);
  const text = blocks.map((block) => block.text.trim()).join("");
  return {
    id: makeInspectionIssueId("sentence_fragmentation", context.pageIndex, blockIds, suffix),
    pageIndex: context.pageIndex,
    category: "sentence_fragmentation",
    severity: "info",
    title: "文単位の BB 分断",
    message: `読み順で隣接する BB が文中で分かれている可能性があります: 「${text}」`,
    blockIds,
    bbox: unionBlockBoxes(blocks),
    text,
    suggestion: "必要なら複数 BB を選択してグループ化してください",
    ignored: false,
  };
}

function isWeakRunBlock(block: TextBlock): boolean {
  const text = block.text.trim();
  const graphemeCount = countGraphemes(text);
  return graphemeCount > 1 && graphemeCount <= 8 && !startsWithExcludedPrefix(text) && !hasSentenceTerminal(text);
}

function detectWeakRuns(blocks: readonly TextBlock[], context: InspectionContext): InspectionIssue[] {
  const issues: InspectionIssue[] = [];
  let run: TextBlock[] = [];

  for (const block of blocks) {
    const previous = run[run.length - 1];
    const canAppend =
      isWeakRunBlock(block) &&
      (!previous || areContinuousSentenceBlocks(previous, block, context));

    if (canAppend) {
      run.push(block);
      continue;
    }

    if (run.length >= 3) issues.push(createSentenceIssue(run, context, "short-run"));
    run = isWeakRunBlock(block) ? [block] : [];
  }

  if (run.length >= 3) issues.push(createSentenceIssue(run, context, "short-run"));
  return issues;
}

export function detectSentenceFragmentation(
  blocks: readonly TextBlock[],
  context: InspectionContext,
): InspectionIssue[] {
  const orderedBlocks = sortTextBlocksByOrder(blocks);
  const issues: InspectionIssue[] = [];

  for (let index = 1; index < orderedBlocks.length; index++) {
    const previous = orderedBlocks[index - 1];
    const current = orderedBlocks[index];
    if (
      previous.writingMode === current.writingMode &&
      !endsWithTerminal(previous.text) &&
      endsWithContinuation(previous.text) &&
      !startsWithExcludedPrefix(current.text) &&
      areContinuousSentenceBlocks(previous, current, context)
    ) {
      issues.push(createSentenceIssue([previous, current], context, "strong"));
    }
  }

  if (issues.length > 0) return issues;
  return detectWeakRuns(orderedBlocks, context);
}
