/**
 * セル編集ロジック（純関数）
 *
 * ページ内のセル値移動を担う。ページ跨ぎは構造上不可能（row は pageNum を持たない）。
 */

export type CellMoveMode = "swap" | "move";

/**
 * row（fieldId→value の Map）内で from の値を to へ再割当する。
 *
 * - mode="swap": from と to の値を交換する（既定）。to が空の場合は実質 move と同じ結果。
 * - mode="move": from の値を to へ移動し、from を空文字にする。
 *
 * from === to のときは row をそのまま返す（参照同一・no-op）。
 * 元の row は破壊しない（新しい Map を返す）。
 */
export function applyCellMove(
  row: Map<string, string>,
  fromFieldId: string,
  toFieldId: string,
  mode: CellMoveMode
): Map<string, string> {
  if (fromFieldId === toFieldId) {
    return row;
  }

  const vFrom = row.get(fromFieldId) ?? "";
  const vTo = row.get(toFieldId) ?? "";

  const next = new Map(row);
  next.set(toFieldId, vFrom);
  next.set(fromFieldId, mode === "swap" ? vTo : "");

  return next;
}
