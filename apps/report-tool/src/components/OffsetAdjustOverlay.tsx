import { useEffect, useRef, useCallback, type FC } from "react";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import type { OverlayGeom } from "../types/overlay";
import { effectiveRectForPage } from "../logic/pageOffset";
import { pageRectToDevice, clientPointToPage } from "../lib/coordinates";
import { ZERO_OFFSET } from "../types/report";
import { isEditingTarget } from "../lib/isEditingTarget";

interface Props {
  geom: OverlayGeom | null;
}

/**
 * 確認画面（ステップ3）専用のオフセット調整オーバーレイ。
 *
 * FieldOverlayCanvas（defineField 専用）とは完全に分離した責務：
 * - 欄を新規追加しない
 * - 既存欄を pageOffsets を適用した位置に描画する
 * - adjustOffset モード時のみポインタ有効（オーバーレイ全体をドラッグ → setPageOffset）
 * - 矢印キー: ±1px nudgePageOffset / Shift+矢印: ±10px
 *
 * 座標変換はすべて coordinates.ts 純関数経由（不変条件維持）。
 */
const OffsetAdjustOverlay: FC<Props> = ({ geom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fields = useReportStore((s) => s.template.fields);
  const mode = useReportStore((s) => s.mode);
  const pageOffsets = useReportStore((s) => s.pageOffsets);
  const setPageOffset = useReportStore((s) => s.setPageOffset);
  const nudgePageOffset = useReportStore((s) => s.nudgePageOffset);
  const currentPage = usePdfStore((s) => s.currentPage);

  const isAdjusting = mode === "adjustOffset";

  // ドラッグ状態（ref で持つ・再レンダ不要）
  const dragRef = useRef<{
    phase: "idle" | "pressed" | "dragging";
    startClient: { x: number; y: number };
    currentClient: { x: number; y: number };
    canvasRect: { left: number; top: number };
    baseOffset: { dx: number; dy: number };
  }>({
    phase: "idle",
    startClient: { x: 0, y: 0 },
    currentClient: { x: 0, y: 0 },
    canvasRect: { left: 0, top: 0 },
    baseOffset: { dx: 0, dy: 0 },
  });

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geom) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { deviceWidth, deviceHeight, dpr } = geom;
    const params = { zoom: geom.zoom, dpr };

    ctx.clearRect(0, 0, deviceWidth, deviceHeight);

    const offset = pageOffsets.get(currentPage) ?? ZERO_OFFSET;

    // ドラッグ中は一時オフセットを上乗せして描画
    let renderOffset = offset;
    const ds = dragRef.current;
    if (ds.phase === "dragging" && geom) {
      const startPage = clientPointToPage(ds.startClient, ds.canvasRect, params);
      const curPage = clientPointToPage(ds.currentClient, ds.canvasRect, params);
      const ddx = curPage.x - startPage.x;
      const ddy = curPage.y - startPage.y;
      renderOffset = {
        dx: ds.baseOffset.dx + ddx,
        dy: ds.baseOffset.dy + ddy,
      };
    }

    const isDragging = ds.phase === "dragging";

    for (const field of fields) {
      const effectiveRect = effectiveRectForPage(field.rect, renderOffset);
      const d = pageRectToDevice(effectiveRect, params);

      // 塗り（半透明）
      ctx.fillStyle = field.color + "33";
      ctx.fillRect(d.x, d.y, d.width, d.height);

      // 枠線（ドラッグ中は破線で「動かし中」を明示）
      ctx.strokeStyle = field.color;
      ctx.lineWidth = 2 * dpr;
      if (isDragging) {
        ctx.setLineDash([6 * dpr, 4 * dpr]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeRect(d.x, d.y, d.width, d.height);
      ctx.setLineDash([]);

      // ラベルチップ
      const fontSize = 12 * dpr;
      ctx.font = `${fontSize}px sans-serif`;
      const labelText = field.name;
      const textMetrics = ctx.measureText(labelText);
      const padX = 3 * dpr;
      const padY = 2 * dpr;
      const chipW = textMetrics.width + padX * 2;
      const chipH = fontSize + padY * 2;

      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(d.x, d.y, chipW, chipH);

      ctx.fillStyle = "#333333";
      ctx.fillText(labelText, d.x + padX, d.y + padY + fontSize * 0.85);
    }
  }, [geom, fields, pageOffsets, currentPage]);

  // geom 変化時にサイズ同期 + 再描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geom) return;

    canvas.width = geom.deviceWidth;
    canvas.height = geom.deviceHeight;
    canvas.style.width = `${geom.deviceWidth / geom.dpr}px`;
    canvas.style.height = `${geom.deviceHeight / geom.dpr}px`;

    redraw();
  }, [geom, redraw]);

  // fields / pageOffsets / mode / currentPage 変化時も再描画
  useEffect(() => {
    redraw();
  }, [redraw]);

  // ポインタイベント
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isAdjusting) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const offset = pageOffsets.get(currentPage) ?? ZERO_OFFSET;

      dragRef.current = {
        phase: "pressed",
        startClient: { x: e.clientX, y: e.clientY },
        currentClient: { x: e.clientX, y: e.clientY },
        canvasRect: { left: rect.left, top: rect.top },
        baseOffset: { dx: offset.dx, dy: offset.dy },
      };

      canvas.setPointerCapture(e.pointerId);
    },
    [isAdjusting, pageOffsets, currentPage]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const ds = dragRef.current;
      if (ds.phase === "idle") return;

      const dx = e.clientX - ds.startClient.x;
      const dy = e.clientY - ds.startClient.y;

      if (ds.phase === "pressed" && Math.hypot(dx, dy) >= 5) {
        dragRef.current = {
          ...ds,
          phase: "dragging",
          currentClient: { x: e.clientX, y: e.clientY },
        };
      } else if (ds.phase === "dragging") {
        dragRef.current = {
          ...ds,
          currentClient: { x: e.clientX, y: e.clientY },
        };
      }

      if (dragRef.current.phase === "dragging") {
        redraw();
      }
    },
    [redraw]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const ds = dragRef.current;
      const canvas = canvasRef.current;

      if (canvas) {
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }

      if (ds.phase === "dragging" && geom) {
        const params = { zoom: geom.zoom, dpr: geom.dpr };
        const startPage = clientPointToPage(ds.startClient, ds.canvasRect, params);
        const endPage = clientPointToPage(ds.currentClient, ds.canvasRect, params);
        const ddx = endPage.x - startPage.x;
        const ddy = endPage.y - startPage.y;

        const newDx = Math.round(ds.baseOffset.dx + ddx);
        const newDy = Math.round(ds.baseOffset.dy + ddy);
        setPageOffset(currentPage, newDx, newDy);
      }

      dragRef.current = {
        phase: "idle",
        startClient: { x: 0, y: 0 },
        currentClient: { x: 0, y: 0 },
        canvasRect: { left: 0, top: 0 },
        baseOffset: { dx: 0, dy: 0 },
      };
      redraw();
    },
    [geom, setPageOffset, currentPage, redraw]
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas) {
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      dragRef.current = {
        phase: "idle",
        startClient: { x: 0, y: 0 },
        currentClient: { x: 0, y: 0 },
        canvasRect: { left: 0, top: 0 },
        baseOffset: { dx: 0, dy: 0 },
      };
      redraw();
    },
    [redraw]
  );

  // キーボード: 矢印キーで nudgePageOffset
  useEffect(() => {
    if (!isAdjusting) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // MA-4 (#434 F1): 入力要素・CSVテーブルの gridcell・ConfirmLayout のスプリッタに
      // フォーカス中は矢印キーをその場の操作用として扱い、nudgePageOffset には流さない
      // （フォーム操作/CSVセルナビ/スプリッタ幅調整との二重発火防止）。
      // 判定は usePdfShortcuts/usePdfPanZoom と同じ isEditingTarget に統一。
      if (isEditingTarget(e.target)) {
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudgePageOffset(currentPage, -step, 0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nudgePageOffset(currentPage, step, 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        nudgePageOffset(currentPage, 0, -step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        nudgePageOffset(currentPage, 0, step);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAdjusting, currentPage, nudgePageOffset]);

  return (
    <canvas
      ref={canvasRef}
      className="pdf-viewer__overlay-canvas"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: isAdjusting ? "auto" : "none",
        cursor: isAdjusting ? "grab" : "default",
      }}
      aria-hidden="true"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    />
  );
};

export default OffsetAdjustOverlay;
