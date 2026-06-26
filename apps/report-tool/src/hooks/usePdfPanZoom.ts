import { useEffect, type RefObject } from "react";
import { usePdfStore } from "../store/pdfStore";
import { isEditingTarget } from "../lib/isEditingTarget";

/**
 * PDF ビューアのパン（スペース+ドラッグ）と Ctrl+ホイールズームを提供する hook。
 *
 * - Ctrl+ホイール: ブラウザズームを抑止しつつ store.zoom を ±10 する。
 * - スペース+ドラッグ: コンテナをスクロールするハンドツール。
 *   オーバーレイの欄定義/オフセット drag と衝突しないよう
 *   mousedown を capture フェーズで捕捉し、armed 時のみ stopPropagation する。
 *
 * @param containerRef - canvas-area の div への ref
 */
export function usePdfPanZoom(
  containerRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ---- パン用の内部状態（useRef の代わりにクロージャ変数） ----
    let armed = false;   // Space 押下中
    let panning = false; // マウスドラッグ中
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    // ---- Ctrl+ホイールズーム ----
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const store = usePdfStore.getState();
      const delta = e.deltaY < 0 ? 10 : -10;
      store.setZoom(store.zoom + delta);
      store.setFitMode("custom");
    };

    // passive:false が必須（passive:true だと preventDefault が無効でブラウザズームを止められない）
    container.addEventListener("wheel", handleWheel, { passive: false });

    // ---- スペース管理（window レベル） ----
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      // 編集中は Space を入力として通す
      if (isEditingTarget(e.target)) return;
      // ボタン/リンクにフォーカス中は Space を本来の活性化キーとして通す
      // （パンに奪うと focused button が Space で発火しなくなる: WCAG 2.1.1）
      if (
        e.target instanceof Element &&
        e.target.closest('button, a, [role="button"]')
      ) {
        return;
      }
      if (armed) return; // 既に armed なら二重処理しない
      e.preventDefault(); // ページスクロール抑止
      armed = true;
      container.style.cursor = "grab";
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      armed = false;
      if (panning) {
        panning = false;
        container.style.userSelect = "";
      }
      container.style.cursor = "";
    };

    // ---- マウスダウン（capture フェーズ）----
    // capture フェーズで登録することで、オーバーレイ(FieldOverlayCanvas等)の
    // mousedown より先に受け取り、armed 時だけ stopPropagation できる。
    const handleMouseDown = (e: MouseEvent) => {
      if (!armed) return; // armed でないときは何もしない（通常のオーバーレイ操作に通す）
      e.preventDefault();
      e.stopPropagation();
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = container.scrollLeft;
      startScrollTop = container.scrollTop;
      container.style.cursor = "grabbing";
      container.style.userSelect = "none";
    };

    // capture: true で登録
    container.addEventListener("mousedown", handleMouseDown, { capture: true });

    // ---- マウス移動（パン中） ----
    const handleMouseMove = (e: MouseEvent) => {
      if (!panning) return;
      container.scrollLeft = startScrollLeft - (e.clientX - startX);
      container.scrollTop = startScrollTop - (e.clientY - startY);
    };

    // ---- マウスアップ（パン終了） ----
    const handleMouseUp = () => {
      if (!panning) return;
      panning = false;
      container.style.userSelect = "";
      // armed のままなら grab、そうでなければ通常カーソルに戻す
      container.style.cursor = armed ? "grab" : "";
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      // アンマウント時にカーソルをリセット
      container.style.cursor = "";
      container.style.userSelect = "";
    };
  }, [containerRef]);
}
