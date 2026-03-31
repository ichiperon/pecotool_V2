import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import { usePecoStore } from "../store/pecoStore";
import { TextBlock } from "../types";

interface PdfCanvasProps {
  pageIndex: number;
}

export function PdfCanvas({ pageIndex }: PdfCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const { document, originalBytes, zoom, showOcr, selectedIds, isDrawingMode, isSplitMode, updatePageData, toggleDrawingMode, toggleSplitMode, toggleSelection } = usePecoStore();
  const [pdfPage, setPdfPage] = useState<pdfjsLib.PDFPageProxy | null>(null);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });

  // Moving/Resizing state
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'>('none');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragStartBbox, setDragStartBbox] = useState<any>(null);
  const [dragStartMouse, setDragStartMouse] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!originalBytes) return;

    const loadPage = async () => {
      try {
        const loadingTask = pdfjsLib.getDocument({ data: originalBytes.slice() });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(pageIndex + 1);
        setPdfPage(page);
      } catch (err) {
        console.error("Error loading PDF page:", err);
      }
    };

    loadPage();
  }, [originalBytes, pageIndex]);

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

          // AcrobatのCtrl+Aっぽい視認性を確保するための背景ハイライト（薄い青）
          context.fillStyle = isSelected ? "rgba(0, 100, 255, 0.25)" : "rgba(0, 150, 255, 0.1)";
          context.fillRect(x, y, w, h);

          context.strokeStyle = isSelected ? "rgba(0, 100, 255, 0.9)" : "rgba(255, 0, 0, 0.4)";
          context.lineWidth = isSelected ? 2 : 1;
          context.strokeRect(x, y, w, h);

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
            const fontSize = Math.max(10, h * 0.8);
            context.font = `bold ${fontSize}px sans-serif`;
            context.textBaseline = "top";
            
            // Outline for readability
            context.lineWidth = 3;
            context.strokeStyle = "rgba(255, 255, 255, 0.9)";
            context.strokeText(block.text, x, y + 2, w);
            
            // Fill
            context.fillStyle = isSelected ? "rgba(0, 50, 255, 0.9)" : "rgba(255, 0, 0, 0.7)";
            context.fillText(block.text, x, y + 2, w);
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
  }, [zoom, document, pageIndex, showOcr, selectedIds, isDrawing, startPos, currentPos, draggedId, pdfPage]);

  const handleMouseDown = (e: React.MouseEvent) => {
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
    if (isDrawing) {
      setIsDrawing(false);
      const x = Math.min(startPos.x, currentPos.x) / (zoom / 100);
      const y = Math.min(startPos.y, currentPos.y) / (zoom / 100);
      const width = Math.abs(currentPos.x - startPos.x) / (zoom / 100);
      const height = Math.abs(currentPos.y - startPos.y) / (zoom / 100);

      if (width > 2 && height > 2) {
        const pageData = document?.pages.get(pageIndex);
        if (pageData) {
          const newBlock: TextBlock = {
            id: crypto.randomUUID(),
            text: "",
            originalText: "",
            bbox: { x, y, width, height },
            writingMode: height > width * 1.5 ? "vertical" : "horizontal",
            order: pageData.textBlocks.length,
            isNew: true,
            isDirty: true
          };
          updatePageData(pageIndex, { 
            textBlocks: [...pageData.textBlocks, newBlock],
            isDirty: true 
          });
        }
      }
      toggleDrawingMode();
      return;
    }

    if (draggedId && dragMode !== 'none') {
      // Finalize the drag and push to undoStack
      const pageData = document?.pages.get(pageIndex);
      if (pageData) {
        updatePageData(pageIndex, { textBlocks: pageData.textBlocks, isDirty: true }, true);
      }
      setDraggedId(null);
      setDragMode('none');
    }
  };

  return (
    <div className={`canvas-wrapper ${isDrawingMode ? 'drawing-mode' : ''}`} style={{ position: 'relative', display: 'inline-block', transform: `scale(1)`, transformOrigin: 'top left' }}>
      <canvas 
        ref={pdfCanvasRef} 
        style={{ display: 'block' }}
      />
      <canvas 
        ref={overlayCanvasRef} 
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, cursor: isDrawingMode || isSplitMode ? 'crosshair' : draggedId ? (dragMode === 'move' ? 'move' : 'crosshair') : 'default' }}
      />
    </div>
  );
}
