/**
 * キーボードイベントの target が編集中の要素（フォーム・テキスト入力系）かどうかを判定する。
 *
 * input / textarea / select / [contenteditable] / [role="gridcell"] の場合に true を返す。
 * target が DOM Element でない場合（window 等）は false を返す。
 */
export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest("[contenteditable]") !== null ||
    target.closest('[role="gridcell"]') !== null
  );
}
