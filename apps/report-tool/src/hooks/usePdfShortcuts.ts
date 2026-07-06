import { useEffect } from "react";
import { usePdfStore } from "../store/pdfStore";
import { useReportStore } from "../store/reportStore";
import { isEditingTarget } from "../lib/isEditingTarget";

/**
 * PDF ビューアのキーボードショートカットを window に登録する hook。
 *
 * ページ移動: PageDown/ArrowDown/ArrowRight=次ページ,
 *             PageUp/ArrowUp/ArrowLeft=前ページ,
 *             Home=先頭ページ, End=末尾ページ
 *             （ページ移動キーは preventDefault してコンテナのスクロールとの
 *              二重動作を防ぐ。長いページのスクロールはホイール/スクロールバーで行う）
 * ズーム: Ctrl(Meta)+=拡大25%, Ctrl(Meta)--=縮小25%, Ctrl(Meta)+0=幅フィット
 *
 * 編集ガード: input/textarea/select/[contenteditable]/[role=gridcell] 内では
 * ページ移動ショートカットを無効化する（Ctrl系ズームはブラウザズーム抑止のため動作する）。
 *
 * 実装ノート: store の各値はクロージャキャプチャを避けるため useEffect 内で
 * usePdfStore.getState() から都度取得する。
 */
export function usePdfShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;

      const isEditing = isEditingTarget(target);

      const isCtrl = e.ctrlKey || e.metaKey;

      const store = usePdfStore.getState();

      // Ctrl系ズームショートカット（編集中でもブラウザズーム抑止のために処理）
      if (isCtrl) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          store.setZoom(store.zoom + 25);
          store.setFitMode("custom");
          return;
        }
        if (e.key === "-") {
          e.preventDefault();
          store.setZoom(store.zoom - 25);
          store.setFitMode("custom");
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          store.setFitMode("width");
          return;
        }
      }

      // 編集中はページ移動を無効化
      if (isEditing) return;

      // オフセット調整モード中は矢印キーを OffsetAdjustOverlay の nudge に譲る。
      // 両者が同じ window keydown を購読しており、ここで矢印を処理すると欄を
      // 微調整するたびにページ移動が二重発火する（PCT-160 / #390）。
      // Page系/Home/End は nudge と競合しないので従来どおり通す。
      const isArrowKey =
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight";
      if (isArrowKey && useReportStore.getState().mode === "adjustOffset") {
        return;
      }

      switch (e.key) {
        case "PageDown":
        case "ArrowDown":
        case "ArrowRight":
          e.preventDefault();
          store.goToNextPage();
          break;
        case "PageUp":
        case "ArrowUp":
        case "ArrowLeft":
          e.preventDefault();
          store.goToPrevPage();
          break;
        case "Home":
          e.preventDefault();
          store.setCurrentPage(1);
          break;
        case "End":
          e.preventDefault();
          store.setCurrentPage(store.numPages);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []); // 依存配列は空: store は getState() で都度取得するため
}
