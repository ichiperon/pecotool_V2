import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import { usePecoStore } from "../store/pecoStore";
import { Action, PageData, TextBlock } from "../types";

interface PdfCanvasProps {
  pageIndex: number;
  disableDrawing?: boolean;
}

// Use shared configuration for CMaps and fonts
const CMAP_URL = 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/';
const CMAP_PACKED = true;
const STANDARD_FONT_DATA_URL = 'https://unpkg.com/pdfjs-dist@5.5.207/standard_fonts/';

export function PdfCanvas({ pageIndex, disableDrawing = false }: PdfCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const { document, originalBytes, zoom, showOcr, ocrOpacity, selectedIds, isDrawingMode, isSplitMode, updatePageData, toggleDrawingMode, toggleSplitMode, toggleSelection, pushAction } = usePecoStore();
  const [pdfPage, setPdfPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });

  // Moving/Resizing state
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'>('none');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragStartBbox, setDragStartBbox] = useState<any>(null);
  const [dragStartMouse, setDragStartMouse] = useState({ x: 0, y: 0 });
  const preDragPageRef = useRef<PageData | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  // Open PDF document only when bytes change (expensive)
  useEffect(() => {
    if (!originalBytes) return;
    let cancelled = false;

    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ 
          data: originalBytes.slice(), // Restore .slice() to prevent detachment
          cMapUrl: CMAP_URL,
          cMapPacked: CMAP_PACKED,
          standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        if (cancelled) { doc.destroy(); return; }
        pdfDocRef.current = doc;
        const page = await doc.getPage(pageIndex + 1);
        if (cancelled) return;
        setPdfPage(page);
      } catch (err) {
        if (!cancelled) console.error("Error loading PDF page:", err);
      }
    })();

    return () => {
      cancelled = true;
      pdfDocRef.current = null;
    };
  }, [originalBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load specific page using cached doc (cheap)
  useEffect(() => {
    const doc = pdfDocRef.current;
    if (!doc) return;
    let cancelled = false;

    (async () => {
      try {
        const page = await doc.getPage(pageIndex + 1);
        if (cancelled) return;
        setPdfPage(page);
      } catch (err) {
        if (!cancelled) console.error("Error loading PDF page:", err);
      }
    })();

    return () => { cancelled = true; };
  }, [pageIndex]);

  const getMousePos = (e: React.MouseEvent) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  // PDF Layer Rendering
  useEffect(() => {
    if (!pdfPage || !pdfCanvasRef.current) return;

    const renderPdf = async () => {
      const canvas = pdfCanvasRef.current!;
      const context = canvas.getContext('2d')!;

      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      // Update overlay dimensions to match
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = viewport.width;
        overlayCanvasRef.current.height = viewport.height;
      }

      // Sync CSS display size directly via DOM to avoid React async timing issues
      const w = viewport.width;
      const h = viewport.height;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.display = 'block';
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.style.width = `${w}px`;
        overlayCanvasRef.current.style.height = `${h}px`;
      }
      if (wrapperRef.current) {
        wrapperRef.current.style.width = `${w}px`;
        wrapperRef.current.style.height = `${h}px`;
      }

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      };

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      renderTaskRef.current = pdfPage.render(renderContext);

      try {
        await renderTaskRef.current.promise;
      } catch (err: any) {
        if (err.name === 'RenderingCancelledException') return;
        console.error("PDF render error:", err);
      }
    };

    renderPdf();
  }, [pdfPage, zoom]);

  // Overlay Layer Rendering
  useEffect(() => {
    if (!overlayCanvasRef.current || !pdfPage) return;

    const renderOverlays = () => {
      const canvas = overlayCanvasRef.current!;
      const context = canvas.getContext('2d')!;
      
      // Clear previous overlays
      context.clearRect(0, 0, canvas.width, canvas.height);

      // Draw OCR Overlays
      const pageData = document?.pages.get(pageIndex);
      if (showOcr && pageData && pageData.textBlocks) {
        pageData.textBlocks.forEach(block => {
          const isSelected = selectedIds.has(block.id);
          context.strokeStyle = isSelected ? "rgba(0, 120, 255, 0.8)" : "rgba(255, 0, 0, 0.3)";
          context.lineWidth = isSelected ? 2 : 1;
          
          const x = block.bbox.x * (zoom / 100);
          const y = block.bbox.y * (zoom / 100);
          let w = block.bbox.width * (zoom / 100);
          let h = block.bbox.height * (zoom / 100);

          // 隣接BBを視覚的に分離するための表示用インセット（bboxデータは変更しない）
          const inset = isSelected ? 0 : 1;

          // opacity を ocrOpacity で制御（選択時は常に鮮明に）
          const baseAlpha = isSelected ? 0.8 : ocrOpacity;
          const fillAlpha = isSelected ? 0.25 : ocrOpacity * 0.25;

          context.fillStyle = isSelected ? `rgba(0, 100, 255, 0.25)` : `rgba(0, 150, 255, ${fillAlpha})`;
          context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          context.strokeStyle = isSelected ? `rgba(0, 100, 255, 0.9)` : `rgba(255, 0, 0, ${baseAlpha})`;
          context.lineWidth = isSelected ? 2 : 1;
          context.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          if (isSelected) {
            // Draw resize handles for selected block
            context.fillStyle = "white";
            context.strokeStyle = "rgba(0, 100, 255, 1)";
            const handleSize = 6;
            [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
              context.fillRect(hx - handleSize/2, hy - handleSize/2, handleSize, handleSize);
              context.strokeRect(hx - handleSize/2, hy - handleSize/2, handleSize, handleSize);
            });
          }

          // Draw OCR text preview
          if (block.text) {
            if (block.writingMode === 'vertical') {
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
              context.fillStyle = isSelected ? `rgba(0, 50, 255, ${baseAlpha})` : `rgba(255, 0, 0, ${baseAlpha})`;
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
              context.fillStyle = isSelected ? `rgba(0, 50, 255, ${baseAlpha})` : `rgba(255, 0, 0, ${baseAlpha})`;
              context.fillText(block.text, 0, 0);
              context.restore();
            }
          }
        });
      }

      // Draw current drawing rectangle
      if (isDrawing) {
        context.strokeStyle = "rgba(0, 200, 0, 0.8)";
        context.setLineDash([5, 5]);
        context.strokeRect(
          startPos.x,
          startPos.y,
          currentPos.x - startPos.x,
          currentPos.y - startPos.y
        );
        context.setLineDash([]);
      }
    };

    renderOverlays();
  }, [zoom, document, pageIndex, showOcr, ocrOpacity, selectedIds, isDrawing, startPos, currentPos, draggedId, pdfPage]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disableDrawing) return;
    const pos = getMousePos(e);
    const scale = zoom / 100;
    const pageData = document?.pages.get(pageIndex);
    
    if (isDrawingMode) {
      setIsDrawing(true);
      setStartPos(pos);
      setCurrentPos(pos);
      return;
    }

    if (isSplitMode) {
      if (pageData) {
        for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
          const block = pageData.textBlocks[i];
          const x = block.bbox.x * scale;
          const y = block.bbox.y * scale;
          const w = block.bbox.width * scale;
          const h = block.bbox.height * scale;
          
          if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
             const isVertical = block.writingMode === 'vertical';
             let b1 = { ...block, id: crypto.randomUUID(), isDirty: true };
             let b2 = { ...block, id: crypto.randomUUID(), isDirty: true };
             
             const getSplitIndex = (text: string, ratio: number) => {
               if (text.length <= 1) return 1;
               let totalW = 0;
               const weights = [];
               for (let j = 0; j < text.length; j++) {
                 const code = text.charCodeAt(j);
                 const w = (code <= 0xFF || (code >= 0xFF61 && code <= 0xFF9F) || code === 0x20) ? 1 : 2;
                 weights.push(w);
                 totalW += w;
               }
               const targetW = totalW * ratio;
               let currentW = 0;
               for (let j = 0; j < text.length; j++) {
                 currentW += weights[j];
                 if (currentW >= targetW) {
                   if (currentW - targetW < weights[j] / 2) return Math.min(text.length - 1, Math.max(1, j + 1));
                   return Math.min(text.length - 1, Math.max(1, j));
                 }
               }
               return Math.max(1, text.length - 1);
             };

             if (!isVertical) { // Horizontal (split width)
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
             } else { // Vertical (split height)
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
             
             const newBlocks = pageData.textBlocks.filter(b => b.id !== block.id);
             newBlocks.splice(i, 0, b1, b2);
             const finalBlocks = newBlocks.map((b, idx) => ({ ...b, order: idx }));
             
             updatePageData(pageIndex, { textBlocks: finalBlocks, isDirty: true });
             toggleSplitMode();
             return;
          }
        }
      }
      toggleSplitMode();
      return;
    }

    let detectedDragMode: typeof dragMode = 'none';

    // Check for resize handles or move
    if (pageData) {
      // Check selected blocks first (higher priority for handles)
      for (const id of selectedIds) {
        const block = pageData.textBlocks.find(b => b.id === id);
        if (!block) continue;
        const x = block.bbox.x * scale;
        const y = block.bbox.y * scale;
        const w = block.bbox.width * scale;
        const h = block.bbox.height * scale;
        const hs = 10; // hit area for handles

        if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - y) < hs) detectedDragMode = 'resize-nw';
        else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - y) < hs) detectedDragMode = 'resize-ne';
        else if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - (y + h)) < hs) detectedDragMode = 'resize-sw';
        else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - (y + h)) < hs) detectedDragMode = 'resize-se';
        
        if (detectedDragMode !== 'none') {
          const pg = pageData && document?.pages.get(pageIndex);
          preDragPageRef.current = pg ? { ...pg, textBlocks: [...pg.textBlocks] } : null;
          setDraggedId(id);
          setDragMode(detectedDragMode);
          setDragStartBbox({ ...block.bbox });
          setDragStartMouse(pos);
          return;
        }
      }

      // Check for move (click inside block)
      for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
        const block = pageData.textBlocks[i];
        const x = block.bbox.x * scale;
        const y = block.bbox.y * scale;
        const w = block.bbox.width * scale;
        const h = block.bbox.height * scale;

        if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
          if (!selectedIds.has(block.id)) {
            toggleSelection(block.id, e.ctrlKey || e.shiftKey);
          }
          const pg = document?.pages.get(pageIndex);
          preDragPageRef.current = pg ? { ...pg, textBlocks: [...pg.textBlocks] } : null;
          setDraggedId(block.id);
          setDragMode('move');
          setDragStartBbox({ ...block.bbox });
          setDragStartMouse(pos);
          return;
        }
      }
    }
    
    // Clicked empty area
    toggleSelection('', false); // Clear selection
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (disableDrawing) return;
    const pos = getMousePos(e);
    const scale = zoom / 100;

    if (isDrawing) {
      setCurrentPos(pos);
      return;
    }

    if (draggedId && dragMode !== 'none') {
      const dx = (pos.x - dragStartMouse.x) / scale;
      const dy = (pos.y - dragStartMouse.y) / scale;
      const pageData = document?.pages.get(pageIndex);
      if (!pageData) return;

      const newBbox = { ...dragStartBbox };

      if (dragMode === 'move') {
        newBbox.x += dx;
        newBbox.y += dy;
      } else if (dragMode === 'resize-se') {
        newBbox.width = Math.max(1, dragStartBbox.width + dx);
        newBbox.height = Math.max(1, dragStartBbox.height + dy);
      } else if (dragMode === 'resize-sw') {
        newBbox.x = Math.min(dragStartBbox.x + dragStartBbox.width - 1, dragStartBbox.x + dx);
        newBbox.width = Math.max(1, dragStartBbox.width - dx);
        newBbox.height = Math.max(1, dragStartBbox.height + dy);
      } else if (dragMode === 'resize-ne') {
        newBbox.y = Math.min(dragStartBbox.y + dragStartBbox.height - 1, dragStartBbox.y + dy);
        newBbox.width = Math.max(1, dragStartBbox.width + dx);
        newBbox.height = Math.max(1, dragStartBbox.height - dy);
      } else if (dragMode === 'resize-nw') {
        newBbox.x = Math.min(dragStartBbox.x + dragStartBbox.width - 1, dragStartBbox.x + dx);
        newBbox.y = Math.min(dragStartBbox.y + dragStartBbox.height - 1, dragStartBbox.y + dy);
        newBbox.width = Math.max(1, dragStartBbox.width - dx);
        newBbox.height = Math.max(1, dragStartBbox.height - dy);
      }

      const newBlocks = pageData.textBlocks.map(b => 
        b.id === draggedId ? { ...b, bbox: newBbox, isDirty: true } : b
      );
      updatePageData(pageIndex, { textBlocks: newBlocks }, false);
    } else {
      // Hover effect for cursor
      const pageData = document?.pages.get(pageIndex);
      let hoverCursor = 'default';
      
      if (isDrawingMode) {
        hoverCursor = 'crosshair';
      } else if (isSplitMode) {
        hoverCursor = 'crosshair';
        if (pageData) {
          for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
            const block = pageData.textBlocks[i];
            const x = block.bbox.x * scale;
            const y = block.bbox.y * scale;
            const w = block.bbox.width * scale;
            const h = block.bbox.height * scale;
            if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
              hoverCursor = block.writingMode === 'vertical' ? 'row-resize' : 'col-resize';
              break;
            }
          }
        }
      } else if (pageData) {
        // Check handles
        for (const id of selectedIds) {
          const block = pageData.textBlocks.find(b => b.id === id);
          if (!block) continue;
          const x = block.bbox.x * scale;
          const y = block.bbox.y * scale;
          const w = block.bbox.width * scale;
          const h = block.bbox.height * scale;
          const hs = 10;
          if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - y) < hs) hoverCursor = 'nw-resize';
          else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - y) < hs) hoverCursor = 'ne-resize';
          else if (Math.abs(pos.x - x) < hs && Math.abs(pos.y - (h + y)) < hs) hoverCursor = 'sw-resize';
          else if (Math.abs(pos.x - (x + w)) < hs && Math.abs(pos.y - (h + y)) < hs) hoverCursor = 'se-resize';
        }
        
        if (hoverCursor === 'default') {
          for (let i = pageData.textBlocks.length - 1; i >= 0; i--) {
            const block = pageData.textBlocks[i];
            const x = block.bbox.x * scale;
            const y = block.bbox.y * scale;
            const w = block.bbox.width * scale;
            const h = block.bbox.height * scale;
            if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
              hoverCursor = 'move';
              break;
            }
          }
        }
      }
      if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = hoverCursor;
    }
  };

  const handleMouseUp = () => {
    if (disableDrawing) return;
    if (isDrawing) {
      setIsDrawing(false);
      const x = Math.min(startPos.x, currentPos.x) / (zoom / 100);
      const y = Math.min(startPos.y, currentPos.y) / (zoom / 100);
      const width = Math.abs(currentPos.x - startPos.x) / (zoom / 100);
      const height = Math.abs(currentPos.y - startPos.y) / (zoom / 100);

      if (width > 2 && height > 2) {
        const pageData = document?.pages.get(pageIndex);
        if (pageData) {
          const writingMode = height > width * 1.5 ? "vertical" : "horizontal";

          // Compute the spatial insert index among existing blocks
          const cx = x + width / 2;
          const cy = y + height / 2;

          const sorted = [...pageData.textBlocks].sort((a, b) => a.order - b.order);

          // Determine insert index by comparing center positions
          let insertIndex = sorted.length; // default: end
          for (let i = 0; i < sorted.length; i++) {
            const b = sorted[i];
            const bCx = b.bbox.x + b.bbox.width / 2;
            const bCy = b.bbox.y + b.bbox.height / 2;

            let newComesFirst: boolean;
            if (writingMode === 'vertical' || b.writingMode === 'vertical') {
              // Vertical: right column first (larger x = earlier), then top-to-bottom
              const sameCol = Math.abs(cx - bCx) < Math.max(width, b.bbox.width) * 0.6;
              if (sameCol) {
                newComesFirst = cy < bCy;
              } else {
                newComesFirst = cx > bCx; // right column = earlier in vertical doc
              }
            } else {
              // Horizontal: top-to-bottom first, then left-to-right
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
            isDirty: true
          };

          // Re-number order for all blocks after insert point
          const updatedBlocks = sorted.map((b, i) => {
            const originalOrder = i >= insertIndex ? b.order + 1 : b.order;
            return originalOrder !== b.order ? { ...b, order: originalOrder } : b;
          });

          updatePageData(pageIndex, {
            textBlocks: [...updatedBlocks, newBlock],
            isDirty: true
          });
        }
      }
      toggleDrawingMode();
      return;
    }

    if (draggedId && dragMode !== 'none') {
      // Push undo with the snapshot captured at drag start (correct before state)
      const pageData = document?.pages.get(pageIndex);
      if (pageData && preDragPageRef.current) {
        const action: Action = {
          type: 'update_page',
          pageIndex,
          before: preDragPageRef.current,
          after: { ...pageData },
        };
        pushAction(action);
      }
      preDragPageRef.current = null;
      setDraggedId(null);
      setDragMode('none');
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={`canvas-wrapper ${isDrawingMode ? 'drawing-mode' : ''}`}
      style={{
        position: 'relative',
        display: 'inline-block',
      }}
    >
      <canvas
        ref={pdfCanvasRef}
      />
      <canvas
        ref={overlayCanvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 2,
          cursor: isDrawingMode || isSplitMode ? 'crosshair' : draggedId ? (dragMode === 'move' ? 'move' : 'crosshair') : 'default',
        }}
      />
    </div>
  );
}
