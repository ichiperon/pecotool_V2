/**
 * aria-live 領域の再アナウンス保証ユーティリティ。
 *
 * aria-live は textContent が変化しないと再読み上げされないため、
 * 同一テキストを連続でセットする場合はゼロ幅スペースの有無をトグルして
 * DOM 上のテキストを毎回変化させる（表示・読み上げには影響しない）。
 * CsvPreviewTable の操作アナウンスと App の Undo フィードバックチップが共用する。
 */

/** ゼロ幅スペース (U+200B)。不可視かつスクリーンリーダーも無視する。 */
export const ZWSP = "​";

/** toggle=true のとき末尾に ZWSP を付け、同一テキストでも DOM 変化を保証する。 */
export function makeAnnouncement(text: string, toggle: boolean): string {
  return toggle ? `${text}${ZWSP}` : text;
}
