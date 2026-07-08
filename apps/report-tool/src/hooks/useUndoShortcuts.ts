import { useEffect } from "react";
import { useReportStore } from "../store/reportStore";

/**
 * エディタ操作（セル編集・削除・移動・段操作・オフセット調整）の Undo/Redo
 * キーボードショートカットを window に登録する hook。
 *
 * Ctrl(Meta)+Z = 元に戻す / Ctrl(Meta)+Y・Ctrl(Meta)+Shift+Z = やり直す
 *
 * ガード:
 * - テキスト入力中（input/textarea/select/contenteditable）はブラウザネイティブの
 *   undo（入力欄内のテキスト取り消し）を優先し、グローバル undo は発火しない。
 *   isEditingTarget は使わない — あれは [role="gridcell"]（セルにフォーカスした
 *   ナビゲーション状態）も true にするが、セル削除・値移動・段操作の直後こそ
 *   Ctrl+Z が必要で、そのときフォーカスは gridcell にある。
 * - IME 変換中（isComposing / keyCode 229）は何もしない
 *   （CsvPreviewTable の既存ガードパターンと同じ二重判定）。
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest("[contenteditable]") !== null ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * @param enabled false のときはリスナーを登録しない。
 *   undo 対象（セル・オフセット）が見える画面でのみ有効化することで、
 *   別ステップ表示中の Ctrl+Z が「見えないデータを無言で巻き戻す」遠隔作用を防ぐ。
 */
export function useUndoShortcuts(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      if (!isUndo && !isRedo) return;

      if (e.isComposing || e.keyCode === 229) return;
      if (isTextEntryTarget(e.target)) return;

      e.preventDefault();
      const store = useReportStore.getState();
      if (isUndo) {
        store.undo();
      } else {
        store.redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled]); // store は getState() で都度取得するため enabled のみ依存
}
