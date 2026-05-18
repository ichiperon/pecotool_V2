import { useEffect, useRef, useState } from "react";
import { Action, BoundingBox, PageData } from "../types";
import { classifyDirection, reorderBlocks } from "../utils/bulkReorder";
import { readReorderThreshold } from "../utils/reorderThreshold";
import { perf } from "../utils/perfLogger";

type DragMode = "none" | "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";

interface UseBlockDragResizeParams {
  pageIndex: number;
  zoom: number;
  selectedIds: Set<string>;
  getPageData: () => PageData | undefined;
  updatePageData: (
    pageIndex: number,
    partial: Partial<PageData>,
    pushUndo?: boolean
  ) => void;
  toggleSelection: (id: string, additive: boolean) => void;
  pushAction: (action: Action) => void;
}

interface UseBlockDragResizeResult {
  dragMode: DragMode;
  draggedId: string | null;
  isAltDragging: boolean;
  altDragStart: { x: number; y: number };
  altDragEnd: { x: number; y: number };
  beginAltDrag: (pos: { x: number; y: number }) => void;
  updateAltDrag: (pos: { x: number; y: number }) => void;
  finishAltDrag: () => void;
  tryStartDragOrResize: (
    pos: { x: number; y: number },
    mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  ) => boolean;
  updateDragResize: (pos: { x: number; y: number }) => boolean;
  finishDragResize: () => void;
  getHoverCursor: (
    pos: { x: number; y: number },
    opts: { isDrawingMode: boolean; isSplitMode: boolean }
  ) => string;
}

// バウンディングボックスのドラッグ移動・リサイズ・Alt+ドラッグによるbulk並び替え
export function useBlockDragResize(params: UseBlockDragResizeParams): UseBlockDragResizeResult {
  const {
    pageIndex,
    zoom,
    selectedIds,
    getPageData,
    updatePageData,
    toggleSelection,
    pushAction,
  } = params;

  const [isAltDragging, setIsAltDragging] = useState(false);
  const [altDragStart, setAltDragStart] = useState({ x: 0, y: 0 });
  const [altDragEnd, setAltDragEnd] = useState({ x: 0, y: 0 });

  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragStartBbox, setDragStartBbox] = useState<BoundingBox | null>(null);
  const [dragStartBboxes, setDragStartBboxes] = useState<
    Map<string, { x: number; y: number; width: number; height: number }>
  >(new Map());
  const [dragStartMouse, setDragStartMouse] = useState({ x: 0, y: 0 });
  const preDragPageRef = useRef<PageData | null>(null);
  // updateDragResize を RAF で coalesce するための保留状態。
  // mousemove は 1 フレームに複数発火しうるため、毎回 updatePageData を呼ぶと
  // pages Map / textBlocks 配列の全コピーが mousemove ごとに発生してカクつく。
  // 同一フレーム内では最新の pos のみを採用し、updatePageData を 1 回に集約する。
  const pendingDragPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragRafRef = useRef<number | null>(null);

  const beginAltDrag = (pos: { x: number; y: number }) => {
    setIsAltDragging(true);
    setAltDragStart(pos);
    setAltDragEnd(pos);
  };

  const updateAltDrag = (pos: { x: number; y: number }) => {
    setAltDragEnd(pos);
  };

  const finishAltDrag = () => {
    setIsAltDragging(false);
    const dx = altDragEnd.x - altDragStart.x;
    const dy = altDragEnd.y - altDragStart.y;
    const dir = classifyDirection(dx, dy);
    if (dir) {
      const pageData = getPageData();
      if (pageData && pageData.textBlocks.length > 0) {
        const percent = readReorderThreshold();
        const newBlocks = reorderBlocks([...pageData.textBlocks], dir, percent);
        perf.mark('ui.altReorder', { page: pageIndex, direction: dir, blocks: newBlocks.length });
        updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, true);
      }
    }
  };

  const tryStartDragOrResize = (
    pos: { x: number; y: number },
    mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  ): boolean => {
    const scale = zoom / 100;
    const pageData = getPageData();
    if (!pageData) return false;

    let detectedDragMode: DragMode = "none";

    // リサイズハンドル判定
    for (const id of selectedIds) {
      const block = pageData.textBlocks.find((b) => b.id === id);
      if (!block) continue;
      const x = block.bbox.x * scale;
      const y = block.bbox.y * scale;
      const w = block.bbox.width * scale;
      const h = block.bbox.height * scale;
      const hs = 10;

      if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - y) < hs) detectedDragMode = "resize-nw";
      else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - y) < hs)
        detectedDragMode = "resize-ne";
      else if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - (y + h)) < hs)
        detectedDragMode = "resize-sw";
      else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - (y + h)) < hs)
        detectedDragMode = "resize-se";

      if (detectedDragMode !== "none") {
        preDragPageRef.current = { ...pageData, textBlocks: [...pageData.textBlocks] };
        setDraggedId(id);
        setDragMode(detectedDragMode);
        setDragStartBbox({ ...block.bbox });
        setDragStartMouse(pos);
        return true;
      }
    }

    // 移動（ブロック内クリック）
    for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
      const block = pageData.textBlocks[i];
      const x = block.bbox.x * scale;
      const y = block.bbox.y * scale;
      const w = block.bbox.width * scale;
      const h = block.bbox.height * scale;

      if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
        if ((mods.ctrlKey || mods.metaKey || mods.shiftKey) && selectedIds.has(block.id)) {
          toggleSelection(block.id, true);
          return true;
        }

        let curSelectedIds = selectedIds;
        if (!selectedIds.has(block.id)) {
          toggleSelection(block.id, mods.ctrlKey || mods.metaKey || mods.shiftKey);
          if (mods.ctrlKey || mods.metaKey || mods.shiftKey) {
            curSelectedIds = new Set(selectedIds);
            curSelectedIds.add(block.id);
          } else {
            curSelectedIds = new Set([block.id]);
          }
        }
        preDragPageRef.current = { ...pageData, textBlocks: [...pageData.textBlocks] };
        setDraggedId(block.id);
        setDragMode("move");
        setDragStartBbox({ ...block.bbox });

        const newBboxes = new Map();
        pageData.textBlocks.forEach((b) => {
          if (curSelectedIds.has(b.id)) {
            newBboxes.set(b.id, { ...b.bbox });
          }
        });
        setDragStartBboxes(newBboxes);
        setDragStartMouse(pos);
        return true;
      }
    }

    return false;
  };

  // updateDragResize の実体。pendingDragPosRef.current を最新 pos として消費し
  // updatePageData を 1 回呼ぶ。RAF コールバックおよび finishDragResize の flush から使う。
  const applyDragResize = (pos: { x: number; y: number }): void => {
    if (!draggedId || dragMode === "none") return;
    const scale = zoom / 100;
    const dx = (pos.x - dragStartMouse.x) / scale;
    const dy = (pos.y - dragStartMouse.y) / scale;
    const pageData = getPageData();
    if (!pageData) return;

    if (dragMode === "move") {
      const newBlocks = pageData.textBlocks.map((b) => {
        if (dragStartBboxes.has(b.id)) {
          const startBbox = dragStartBboxes.get(b.id)!;
          return {
            ...b,
            bbox: {
              ...startBbox,
              x: startBbox.x + dx,
              y: startBbox.y + dy,
            },
            isDirty: true,
          };
        }
        return b;
      });
      // 保存フィルタは page.isDirty のみを見るため、block.isDirty だけでなく
      // page.isDirty も明示的に立てる必要がある (さもないと BB 移動のみの変更は保存されない)
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, false);
    } else {
      if (!dragStartBbox) return;
      const startBbox: BoundingBox = dragStartBbox;
      const newBbox: BoundingBox = { ...startBbox };
      if (dragMode === "resize-se") {
        newBbox.width = Math.max(1, startBbox.width + dx);
        newBbox.height = Math.max(1, startBbox.height + dy);
      } else if (dragMode === "resize-sw") {
        newBbox.x = Math.min(startBbox.x + startBbox.width - 1, startBbox.x + dx);
        newBbox.width = Math.max(1, startBbox.width - dx);
        newBbox.height = Math.max(1, startBbox.height + dy);
      } else if (dragMode === "resize-ne") {
        newBbox.y = Math.min(startBbox.y + startBbox.height - 1, startBbox.y + dy);
        newBbox.width = Math.max(1, startBbox.width + dx);
        newBbox.height = Math.max(1, startBbox.height - dy);
      } else if (dragMode === "resize-nw") {
        newBbox.x = Math.min(startBbox.x + startBbox.width - 1, startBbox.x + dx);
        newBbox.y = Math.min(startBbox.y + startBbox.height - 1, startBbox.y + dy);
        newBbox.width = Math.max(1, startBbox.width - dx);
        newBbox.height = Math.max(1, startBbox.height - dy);
      }

      const newBlocks = pageData.textBlocks.map((b) =>
        b.id === draggedId ? { ...b, bbox: newBbox, isDirty: true } : b
      );
      // 保存フィルタは page.isDirty のみを見るため、block.isDirty だけでなく
      // page.isDirty も明示的に立てる必要がある (さもないと BB リサイズのみの変更は保存されない)
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, false);
    }
  };

  const updateDragResize = (pos: { x: number; y: number }): boolean => {
    if (!draggedId || dragMode === "none") return false;
    // 同一フレーム内の複数 mousemove を coalesce: 最新 pos のみを採用し、
    // RAF コールバックで 1 度だけ実体処理を走らせる。
    pendingDragPosRef.current = pos;
    if (dragRafRef.current !== null) return true;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const next = pendingDragPosRef.current;
      pendingDragPosRef.current = null;
      if (next) applyDragResize(next);
    });
    return true;
  };

  const finishDragResize = () => {
    if (draggedId && dragMode !== "none") {
      // ドロップ位置を確実に反映するため、保留中の RAF をキャンセルして
      // 最新の pending pos を同期的に flush してから undo 用 snapshot を作る。
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      const pending = pendingDragPosRef.current;
      pendingDragPosRef.current = null;
      if (pending) applyDragResize(pending);

      const pageData = getPageData();
      if (pageData && preDragPageRef.current) {
        const action: Action = {
          type: "update_page",
          pageIndex,
          before: preDragPageRef.current,
          after: { ...pageData },
        };
        pushAction(action);
        perf.mark('ui.bboxEdit', { page: pageIndex, mode: dragMode });
      }
      preDragPageRef.current = null;
      setDraggedId(null);
      setDragMode("none");
    }
  };

  // unmount 時に保留中の RAF をクリーンアップ (ドラッグ中に component が消えた場合の安全装置)
  useEffect(() => {
    return () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      pendingDragPosRef.current = null;
    };
  }, []);

  const getHoverCursor = (
    pos: { x: number; y: number },
    opts: { isDrawingMode: boolean; isSplitMode: boolean }
  ): string => {
    const scale = zoom / 100;
    const pageData = getPageData();
    let hoverCursor = "default";

    if (opts.isDrawingMode) {
      return "crosshair";
    } else if (opts.isSplitMode) {
      hoverCursor = "crosshair";
      if (pageData) {
        for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
          const block = pageData.textBlocks[i];
          const x = block.bbox.x * scale;
          const y = block.bbox.y * scale;
          const w = block.bbox.width * scale;
          const h = block.bbox.height * scale;
          if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
            hoverCursor = block.writingMode === "vertical" ? "row-resize" : "col-resize";
            break;
          }
        }
      }
    } else if (pageData) {
      for (const id of selectedIds) {
        const block = pageData.textBlocks.find((b) => b.id === id);
        if (!block) continue;
        const x = block.bbox.x * scale;
        const y = block.bbox.y * scale;
        const w = block.bbox.width * scale;
        const h = block.bbox.height * scale;
        const hs = 10;
        if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - y) < hs) hoverCursor = "nw-resize";
        else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - y) < hs)
          hoverCursor = "ne-resize";
        else if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - (h + y)) < hs)
          hoverCursor = "sw-resize";
        else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - (h + y)) < hs)
          hoverCursor = "se-resize";
      }

      if (hoverCursor === "default") {
        for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
          const block = pageData.textBlocks[i];
          const x = block.bbox.x * scale;
          const y = block.bbox.y * scale;
          const w = block.bbox.width * scale;
          const h = block.bbox.height * scale;
          if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
            hoverCursor = "move";
            break;
          }
        }
      }
    }
    return hoverCursor;
  };

  return {
    dragMode,
    draggedId,
    isAltDragging,
    altDragStart,
    altDragEnd,
    beginAltDrag,
    updateAltDrag,
    finishAltDrag,
    tryStartDragOrResize,
    updateDragResize,
    finishDragResize,
    getHoverCursor,
  };
}
