import type { PageData } from "../../types";
import { detectCharacterFragmentation } from "./characterFragmentation";
import { detectSentenceFragmentation } from "./sentenceFragmentation";
import {
  detectBboxAnomalies,
  detectDuplicateBlocks,
  detectIsolatedBlocks,
  detectReadingOrderAnomalies,
} from "./structure";
import { detectSymbolStructure } from "./symbolBalance";
import type { InspectionCategory, InspectionContext, TextInspectionOptions, TextInspectionRunResult } from "./types";

export * from "./types";
export * from "./geometry";
export * from "./characterFragmentation";
export * from "./sentenceFragmentation";
export * from "./symbolBalance";
export * from "./structure";

function isCheckEnabled(options: TextInspectionOptions, category: InspectionCategory): boolean {
  return options.checks?.[category] !== false;
}

export async function runTextInspection(
  pageData: PageData,
  options: TextInspectionOptions = {},
): Promise<TextInspectionRunResult> {
  const context: InspectionContext = {
    pageIndex: pageData.pageIndex,
    pageWidth: pageData.width,
    pageHeight: pageData.height,
  };

  if (pageData.isTextExtracted !== true && pageData.ocrCleared !== true) {
    return { pageIndex: pageData.pageIndex, issues: [], skippedReason: "text_not_extracted" };
  }

  if (pageData.textBlocks.length === 0) {
    return { pageIndex: pageData.pageIndex, issues: [], skippedReason: "no_text" };
  }

  const issues = [
    ...(isCheckEnabled(options, "bbox_anomaly")
      ? detectBboxAnomalies(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "duplicate_block")
      ? detectDuplicateBlocks(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "isolated_block")
      ? detectIsolatedBlocks(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "reading_order_anomaly")
      ? detectReadingOrderAnomalies(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "character_fragmentation")
      ? detectCharacterFragmentation(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "sentence_fragmentation")
      ? detectSentenceFragmentation(pageData.textBlocks, context)
      : []),
    ...(isCheckEnabled(options, "symbol_structure")
      ? detectSymbolStructure(pageData.textBlocks, context)
      : []),
  ];

  return { pageIndex: pageData.pageIndex, issues };
}
