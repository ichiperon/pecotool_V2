import { useEffect, useMemo, useRef } from "react";
import {
  usePecoStore,
  selectZoom,
  selectShowOcr,
  selectOcrOpacity,
  selectSelectedIds,
  selectIsDrawingMode,
  selectIsSplitMode,
  selectCurrentPageTextBlocks,
  selectDocumentFilePath,
  selectDocumentTotalPages,
} from "../store/pecoStore";
import { classifyDirection, getDirectionLabel } from "../utils/bulkReorder";
import { usePdfRendering } from "../hooks/usePdfRendering";
import { useCanvasDrawing } from "../hooks/useCanvasDrawing";
import { useBlockDragResize } from "../hooks/useBlockDragResize";
import type { TextBlock, BoundingBox } from "../types";

interface PdfCanvasProps {
  pageIndex: number;
  disableDrawing?: boolean;
  onFirstRender?: () => void;
  onRenderComplete?: () => void;
}

export function drawStaticBlock(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scale: number,
  opacity: number,
): void {
  const x = block.bbox.x * scale;
  const y = block.bbox.y * scale;
  const w = block.bbox.width * scale;
  const h = block.bbox.height * scale;
  const inset = 1;
  const baseAlpha = opacity;
  const fillAlpha = opacity * 0.25;

  context.fillStyle = `rgba(0, 150, 255, ${fillAlpha})`;
  context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  context.strokeStyle = `rgba(255, 0, 0, ${baseAlpha})`;
  context.lineWidth = 1;
  context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

  if (!block.text) return;
  if (block.writingMode === "vertical") {
    const fontSize = Math.max(10, w * 0.8);
    context.save();
    context.font = `bold ${fontSize}px sans-serif`;
    context.textBaseline = "top";

    const naturalHeight = block.text.length * fontSize;
    const sy = h / naturalHeight;

    context.translate(x + w, y + 2);
    context.scale(1, sy);
    context.rotate(Math.PI / 2);
    context.lineWidth = 3 / sy;
    context.strokeStyle = `rgba(255, 255, 255, ${baseAlpha})`;
    context.strokeText(block.text, 0, 0);
    context.fillStyle = `rgba(255, 0, 0, ${baseAlpha})`;
    context.fillText(block.text, 0, 0);
    context.restore();
    return;
  }

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
  context.fillStyle = `rgba(255, 0, 0, ${baseAlpha})`;
  context.fillText(block.text, 0, 0);
  context.restore();
}

export function renderStaticLayer(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  textBlocks: TextBlock[] | null | undefined,
  selectedIds: Set<string>,
  showOcr: boolean,
  zoom: number,
  opacity: number,
): void {
  // 注: 以前は block 単位の offscreen canvas キャッシュ + drawImage 経由で描画していたが、
  // drawImage の非整数 dst 座標でサブピクセル補間が発生し、OCR overlay が
  // 実テキストより上方向に 2-4px ズレて見える視覚的回帰を起こしたため、
  // v2.0.4 以前の直接描画に戻している。
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showOcr || !textBlocks) return;

  const scale = zoom / 100;
  for (const block of textBlocks) {
    if (selectedIds.has(block.id)) continue;
    drawStaticBlock(context, block, scale, opacity);
  }
}

export function PdfCanvas({
  pageIndex,
  disableDrawing = false,
  onFirstRender,
  onRenderComplete,
}: PdfCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  // 静的層: 全 BB の塗・枠・テキスト (非選択分のみ)
  const staticOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // 動的層: 選択ハイライト・ハンドル・drawing プレビュー・altDrag 矢印 (および hit-test 受け口)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const renderOverlaysRef = useRef<(() => void) | null>(null);

  // issue #134: 旧 `const document = usePecoStore(s => s.document)` は
  // updatePageData (別ページ含む) で document 参照が変わるたびに PdfCanvas 全体が
  // 再レンダされていた。ここで実際に使うのは filePath / totalPages のみなので
  // primitive selector に分解する。
  const documentFilePath = usePecoStore(selectDocumentFilePath);
  const documentTotalPages = usePecoStore(selectDocumentTotalPages);
  const documentEpoch = usePecoStore((s) => s.documentEpoch);
  // overlay 再描画 effect は textBlocks のみを依存とし、PageData の他フィールド
  // (isDirty / thumbnail / isTextExtracted 等) や同ページ内の bbox 以外の変更で
  // 再描画 effect が走らないようにする (issue #22)。
  const currentTextBlocks = usePecoStore(selectCurrentPageTextBlocks);
  // TODO(#183): 500-5000 BB ページで currentTextBlocks 参照が変わるたびに
  // Map を全件再構築するため GC pressure になる。将来 pecoStore 側で
  // id-indexed Map を state として持ち、updateBlock / addBlock / removeBlock で
  // incremental に更新する形に移行したい。当面はシンプルさ優先で useMemo
  // 維持 (currentTextBlocks の参照変化はページ切替/編集発生時のみ)。
  const currentTextBlocksById = useMemo(() => {
    const map = new Map<string, TextBlock>();
    for (const block of currentTextBlocks ?? []) {
      map.set(block.id, block);
    }
    return map;
  }, [currentTextBlocks]);
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
  const setSelectedIds = usePecoStore((s) => s.setSelectedIds);
  const clearSelection = usePecoStore((s) => s.clearSelection);
  const pushAction = usePecoStore((s) => s.pushAction);
  const setDragPreviewBboxes = usePecoStore((s) => s.setDragPreviewBboxes);
  // issue #91: ドラッグ中のみ非 null。動的層 overlay で選択 BB の bbox を上書きする。
  // issue #172: usePecoStore(selectDragPreviewBboxes) で購読すると毎フレーム
  // setDragPreviewBboxes 毎に PdfCanvas 全体が再レンダされ、useEffect 再走の
  // コストが BB 500+ で顕著になる。ref に同期して React 再レンダを抑え、
  // 値変化時は overlay の RAF redraw だけを直接スケジュールする。
  const dragPreviewBboxesRef = useRef<Map<string, BoundingBox> | null>(
    usePecoStore.getState().dragPreviewBboxes,
  );

  // issue #106: render 時点の `document` state を closure 保持すると、
  // 同一 React tick 内で updatePageData() 直後に再度呼んだ getPageData が
  // 「更新前」の値を返してしまい、useBlockDragResize.finishDragResize の
  // Action.after が before と同じ snapshot になる → Redo が無効化される。
  // 常に最新 state を store から直接読み出すことで、書き込み直後の after を
  // 正しく取得できるようにする。
  const getPageData = () => usePecoStore.getState().document?.pages.get(pageIndex);

  const { pdfPage, loadError, setLoadError, retry } = usePdfRendering({
    pdfCanvasRef,
    overlayCanvasRef,
    staticOverlayCanvasRef,
    wrapperRef,
    filePath: documentFilePath,
    totalPages: documentTotalPages,
    pageIndex,
    documentEpoch,
    zoom,
    onFirstRender,
    onRenderComplete,
    renderOverlaysRef,
  });

  const drawing = useCanvasDrawing({
    pageIndex,
    zoom,
    getPageData,
    selectedIds,
    updatePageData,
    setSelectedIds,
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
    setDragPreviewBboxes,
  });

  const getMousePos = (e: React.MouseEvent) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  // 選択されたブロックへの自動スクロール。
  // 依存に `currentPage` (PageData 全体) を入れると updatePageData による
  // テキスト編集 / dirty flag / thumbnail 更新でも effect が走り、user scroll を
  // 中断してしまう。textBlocks のみを購読すれば bbox が変わったときだけ再実行
  // される (issue #73)。
  useEffect(() => {
    if (selectedIds.size !== 1 || drag.draggedId) return;
    const selectedId = Array.from(selectedIds)[0];
    const block = currentTextBlocks?.find((b) => b.id === selectedId);
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
  }, [selectedIds, zoom, currentTextBlocks, pageIndex, drag.draggedId]);

  // ── Overlay Layer Rendering (2 層分割) ───────────────────────────────
  //
  // issue #90: BB 500+ の状況で 1 文字編集や矢印キー移動ごとに O(N) の
  // forEach 描画が走るのを軽減するため、overlay を静的層と動的層に分割。
  //
  //   静的層 (staticOverlayCanvasRef):
  //     - 全 BB の塗・枠・テキストを描画する
  //     - ただし selectedIds に含まれる BB はスキップ (動的層で青く重ね描く)
  //     - 依存: currentTextBlocks / zoom / showOcr / ocrOpacity / pdfPage
  //       (selectedIds の変化では再走しない: ref 経由で参照)
  //
  //   動的層 (overlayCanvasRef):
  //     - 選択 BB の塗・枠・ハンドル・テキスト
  //     - drawing プレビュー
  //     - altDrag プレビュー (矢印 / 方向ラベル)
  //     - hit-test 用のマウスイベント受け口でもある (上層)
  //     - 依存: 上記の動的入力のみ。textBlocks 変化でも、選択 BB の bbox が
  //       変わったときには再走する必要があるため currentTextBlocks も含める。

  // 静的層 effect から selectedIds を ref 越しに読むことで、selectedIds の
  // 変化で静的層 effect が再走しないようにする (矢印キー移動の最適化に必要)。
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // 静的層: 非選択 BB の塗・枠・テキストを描画
  const staticOverlayRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!staticOverlayCanvasRef.current || !pdfPage) return;

    const renderStatic = () => {
      const canvas = staticOverlayCanvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;

      renderStaticLayer(
        context,
        canvas,
        currentTextBlocks,
        selectedIdsRef.current,
        showOcr,
        zoom,
        ocrOpacity,
      );
    };

    if (staticOverlayRafRef.current) cancelAnimationFrame(staticOverlayRafRef.current);
    staticOverlayRafRef.current = requestAnimationFrame(() => {
      renderStatic();
      staticOverlayRafRef.current = null;
    });

    return () => {
      if (staticOverlayRafRef.current) {
        cancelAnimationFrame(staticOverlayRafRef.current);
        staticOverlayRafRef.current = null;
      }
    };
  }, [zoom, currentTextBlocks, pageIndex, showOcr, ocrOpacity, pdfPage]);

  // 動的層: 選択 BB ハイライト + drawing/altDrag プレビュー
  const overlayRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!overlayCanvasRef.current || !pdfPage) return;

    const renderOverlays = () => {
      if (!overlayCanvasRef.current) return;
      const canvas = overlayCanvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      context.clearRect(0, 0, canvas.width, canvas.height);

      const textBlocks = currentTextBlocks;
      if (showOcr && textBlocks && selectedIds.size > 0) {
        const scale = zoom / 100;
        const baseAlpha = Math.min(1.0, ocrOpacity * 2);
        const fillAlpha = Math.min(0.4, ocrOpacity * 0.625);

        // 選択/drag preview 対象だけ描画する。
        // issue #91: ドラッグ中は dragPreviewBboxes に動いた bbox が入っているので
        // それを優先的に参照する (textBlocks 側は finishDragResize まで変わらない)。
        // issue #172: ref から最新値を読み出す (購読は別 effect で同期)。
        const dragPreviewBboxes = dragPreviewBboxesRef.current;
        const dynamicBlockIds = new Set(selectedIds);
        for (const id of dragPreviewBboxes?.keys() ?? []) {
          dynamicBlockIds.add(id);
        }
        for (const id of dynamicBlockIds) {
          const block = currentTextBlocksById.get(id);
          if (!block) continue;

          const previewBbox = dragPreviewBboxes?.get(id);
          const bbox = previewBbox ?? block.bbox;
          const x = bbox.x * scale;
          const y = bbox.y * scale;
          const w = bbox.width * scale;
          const h = bbox.height * scale;

          const inset = 0;

          context.fillStyle = `rgba(0, 100, 255, ${fillAlpha})`;
          context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          context.strokeStyle = `rgba(0, 100, 255, ${Math.min(1.0, baseAlpha * 1.125)})`;
          context.lineWidth = 2;
          context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          // 4 隅のリサイズハンドル
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
              context.fillStyle = `rgba(0, 50, 255, ${baseAlpha})`;
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
              context.fillStyle = `rgba(0, 50, 255, ${baseAlpha})`;
              context.fillText(block.text, 0, 0);
              context.restore();
            }
          }
        }
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
    currentTextBlocks,
    currentTextBlocksById,
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
    // issue #172: dragPreviewBboxes は ref 経由で読み、購読 effect で
    // RAF redraw を直接スケジュールする。ここでは依存に含めないことで
    // BB 500+ 環境での毎フレーム再 render を回避する。
  ]);

  // issue #172: dragPreviewBboxes をストア subscribe で ref に同期し、
  // 変化時は renderOverlaysRef 経由で動的層だけを RAF redraw する。
  // この経路では React 再 render が走らないため、ドラッグ中の毎フレーム
  // re-render → useEffect 再走の山が消える。
  useEffect(() => {
    return usePecoStore.subscribe((state, prevState) => {
      if (state.dragPreviewBboxes === prevState.dragPreviewBboxes) return;
      dragPreviewBboxesRef.current = state.dragPreviewBboxes;
      const render = renderOverlaysRef.current;
      if (!render) return;
      if (overlayRafRef.current) cancelAnimationFrame(overlayRafRef.current);
      overlayRafRef.current = requestAnimationFrame(() => {
        render();
        overlayRafRef.current = null;
      });
    });
  }, []);

  // selectedIds が変化したとき、静的層は selectedIdsRef を介して読むだけで
  // 再走しない。しかし「新たに非選択になった BB」を静的層に書き戻す必要があるため、
  // selectedIds 変化時に静的層を 1 度再描画する。これは selectedIds 配列のみが
  // 変化した場合に効くもので、textBlocks 変化と同時に起きるケースは静的層の
  // メイン effect が走るので二重描画にはならない (RAF coalesce で吸収)。
  useEffect(() => {
    if (!staticOverlayCanvasRef.current || !pdfPage) return;
    const canvas = staticOverlayCanvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;

    if (staticOverlayRafRef.current) cancelAnimationFrame(staticOverlayRafRef.current);
    staticOverlayRafRef.current = requestAnimationFrame(() => {
      staticOverlayRafRef.current = null;
      renderStaticLayer(
        context,
        canvas,
        currentTextBlocks,
        selectedIds,
        showOcr,
        zoom,
        ocrOpacity,
      );
    });

    return () => {
      if (staticOverlayRafRef.current) {
        cancelAnimationFrame(staticOverlayRafRef.current);
        staticOverlayRafRef.current = null;
      }
    };
    // 注: 依存は selectedIds のみ。他フィールドのときは上の "メイン" 静的層
    // effect が責任を持つ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

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
        ref={staticOverlayCanvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
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
          className="pdf-load-error-overlay"
          role="alert"
        >
          <span className="pdf-load-error-message">
            ページの表示に失敗しました
          </span>
          <button
            type="button"
            className="pdf-load-error-retry-btn"
            aria-label="ページの読み込みを再試行する"
            onClick={() => {
              setLoadError(false);
              retry();
            }}
          >
            再試行
          </button>
        </div>
      )}
    </div>
  );
}
