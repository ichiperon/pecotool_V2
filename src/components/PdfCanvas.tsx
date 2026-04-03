import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import { usePecoStore } from "../store/pecoStore";
import { Action, PageData, TextBlock } from "../types";
import { classifyDirection, getDirectionLabel, reorderBlocks } from "../utils/bulkReorder";
import { getCachedPageProxy } from "../utils/pdfLoader";

interface PdfCanvasProps {
  pageIndex: number;
  disableDrawing?: boolean;
}

// Use shared configuration for CMaps and fonts

export function PdfCanvas({ pageIndex, disableDrawing = false }: PdfCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { document, zoom, showOcr, ocrOpacity, selectedIds, isDrawingMode, isSplitMode, updatePageData, toggleDrawingMode, toggleSplitMode, toggleSelection, pushAction } = usePecoStore();
  const [pdfPage, setPdfPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });

  // Alt+Drag Reorder state
  const [isAltDragging, setIsAltDragging] = useState(false);
  const [altDragStart, setAltDragStart] = useState({ x: 0, y: 0 });
  const [altDragEnd, setAltDragEnd] = useState({ x: 0, y: 0 });

  // Moving/Resizing state
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'>('none');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragStartBbox, setDragStartBbox] = useState<any>(null); // For single block resizing
  const [dragStartBboxes, setDragStartBboxes] = useState<Map<string, {x: number, y: number, width: number, height: number}>>(new Map()); // For multiple block moving
  const [dragStartMouse, setDragStartMouse] = useState({ x: 0, y: 0 });
  const preDragPageRef = useRef<PageData | null>(null);

  // Combined effect to load PDF document and page (optimized)
  useEffect(() => {
    if (!document?.filePath) {
      setPdfPage(null);
      return;
    }
    
    let cancelled = false;
    // console.log(`[PdfCanvas] Loading page ${pageIndex} for ${document.filePath}`);

    (async () => {
      try {
        // 使用 getCachedPageProxy (Memory Cache)
        const page = await getCachedPageProxy(document.filePath, pageIndex);
        if (cancelled) return;
        
        setPdfPage(page);
      } catch (err) {
        if (!cancelled) console.error("Error loading PDF page:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [document?.filePath, pageIndex]); // Combined dependency array

  const getMousePos = (e: React.MouseEvent) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  // 選択されたブロックへの自動スクロール
  useEffect(() => {
    // ドラッグ中（移動・サイズ調整中）は自動スクロールさせない
    if (selectedIds.size !== 1 || draggedId) return;
    const selectedId = Array.from(selectedIds)[0];
    const pageData = document?.pages.get(pageIndex);
    const block = pageData?.textBlocks.find(b => b.id === selectedId);
    if (!block) return;

    const container = window.document.querySelector('.pdf-viewer-panel');
    if (!container) return;

    const scale = zoom / 100;
    const x = block.bbox.x * scale;
    const y = block.bbox.y * scale;
    const w = block.bbox.width * scale;
    const h = block.bbox.height * scale;

    // コンテナ内での相対位置を計算して中央に持ってくる
    const containerRect = container.getBoundingClientRect();
    const targetX = x - containerRect.width / 2 + w / 2;
    const targetY = y - containerRect.height / 2 + h / 2;

    container.scrollTo({
      left: Math.max(0, targetX),
      top: Math.max(0, targetY),
      behavior: 'smooth'
    });
  }, [selectedIds, zoom, document, pageIndex]);

  // Overlay rendering function (called both from its own effect and after PDF render completes)
  const renderOverlaysRef = useRef<(() => void) | null>(null);

  // PDF Layer Rendering
  useEffect(() => {
    if (!pdfPage || !pdfCanvasRef.current) return;

    const renderPdf = async () => {
      const canvas = pdfCanvasRef.current!;
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false })!;

      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

      canvas.width = w;
      canvas.height = h;

      // PDFの白背景化（描画高速化）
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, w, h);

      // Update overlay dimensions to match
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = w;
        overlayCanvasRef.current.height = h;
      }

      // Sync CSS display size directly via DOM to avoid React async timing issues
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
        viewport: viewport, // Use original viewport for rendering
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
      // PDF描画完了後にオーバーレイを再描画（キャンバスサイズリセットによる消去を防ぐ）
      renderOverlaysRef.current?.();
    };

    // ズーム連続変更時の無駄なワーカー呼び出しを防ぐ30msデバウンス
    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    renderDebounceRef.current = setTimeout(() => { renderPdf(); }, 30);

    return () => {
      if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
      renderTaskRef.current?.cancel();
    };
  }, [pdfPage, zoom]);

  // Overlay Layer Rendering
  useEffect(() => {
    if (!overlayCanvasRef.current || !pdfPage) return;

    const renderOverlays = () => {
      if (!overlayCanvasRef.current) return;
      const canvas = overlayCanvasRef.current;
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

          // opacity を ocrOpacity で制御（選択時は2倍明るく、上限1.0）
          const baseAlpha = isSelected ? Math.min(1.0, ocrOpacity * 2) : ocrOpacity;
          const fillAlpha = isSelected ? Math.min(0.4, ocrOpacity * 0.625) : ocrOpacity * 0.25;

          context.fillStyle = `rgba(${isSelected ? '0, 100, 255' : '0, 150, 255'}, ${fillAlpha})`;
          context.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

          context.strokeStyle = `rgba(${isSelected ? '0, 100, 255' : '255, 0, 0'}, ${isSelected ? Math.min(1.0, baseAlpha * 1.125) : baseAlpha})`;
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

      // Draw Alt+Drag overlay
      if (isAltDragging) {
        context.strokeStyle = "rgba(255, 165, 0, 0.9)";
        context.lineWidth = 2;
        context.setLineDash([5, 5]);
        context.beginPath();
        context.moveTo(altDragStart.x, altDragStart.y);
        context.lineTo(altDragEnd.x, altDragEnd.y);
        context.stroke();
        context.setLineDash([]);
        
        const angle = Math.atan2(altDragEnd.y - altDragStart.y, altDragEnd.x - altDragStart.x);
        context.beginPath();
        context.moveTo(altDragEnd.x, altDragEnd.y);
        context.lineTo(altDragEnd.x - 12 * Math.cos(angle - Math.PI / 6), altDragEnd.y - 12 * Math.sin(angle - Math.PI / 6));
        context.lineTo(altDragEnd.x - 12 * Math.cos(angle + Math.PI / 6), altDragEnd.y - 12 * Math.sin(angle + Math.PI / 6));
        context.closePath();
        context.fillStyle = "rgba(255, 165, 0, 0.9)";
        context.fill();

        const dx = altDragEnd.x - altDragStart.x;
        const dy = altDragEnd.y - altDragStart.y;
        const dir = classifyDirection(dx, dy);
        if (dir) {
          const label = getDirectionLabel(dir);
          context.font = "bold 16px sans-serif";
          context.textBaseline = "middle";
          context.fillStyle = "white";
          context.strokeStyle = "rgba(0,0,0,0.8)";
          context.lineWidth = 4;
          context.strokeText(label, altDragEnd.x + 15, altDragEnd.y);
          context.fillText(label, altDragEnd.x + 15, altDragEnd.y);
        }
      }
    };

    // refを更新して PDF 描画完了後も最新の描画関数を呼べるようにする
    renderOverlaysRef.current = renderOverlays;
    renderOverlays();
  }, [zoom, document, pageIndex, showOcr, ocrOpacity, selectedIds, isDrawing, startPos, currentPos, draggedId, pdfPage, isAltDragging, altDragStart, altDragEnd]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disableDrawing) return;
    const pos = getMousePos(e);
    const scale = zoom / 100;
    const pageData = document?.pages.get(pageIndex);
    
    if (e.altKey && !isDrawingMode && !isSplitMode) {
      setIsAltDragging(true);
      setAltDragStart(pos);
      setAltDragEnd(pos);
      return;
    }

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
          // Ctrl+クリックで既選択ブロックをクリック → 選択解除のみ（ドラッグ開始しない）
          if ((e.ctrlKey || e.metaKey) && selectedIds.has(block.id)) {
            toggleSelection(block.id, true);
            return;
          }

          let curSelectedIds = selectedIds;
          if (!selectedIds.has(block.id)) {
            toggleSelection(block.id, e.ctrlKey || e.metaKey || e.shiftKey);
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              curSelectedIds = new Set(selectedIds);
              curSelectedIds.add(block.id);
            } else {
              curSelectedIds = new Set([block.id]);
            }
          }
          const pg = document?.pages.get(pageIndex);
          preDragPageRef.current = pg ? { ...pg, textBlocks: [...pg.textBlocks] } : null;
          setDraggedId(block.id);
          setDragMode('move');
          setDragStartBbox({ ...block.bbox });

          const newBboxes = new Map();
          pg?.textBlocks.forEach(b => {
             if (curSelectedIds.has(b.id)) {
                newBboxes.set(b.id, { ...b.bbox });
             }
          });
          setDragStartBboxes(newBboxes);
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

    if (isAltDragging) {
      setAltDragEnd(pos);
      return;
    }

    if (isDrawing) {
      setCurrentPos(pos);
      return;
    }

    if (draggedId && dragMode !== 'none') {
      const dx = (pos.x - dragStartMouse.x) / scale;
      const dy = (pos.y - dragStartMouse.y) / scale;
      const pageData = document?.pages.get(pageIndex);
      if (!pageData) return;

      if (dragMode === 'move') {
        const newBlocks = pageData.textBlocks.map(b => {
          if (dragStartBboxes.has(b.id)) {
            const startBbox = dragStartBboxes.get(b.id)!;
            return {
              ...b,
              bbox: {
                ...startBbox,
                x: startBbox.x + dx,
                y: startBbox.y + dy
              },
              isDirty: true
            };
          }
          return b;
        });
        updatePageData(pageIndex, { textBlocks: newBlocks }, false);
      } else {
        const newBbox = { ...dragStartBbox };
        if (dragMode === 'resize-se') {
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
      }
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

    if (isAltDragging) {
      setIsAltDragging(false);
      const dx = altDragEnd.x - altDragStart.x;
      const dy = altDragEnd.y - altDragStart.y;
      const dir = classifyDirection(dx, dy);
      if (dir) {
        const pageData = document?.pages.get(pageIndex);
        if (pageData && pageData.textBlocks.length > 0) {
          const stored = localStorage.getItem('peco-reorder-threshold');
          const percent = stored ? parseInt(stored, 10) : 50;
          const newBlocks = reorderBlocks([...pageData.textBlocks], dir, percent);
          updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true }, true);
        }
      }
      return;
    }

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
