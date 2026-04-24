import { useEffect, useRef } from "react";
import {
  usePecoStore,
  selectZoom,
  selectShowOcr,
  selectOcrOpacity,
  selectSelectedIds,
  selectIsDrawingMode,
  selectIsSplitMode,
  selectCurrentPage,
} from "../store/pecoStore";
import { classifyDirection, getDirectionLabel } from "../utils/bulkReorder";
import { usePdfRendering } from "../hooks/usePdfRendering";
import { useCanvasDrawing } from "../hooks/useCanvasDrawing";
import { useBlockDragResize } from "../hooks/useBlockDragResize";

interface PdfCanvasProps {
  pageIndex: number;
  disableDrawing?: boolean;
  onFirstRender?: () => void;
  onRenderComplete?: () => void;
}

export function PdfCanvas({ pageIndex, disableDrawing = false, onFirstRender, onRenderComplete }: PdfCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const renderOverlaysRef = useRef<(() => void) | null>(null);

  const document = usePecoStore((s) => s.document);
  const currentPage = usePecoStore(selectCurrentPage);
  const zoom = usePecoStore(selectZoom);
  const showOcr = usePecoStore(selectShowOcr);
  const ocrOpacity = usePecoStore(selectOcrOpacity);
  const selectedIds = usePecoStore(selectSelectedIds);
  const isDrawingMode = usePecoStore(selectIsDrawingMode);
  const isSplitMode = usePecoStore(selectIsSplitMode);
  const updatePageData = usePecoStore((s) => s.updatePageData);
  const toggleDrawingMode = usePecoStore((s) => s.toggleDrawingMode);
  const toggleSplitMode = usePecoStore((s) => s.toggleSplitMode);
  const toggleSelection = usePecoStore((s) => s.toggleSelection);
  const clearSelection = usePecoStore((s) => s.clearSelection);
  const pushAction = usePecoStore((s) => s.pushAction);

  const getPageData = () => document?.pages.get(pageIndex);

  const { pdfPage, loadError, setLoadError, retry } = usePdfRendering({
    pdfCanvasRef,
    overlayCanvasRef,
    wrapperRef,
    filePath: document?.filePath,
    totalPages: document?.totalPages,
    pageIndex,
    zoom,
    onFirstRender,
    onRenderComplete,
    renderOverlaysRef,
  });

  const drawing = useCanvasDrawing({
    pageIndex,
    zoom,
    getPageData,
    updatePageData,
    toggleDrawingMode,
    toggleSplitMode,
  });

  const drag = useBlockDragResize({
    pageIndex,
    zoom,
    selectedIds,
    getPageData,
    updatePageData,
    toggleSelection,
    pushAction,
  });

  const getMousePos = (e: React.MouseEvent) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  // 選択されたブロックへの自動スクロール
  useEffect(() => {
    if (selectedIds.size !== 1 || drag.draggedId) return;
    const selectedId = Array.from(selectedIds)[0];
    const pageData = currentPage;
    const block = pageData?.textBlocks.find((b) => b.id === selectedId);
    if (!block) return;

    const container = window.document.querySelector(".pdf-viewer-panel");
    if (!container) return;

    const scale = zoom / 100;
    const x = block.bbox.x * scale;
    const y = block.bbox.y * scale;
    const w = block.bbox.width * scale;
    const h = block.bbox.height * scale;

    const containerRect = container.getBoundingClientRect();
    const targetX = x - containerRect.width / 2 + w / 2;
    const targetY = y - containerRect.height / 2 + h / 2;

    container.scrollTo({
      left: Math.max(0, targetX),
      top: Math.max(0, targetY),
      behavior: "smooth",
    });
  }, [selectedIds, zoom, currentPage, pageIndex, drag.draggedId]);

  // Overlay Layer Rendering
  const overlayRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!overlayCanvasRef.current || !pdfPage) return;

    const renderOverlays = () => {
      if (!overlayCanvasRef.current) return;
      const canvas = overlayCanvasRef.current;
      const context = canvas.getContext("2d")!;

      context.clearRect(0, 0, canvas.width, canvas.height);

      const pageData = currentPage;
      if (showOcr && pageData && pageData.textBlocks) {
        pageData.textBlocks.forEach((block) => {
          const isSelected = selectedIds.has(block.id);
          context.strokeStyle = isSelected ? "rgba(0, 120, 255, 0.8)" : "rgba(255, 0, 0, 0.3)";
          context.lineWidth = isSelected ? 2 : 1;

          const x = block.bbox.x * (zoom / 100);
          const y = block.bbox.y * (zoom / 100);
          const w = block.bbox.width * (zoom / 100);
          const h = block.bbox.height * (zoom / 100);

          const inset = isSelected ? 0 : 1;

          const baseAlpha = isSelected ? Math.min(1.0, ocrOpacity * 2) : ocrOpacity;
          const fillAlpha = isSelected ? Math.min(0.4, ocrOpacity * 0.625) : ocrOpacity * 0.25;

          context.fillStyle = `rgba(${isSelected ? "0, 100, 255" : "0, 150, 255"}, ${fillAlpha})`;
          context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          context.strokeStyle = `rgba(${isSelected ? "0, 100, 255" : "255, 0, 0"}, ${
            isSelected ? Math.min(1.0, baseAlpha * 1.125) : baseAlpha
          })`;
          context.lineWidth = isSelected ? 2 : 1;
          context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          if (isSelected) {
            context.fillStyle = "white";
            context.strokeStyle = "rgba(0, 100, 255, 1)";
            const handleSize = 6;
            [
              [x, y],
              [x + w, y],
              [x, y + h],
              [x + w, y + h],
            ].forEach(([hx, hy]) => {
              context.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
              context.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
            });
          }

          if (block.text) {
            if (block.writingMode === "vertical") {
              const fontSize = Math.max(10, w * 0.8);
              context.save();
              context.font = `bold ${fontSize}px sans-serif`;
              context.textBaseline = "top";

              const textLen = block.text.length;
              const naturalHeight = textLen * fontSize;
              const sy = h / naturalHeight;

              context.translate(x + w, y + 2);
              context.scale(1, sy);
              context.rotate(Math.PI / 2);
              context.lineWidth = 3 / sy;
              context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
              context.strokeText(block.text, 0, 0);
              context.fillStyle = isSelected
                ? `rgba(0, 50, 255, ${baseAlpha})`
                : `rgba(255, 0, 0, ${baseAlpha})`;
              context.fillText(block.text, 0, 0);
              context.restore();
            } else {
              const fontSize = Math.max(10, h * 0.8);
              context.save();
              context.font = `bold ${fontSize}px sans-serif`;
              context.textBaseline = "top";

              const textWidth = context.measureText(block.text).width || 1;
              const sx = w / textWidth;

              context.translate(x, y + 2);
              context.scale(sx, 1);
              context.lineWidth = 3 / sx;
              context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
              context.strokeText(block.text, 0, 0);
              context.fillStyle = isSelected
                ? `rgba(0, 50, 255, ${baseAlpha})`
                : `rgba(255, 0, 0, ${baseAlpha})`;
              context.fillText(block.text, 0, 0);
              context.restore();
            }
          }
        });
      }

      if (drawing.isDrawing) {
        context.strokeStyle = "rgba(0, 200, 0, 0.8)";
        context.setLineDash([5, 5]);
        context.strokeRect(
          drawing.startPos.x,
          drawing.startPos.y,
          drawing.currentPos.x - drawing.startPos.x,
          drawing.currentPos.y - drawing.startPos.y
        );
        context.setLineDash([]);
      }

      if (drag.isAltDragging) {
        context.strokeStyle = "rgba(255, 165, 0, 0.9)";
        context.lineWidth = 2;
        context.setLineDash([5, 5]);
        context.beginPath();
        context.moveTo(drag.altDragStart.x, drag.altDragStart.y);
        context.lineTo(drag.altDragEnd.x, drag.altDragEnd.y);
        context.stroke();
        context.setLineDash([]);

        const angle = Math.atan2(
          drag.altDragEnd.y - drag.altDragStart.y,
          drag.altDragEnd.x - drag.altDragStart.x
        );
        context.beginPath();
        context.moveTo(drag.altDragEnd.x, drag.altDragEnd.y);
        context.lineTo(
          drag.altDragEnd.x - 12 * Math.cos(angle - Math.PI / 6),
          drag.altDragEnd.y - 12 * Math.sin(angle - Math.PI / 6)
        );
        context.lineTo(
          drag.altDragEnd.x - 12 * Math.cos(angle + Math.PI / 6),
          drag.altDragEnd.y - 12 * Math.sin(angle + Math.PI / 6)
        );
        context.closePath();
        context.fillStyle = "rgba(255, 165, 0, 0.9)";
        context.fill();

        const dx = drag.altDragEnd.x - drag.altDragStart.x;
        const dy = drag.altDragEnd.y - drag.altDragStart.y;
        const dir = classifyDirection(dx, dy);
        if (dir) {
          const label = getDirectionLabel(dir);
          context.font = "bold 16px sans-serif";
          context.textBaseline = "middle";
          context.fillStyle = "white";
          context.strokeStyle = "rgba(0,0,0,0.8)";
          context.lineWidth = 4;
          context.strokeText(label, drag.altDragEnd.x + 15, drag.altDragEnd.y);
          context.fillText(label, drag.altDragEnd.x + 15, drag.altDragEnd.y);
        }
      }
    };

    renderOverlaysRef.current = renderOverlays;

    if (overlayRafRef.current) cancelAnimationFrame(overlayRafRef.current);
    overlayRafRef.current = requestAnimationFrame(() => {
      renderOverlays();
      overlayRafRef.current = null;
    });

    return () => {
      if (overlayRafRef.current) {
        cancelAnimationFrame(overlayRafRef.current);
        overlayRafRef.current = null;
      }
    };
  }, [
    zoom,
    currentPage,
    pageIndex,
    showOcr,
    ocrOpacity,
    selectedIds,
    drawing.isDrawing,
    drawing.startPos,
    drawing.currentPos,
    drag.draggedId,
    pdfPage,
    drag.isAltDragging,
    drag.altDragStart,
    drag.altDragEnd,
  ]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disableDrawing) return;
    const pos = getMousePos(e);

    if (e.altKey && !isDrawingMode && !isSplitMode) {
      drag.beginAltDrag(pos);
      return;
    }

    if (isDrawingMode) {
      drawing.startDrawing(pos);
      return;
    }

    if (isSplitMode) {
      drawing.trySplit(pos);
      return;
    }

    const handled = drag.tryStartDragOrResize(pos, {
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    if (handled) return;

    // 何も当たらなかった→選択解除
    clearSelection();
  };

  const mouseMoveRafRef = useRef<number | null>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (disableDrawing) return;
    const pos = getMousePos(e);

    if (drag.isAltDragging) {
      drag.updateAltDrag(pos);
      return;
    }

    if (drawing.isDrawing) {
      drawing.updateDrawing(pos);
      return;
    }

    if (drag.updateDragResize(pos)) {
      return;
    }

    // Hover cursor 更新（RAFでスロットル）
    if (mouseMoveRafRef.current) return;
    mouseMoveRafRef.current = requestAnimationFrame(() => {
      mouseMoveRafRef.current = null;
      const hoverCursor = drag.getHoverCursor(pos, { isDrawingMode, isSplitMode });
      if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = hoverCursor;
    });
  };

  const handleMouseUp = () => {
    if (disableDrawing) return;

    if (drag.isAltDragging) {
      drag.finishAltDrag();
      return;
    }

    if (drawing.isDrawing) {
      drawing.finishDrawing();
      return;
    }

    drag.finishDragResize();
  };

  return (
    <div
      ref={wrapperRef}
      className={`canvas-wrapper ${isDrawingMode ? "drawing-mode" : ""}`}
      style={{
        position: "relative",
        display: "inline-block",
      }}
    >
      <canvas ref={pdfCanvasRef} />
      <canvas
        ref={overlayCanvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: 2,
          cursor:
            isDrawingMode || isSplitMode
              ? "crosshair"
              : drag.draggedId
              ? drag.dragMode === "move"
                ? "move"
                : "crosshair"
              : "default",
        }}
      />
      {loadError && !pdfPage && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            minHeight: "200px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(30, 41, 59, 0.85)",
            zIndex: 10,
            gap: "12px",
          }}
        >
          <span
            style={{
              color: "#94a3b8",
              fontSize: "14px",
            }}
          >
            ページの表示に失敗しました
          </span>
          <button
            type="button"
            onClick={() => {
              setLoadError(false);
              retry();
            }}
            style={{
              padding: "6px 16px",
              backgroundColor: "#334155",
              color: "#e2e8f0",
              border: "1px solid #475569",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "13px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#475569";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "#334155";
            }}
          >
            再試行
          </button>
        </div>
      )}
    </div>
  );
}
