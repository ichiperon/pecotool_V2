/**
 * キーボードイベントの target が編集中/操作中の要素（フォーム・テキスト入力系・
 * キーボード操作可能なウィジェット）かどうかを判定する。
 *
 * input / textarea / select / [contenteditable]（属性 or isContentEditable プロパティ）/
 * [role="gridcell"]（CSV テーブルのセル）/ [role="separator"][tabindex]
 * （ConfirmLayout のキーボード操作可能なスプリッタ）の場合に true を返す。
 * target が DOM Element でない場合（window 等）は false を返す。
 *
 * #434 F1: 元は OffsetAdjustOverlay 側にインラインの許可リストがあったが、
 * CsvPreviewTable の gridcell や ConfirmLayout のスプリッタを素通しし、
 * adjustOffset モード中の矢印キーが二重発火してページオフセットを破壊していた。
 * 判定をこの共通実装に一本化する（isContentEditable プロパティ判定は元のインライン
 * 実装との互換のため closest("[contenteditable]") に加えて維持）。
 */
export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest("[contenteditable]") !== null ||
    (target instanceof HTMLElement && target.isContentEditable) ||
    target.closest('[role="gridcell"]') !== null ||
    target.closest('[role="separator"][tabindex]') !== null
  );
}
