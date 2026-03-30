import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import { usePecoStore } from "../store/pecoStore";
import { TextBlock } from "../types";

interface PdfCanvasProps {
  pageIndex: number;
}

export function PdfCanvas({ pageIndex }: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { document, originalBytes, zoom, showOcr, selectedIds, isDrawingMode, updatePageData, toggleDrawingMode, toggleSelection } = usePecoStore();
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
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  useEffect(() => {
    if (!pdfPage || !canvasRef.current) return;

    const render = async () => {
      const canvas = canvasRef.current!;
      const context = canvas.getContext('2d')!;
      
      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      };

      await pdfPage.render(renderContext).promise;

      // Draw OCR Overlays
      const pageData = document?.pages.get(pageIndex);
      if (showOcr && pageData && pageData.textBlocks) {
        pageData.textBlocks.forEach(block => {
          const isSelected = selectedIds.has(block.id);
          context.strokeStyle = isSelected ? "rgba(0, 120, 255, 0.8)" : "rgba(255, 0, 0, 0.3)";
          context.lineWidth = isSelected ? 2 : 1;
          
          const x = block.bbox.x * (zoom / 100);
          const y = block.bbox.y * (zoom / 100);
          const w = block.bbox.width * (zoom / 100);
          const h = block.bbox.height * (zoom / 100);

          if (isSelected) {
            context.fillStyle = "rgba(0, 120, 255, 0.1)";
            context.fillRect(x, y, w, h);
            
            // Draw resize handles for selected block
            context.fillStyle = "white";
            context.strokeStyle = "rgba(0, 120, 255, 1)";
            const handleSize = 6;
            [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
              context.fillRect(hx - handleSize/2, hy - handleSize/2, handleSize, handleSize);
              context.strokeRect(hx - handleSize/2, hy - handleSize/2, handleSize, handleSize);
            });
          }

          context.strokeRect(x, y, w, h);
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

    render();
  }, [pdfPage, zoom, document, pageIndex, showOcr, selectedIds, isDrawing, startPos, currentPos, draggedId]);

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
      if (canvasRef.current) canvasRef.current.style.cursor = hoverCursor;
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
            writingMode: "horizontal",
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
    <div className={`canvas-wrapper ${isDrawingMode ? 'drawing-mode' : ''}`} style={{ transform: `scale(1)`, transformOrigin: 'top left' }}>
      <canvas 
        ref={canvasRef} 
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDrawingMode ? 'crosshair' : draggedId ? (dragMode === 'move' ? 'move' : 'crosshair') : 'default' }}
      />
    </div>
  );
}
