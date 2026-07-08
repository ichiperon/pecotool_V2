import type { CellMatrix, ReportField } from "../types/report";
import type { ConfidenceMatrix } from "../store/reportStore";

/**
 * 「要確認セル」の列挙ロジック。
 *
 * CsvPreviewTable の可視化（低信頼ハイライト・空セル表示）と同じ判定基準で、
 * ドキュメント順（ページ昇順 → 段昇順 → 欄定義順）の位置リストを返す。
 * 「次の要確認セルへ」ナビゲーションと CSV 出力前の残件数サマリが共用する。
 */

/** OCR 低信頼と判定する confidence の閾値（この値以下で要確認）。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type ReviewTargetKind = "lowConfidence" | "empty";

export interface ReviewTarget {
  pageNum: number;
  rowIndex: number;
  fieldId: string;
  kind: ReviewTargetKind;
}

/**
 * 要確認セルをドキュメント順に列挙する。
 *
 * - 〃セル（固定欄の2段目以降）は編集対象外なのでスキップする
 * - 空セル（値なし・空文字）→ kind: "empty"
 * - 値があり confidence <= LOW_CONFIDENCE_THRESHOLD → kind: "lowConfidence"
 *   （手編集済みセルは confidence がクリアされるため自動的に対象外になる）
 */
export function listReviewTargets(
  cells: CellMatrix,
  confidences: ConfidenceMatrix,
  fields: ReportField[]
): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  const pageNumbers = Array.from(cells.keys()).sort((a, b) => a - b);

  for (const pageNum of pageNumbers) {
    const rows = cells.get(pageNum) ?? [];
    const confRows = confidences.get(pageNum);

    rows.forEach((row, rowIndex) => {
      for (const field of fields) {
        // 固定欄の2段目以降は〃セル（編集不可）なので対象外
        if (field.isLineItem !== true && rowIndex > 0) continue;

        const value = row.get(field.id) ?? "";
        if (value === "") {
          targets.push({ pageNum, rowIndex, fieldId: field.id, kind: "empty" });
          continue;
        }

        const conf = confRows?.[rowIndex]?.get(field.id);
        if (conf !== undefined && conf <= LOW_CONFIDENCE_THRESHOLD) {
          targets.push({ pageNum, rowIndex, fieldId: field.id, kind: "lowConfidence" });
        }
      }
    });
  }

  return targets;
}

/** kind 別の件数を数える（サマリチップ用）。 */
export function countReviewTargets(targets: ReviewTarget[]): {
  lowConfidence: number;
  empty: number;
} {
  let lowConfidence = 0;
  let empty = 0;
  for (const t of targets) {
    if (t.kind === "lowConfidence") lowConfidence++;
    else empty++;
  }
  return { lowConfidence, empty };
}
