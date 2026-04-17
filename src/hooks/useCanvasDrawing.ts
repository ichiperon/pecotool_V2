import { useState } from "react";
import { PageData, TextBlock } from "../types";

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

        const updatedBlocks = sorted.map((b, i) => {
          const originalOrder = i >= insertIndex ? b.order + 1 : b.order;
          return originalOrder !== b.order ? { ...b, order: originalOrder } : b;
        });

        updatePageData(pageIndex, {
          textBlocks: [...updatedBlocks, newBlock],
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
          const b1 = { ...block, id: crypto.randomUUID(), isDirty: true };
          const b2 = { ...block, id: crypto.randomUUID(), isDirty: true };

          const getSplitIndex = (text: string, ratio: number) => {
            if (text.length <= 1) return 1;
            let totalW = 0;
            const weights = [];
            for (let j = 0; j < text.length; j++) {
              const code = text.charCodeAt(j);
              const ww =
                code <= 0xff || (code >= 0xff61 && code <= 0xff9f) || code === 0x20 ? 1 : 2;
              weights.push(ww);
              totalW += ww;
            }
            const targetW = totalW * ratio;
            let currentW = 0;
            for (let j = 0; j < text.length; j++) {
              currentW += weights[j];
              if (currentW >= targetW) {
                if (currentW - targetW < weights[j] / 2)
                  return Math.min(text.length - 1, Math.max(1, j + 1));
                return Math.min(text.length - 1, Math.max(1, j));
              }
            }
            return Math.max(1, text.length - 1);
          };

          if (!isVertical) {
            const safeDx = Math.max(1, Math.min(w - 1, pos.x - x));
            const ratio = safeDx / w;
            const splitIdx = getSplitIndex(block.text, ratio);
            b1.text = block.text.substring(0, splitIdx);
            b1.originalText = b1.text;
            b2.text = block.text.substring(splitIdx);
            b2.originalText = b2.text;

            const dx = safeDx / scale;
            b1.bbox = { ...block.bbox, width: dx };
            b2.bbox = { ...block.bbox, x: block.bbox.x + dx, width: block.bbox.width - dx };
          } else {
            const safeDy = Math.max(1, Math.min(h - 1, pos.y - y));
            const ratio = safeDy / h;
            const splitIdx = getSplitIndex(block.text, ratio);
            b1.text = block.text.substring(0, splitIdx);
            b1.originalText = b1.text;
            b2.text = block.text.substring(splitIdx);
            b2.originalText = b2.text;

            const dy = safeDy / scale;
            b1.bbox = { ...block.bbox, height: dy };
            b2.bbox = { ...block.bbox, y: block.bbox.y + dy, height: block.bbox.height - dy };
          }

          const newBlocks = pageData.textBlocks.filter((b) => b.id !== block.id);
          newBlocks.splice(i, 0, b1, b2);
          const finalBlocks = newBlocks.map((b, idx) => ({ ...b, order: idx }));

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
