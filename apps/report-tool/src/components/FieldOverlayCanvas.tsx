import { useEffect, useRef, useCallback, type FC } from "react";
import { useReportStore } from "../store/reportStore";
import type { OverlayGeom } from "../types/overlay";
import { dragToPageRect, pageRectToDevice } from "../lib/coordinates";

interface Props {
  geom: OverlayGeom | null;
}

/**
 * PDF canvas と同一サイズで絶対配置する overlay canvas。
 * defineField モード中のみポインタイベントを受け付ける。
 *
 * ドラッグ state machine: idle → pressed → dragging → commit
 *
 * 座標はすべて page 座標（scale=1.0, y 下方向）で保持する。
 * 物理px変換は描画時のみ coordinates.ts 純関数を使用する。
 */
const FieldOverlayCanvas: FC<Props> = ({ geom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // store から直接購読（propsバケツリレー回避）
  const fields = useReportStore((s) => s.template.fields);
  const selectedFieldId = useReportStore((s) => s.selectedFieldId);
  const mode = useReportStore((s) => s.mode);
  const addField = useReportStore((s) => s.addField);

  // ドラッグ state machine 用 ref（setStateを使わずmoveハンドラ内で直接redrawする）
  const dragStateRef = useRef<{
    phase: "idle" | "pressed" | "dragging";
    startClient: { x: number; y: number };
    currentClient: { x: number; y: number };
    canvasRect: { left: number; top: number };
  }>({
    phase: "idle",
    startClient: { x: 0, y: 0 },
    currentClient: { x: 0, y: 0 },
    canvasRect: { left: 0, top: 0 },
  });

  // 全消去 → 全欄 → ハイライト → ドラッグ中ラバーバンドを一括描画する。
  // canvas.width代入は内容クリアするため、geom変化のeffect後に必ず呼び出す。
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geom) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { deviceWidth, deviceHeight, dpr } = geom;
    const params = { zoom: geom.zoom, dpr };

    // 全消去
    ctx.clearRect(0, 0, deviceWidth, deviceHeight);

    // 既存欄を描画
    for (const field of fields) {
      const isSelected = field.id === selectedFieldId;

      // page座標 → device(物理px)座標変換は coordinates.ts 純関数経由（不変条件3）
      const d = pageRectToDevice(field.rect, params);

      // 塗り（半透明）
      ctx.fillStyle = field.color + "33";
      ctx.fillRect(d.x, d.y, d.width, d.height);

      // 枠線
      ctx.strokeStyle = field.color;
      ctx.lineWidth = isSelected ? 4 * dpr : 2 * dpr;
      ctx.setLineDash([]);
      ctx.strokeRect(d.x, d.y, d.width, d.height);

      // 選択時に外側のアウトライン
      if (isSelected) {
        ctx.strokeStyle = field.color;
        ctx.lineWidth = 1 * dpr;
        ctx.strokeRect(d.x - dpr, d.y - dpr, d.width + 2 * dpr, d.height + 2 * dpr);
      }

      // ラベルチップ（矩形左上に欄名を表示）
      const fontSize = 12 * dpr;
      ctx.font = `${fontSize}px sans-serif`;
      const labelText = field.name;
      const textMetrics = ctx.measureText(labelText);
      const padX = 3 * dpr;
      const padY = 2 * dpr;
      const chipW = textMetrics.width + padX * 2;
      const chipH = fontSize + padY * 2;

      // 半透明白背景チップ（d.x/d.y は pageRectToDevice で得た device 座標）
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(d.x, d.y, chipW, chipH);

      // テキスト
      ctx.fillStyle = "#333333";
      ctx.fillText(labelText, d.x + padX, d.y + padY + fontSize * 0.85);
    }

    // ドラッグ中のラバーバンドを描画
    const ds = dragStateRef.current;
    if (ds.phase === "dragging") {
      // page座標の矩形を得てから pageRectToDevice で device 座標に変換（不変条件3）
      const pageRect = dragToPageRect(ds.startClient, ds.currentClient, ds.canvasRect, params);
      const rb = pageRectToDevice(pageRect, params);

      ctx.strokeStyle = "#2b6cb0";
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(rb.x, rb.y, rb.width, rb.height);

      ctx.fillStyle = "rgba(66,153,225,0.1)";
      ctx.fillRect(rb.x, rb.y, rb.width, rb.height);

      ctx.setLineDash([]);
    }
  }, [geom, fields, selectedFieldId]);

  // geom変化時に canvas サイズを PDF canvas と完全同期してから redraw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geom) return;

    canvas.width = geom.deviceWidth;
    canvas.height = geom.deviceHeight;
    canvas.style.width = `${geom.deviceWidth / geom.dpr}px`;
    canvas.style.height = `${geom.deviceHeight / geom.dpr}px`;

    // canvas.width 代入で内容がクリアされるので必ず再描画
    redraw();
  }, [geom, redraw]);

  // fields / selectedFieldId / mode が変わったときも再描画
  useEffect(() => {
    redraw();
  }, [redraw]);

  // ポインタイベントハンドラ

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode !== "defineField") return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      // getBoundingClientRect をドラッグ開始時に1回だけ取得してキャッシュ
      const rect = canvas.getBoundingClientRect();

      dragStateRef.current = {
        phase: "pressed",
        startClient: { x: e.clientX, y: e.clientY },
        currentClient: { x: e.clientX, y: e.clientY },
        canvasRect: { left: rect.left, top: rect.top },
      };

      canvas.setPointerCapture(e.pointerId);
    },
    [mode]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const ds = dragStateRef.current;
      if (ds.phase === "idle") return;

      const dx = e.clientX - ds.startClient.x;
      const dy = e.clientY - ds.startClient.y;

      if (ds.phase === "pressed" && Math.hypot(dx, dy) >= 5) {
        dragStateRef.current = {
          ...ds,
          phase: "dragging",
          currentClient: { x: e.clientX, y: e.clientY },
        };
      } else if (ds.phase === "dragging") {
        dragStateRef.current = {
          ...ds,
          currentClient: { x: e.clientX, y: e.clientY },
        };
      }

      // state を介さずに直接 redraw（毎フレーム setState 回避）
      if (dragStateRef.current.phase === "dragging") {
        redraw();
      }
    },
    [redraw]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const ds = dragStateRef.current;
      const canvas = canvasRef.current;

      if (canvas) {
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // キャプチャが既に解放済みの場合は無視
        }
      }

      if (ds.phase === "dragging" && geom) {
        const params = { zoom: geom.zoom, dpr: geom.dpr };
        const rect = dragToPageRect(
          ds.startClient,
          ds.currentClient,
          ds.canvasRect,
          params
        );

        // 誤クリック破棄（5px 閾値は pointerMove で pressed → dragging の昇格が行われなかったケース）
        if (rect.width > 0 && rect.height > 0) {
          addField(rect);
        }
      }
      // defineFieldモードは維持したまま idle に戻す（連続定義）
      dragStateRef.current = {
        phase: "idle",
        startClient: { x: 0, y: 0 },
        currentClient: { x: 0, y: 0 },
        canvasRect: { left: 0, top: 0 },
      };
      redraw();
    },
    [geom, addField, redraw]
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
      dragStateRef.current = {
        phase: "idle",
        startClient: { x: 0, y: 0 },
        currentClient: { x: 0, y: 0 },
        canvasRect: { left: 0, top: 0 },
      };
      redraw();
    },
    [redraw]
  );

  // Escape キーでドラッグ中の操作を破棄
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const ds = dragStateRef.current;
        if (ds.phase !== "idle") {
          // pointerup/cancel と対称に pointer capture を解放する（リーク保険）
          // pointerId は Escape 時点では取得できないため hasPointerCapture で走査する
          const canvas = canvasRef.current;
          if (canvas) {
            try {
              // ブラウザが管理する active pointer の capture を強制解放する。
              // pointerId が不明なため 0〜10 の範囲を試みる（実用上 1〜2 で十分）。
              for (let id = 0; id <= 10; id++) {
                if (canvas.hasPointerCapture(id)) {
                  canvas.releasePointerCapture(id);
                }
              }
            } catch {
              // ignore: キャプチャ未取得時の例外は無視
            }
          }
          dragStateRef.current = {
            phase: "idle",
            startClient: { x: 0, y: 0 },
            currentClient: { x: 0, y: 0 },
            canvasRect: { left: 0, top: 0 },
          };
          redraw();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redraw]);

  return (
    <canvas
      ref={canvasRef}
      className="pdf-viewer__overlay-canvas"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        // defineField モードのみポインタイベントを有効化
        pointerEvents: mode === "defineField" ? "auto" : "none",
        cursor: mode === "defineField" ? "crosshair" : "default",
      }}
      aria-hidden="true"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    />
  );
};

export default FieldOverlayCanvas;
