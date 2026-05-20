import type { BoundingBox } from "../../types";

export type InspectionCategory =
  | "character_fragmentation"
  | "reading_order_anomaly"
  | "sentence_fragmentation"
  | "symbol_structure"
  | "isolated_block"
  | "duplicate_block"
  | "bbox_anomaly";

export type InspectionSeverity = "error" | "warning" | "info";

export interface InspectionIssue {
  id: string;
  pageIndex: number;
  category: InspectionCategory;
  severity: InspectionSeverity;
  title: string;
  message: string;
  blockIds: string[];
  bbox: BoundingBox;
  text: string;
  suggestion?: string;
  ignored: boolean;
}

export interface InspectionContext {
  pageIndex: number;
  pageWidth?: number;
  pageHeight?: number;
}

export type InspectionCheckOptions = Partial<Record<InspectionCategory, boolean>>;

export interface TextInspectionOptions {
  checks?: InspectionCheckOptions;
}

export type TextInspectionSkipReason = "text_not_extracted" | "no_text";

export interface TextInspectionRunResult {
  pageIndex: number;
  issues: InspectionIssue[];
  skippedReason?: TextInspectionSkipReason;
}

export function makeInspectionIssueId(
  category: InspectionCategory,
  pageIndex: number,
  blockIds: readonly string[],
  suffix: string,
): string {
  return `${category}:${pageIndex}:${blockIds.join(",")}:${suffix}`;
}
