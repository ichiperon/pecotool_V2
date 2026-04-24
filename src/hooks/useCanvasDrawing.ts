import { useState } from "react";
import { PageData, TextBlock } from "../types";
import { perf } from "../utils/perfLogger";
import { splitBlockAtRatio } from "../utils/splitBlock";

interface UseCanvasDrawingParams {
  pageIndex: number;
  zoom: number;
  getPageData: () => PageData | undefined;
  updatePageData: (
    pageIndex: number,
    partial: Partial<PageData>,
    pushUndo?: boolean
  ) => void;
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
}

interface UseCanvasDrawingResult {
  isDrawing: boolean;
  startPos: { x: number; y: number };
  currentPos: { x: number; y: number };
  startDrawing: (pos: { x: number; y: number }) => void;
  updateDrawing: (pos: { x: number; y: number }) => void;
  finishDrawing: () => void;
  trySplit: (pos: { x: number; y: number }) => boolean;
}

// 描画モード（新規bbox作成）と分割モード（クリックでblock分割）のマウス処理
export function useCanvasDrawing(params: UseCanvasDrawingParams): UseCanvasDrawingResult {
  const { pageIndex, zoom, getPageData, updatePageData, toggleDrawingMode, toggleSplitMode } =
    params;
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });

  const startDrawing = (pos: { x: number; y: number }) => {
    setIsDrawing(true);
    setStartPos(pos);
    setCurrentPos(pos);
  };

  const updateDrawing = (pos: { x: number; y: number }) => {
    setCurrentPos(pos);
  };

  const finishDrawing = () => {
    setIsDrawing(false);
    const x = Math.min(startPos.x, currentPos.x) / (zoom / 100);
    const y = Math.min(startPos.y, currentPos.y) / (zoom / 100);
    const width = Math.abs(currentPos.x - startPos.x) / (zoom / 100);
    const height = Math.abs(currentPos.y - startPos.y) / (zoom / 100);

    if (width > 2 && height > 2) {
      const pageData = getPageData();
      if (pageData) {
        const writingMode = height > width * 1.5 ? "vertical" : "horizontal";
        const cx = x + width / 2;
        const cy = y + height / 2;

        const sorted = [...pageData.textBlocks].sort((a, b) => a.order - b.order);
        let insertIndex = sorted.length;
        for (let i = 0; i < sorted.length; i++) {
          const b = sorted[i];
          const bCx = b.bbox.x + b.bbox.width / 2;
          const bCy = b.bbox.y + b.bbox.height / 2;

          let newComesFirst: boolean;
          if (writingMode === "vertical" || b.writingMode === "vertical") {
            const sameCol = Math.abs(cx - bCx) < Math.max(width, b.bbox.width) * 0.6;
            if (sameCol) {
              newComesFirst = cy < bCy;
            } else {
              newComesFirst = cx > bCx;
            }
          } else {
            const sameRow = Math.abs(cy - bCy) < Math.max(height, b.bbox.height) * 0.6;
            if (sameRow) {
              newComesFirst = cx < bCx;
            } else {
              newComesFirst = cy < bCy;
            }
          }

          if (newComesFirst) {
            insertIndex = i;
            break;
          }
        }

        const newBlock: TextBlock = {
          id: crypto.randomUUID(),
          text: "",
          originalText: "",
          bbox: { x, y, width, height },
          writingMode,
          order: insertIndex,
          isNew: true,
          isDirty: true,
        };

        const updatedBlocks = [...sorted];
        updatedBlocks.splice(insertIndex, 0, newBlock);
        const reorderedBlocks = updatedBlocks.map((b, i) => ({
          ...b,
          order: i,
          isDirty: b.id === newBlock.id ? true : b.isDirty,
        }));

        perf.mark('ui.blockNewDraw', { page: pageIndex, writingMode });
        updatePageData(pageIndex, {
          textBlocks: reorderedBlocks,
          isDirty: true,
        });
      }
    }
    toggleDrawingMode();
  };

  const trySplit = (pos: { x: number; y: number }): boolean => {
    const scale = zoom / 100;
    const pageData = getPageData();
    if (pageData) {
      for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
        const block = pageData.textBlocks[i];
        const x = block.bbox.x * scale;
        const y = block.bbox.y * scale;
        const w = block.bbox.width * scale;
        const h = block.bbox.height * scale;

        if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
          const isVertical = block.writingMode === "vertical";
          const ratio = isVertical
            ? Math.max(1, Math.min(h - 1, pos.y - y)) / h
            : Math.max(1, Math.min(w - 1, pos.x - x)) / w;
          const split = splitBlockAtRatio(block, ratio);
          if (!split) {
            toggleSplitMode();
            return false;
          }
          const { b1, b2 } = split;

          const newBlocks = pageData.textBlocks.filter((b) => b.id !== block.id);
          newBlocks.splice(i, 0, b1, b2);
          const finalBlocks = newBlocks.map((b, idx) => ({ ...b, order: idx }));

          perf.mark('ui.blockSplit', {
            page: pageIndex,
            origLen: block.text.length,
            b1Len: b1.text.length,
            b2Len: b2.text.length,
            vertical: isVertical,
          });
          updatePageData(pageIndex, { textBlocks: finalBlocks, isDirty: true });
          toggleSplitMode();
          return true;
        }
      }
    }
    toggleSplitMode();
    return false;
  };

  return {
    isDrawing,
    startPos,
    currentPos,
    startDrawing,
    updateDrawing,
    finishDrawing,
    trySplit,
  };
}
