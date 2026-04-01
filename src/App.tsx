import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { usePecoStore } from "./store/pecoStore";
import { FolderOpen, Save, RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize, Plus, Group, Trash2, Eye, Scissors, ClipboardList, Eraser } from "lucide-react";
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { loadPDF, loadPage, loadPecoToolBBoxMeta, openPDF, generateThumbnail } from "./utils/pdfLoader";
import { savePDF } from "./utils/pdfSaver";
import { TextBlock } from "./types";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';

function App() {
  const { document, setDocument, setThumbnail, originalBytes, currentPageIndex, zoom, setZoom, setCurrentPage, updatePageData, selectedIds, clearSelection, showOcr, toggleShowOcr, ocrOpacity, setOcrOpacity, undo, redo, undoStack, redoStack, isDrawingMode, toggleDrawingMode, isSplitMode, toggleSplitMode, isDirty, thumbnails, resetDirty } = usePecoStore();

  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(350);
  const [isAutoFit, setIsAutoFit] = useState(true);
  
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollX: 0, scrollY: 0 });
  const [notification, setNotification] = useState<{ message: string; isError: boolean } | null>(null);

  // Ref bag so the stable one-time event listener can always call the latest function versions
  const actionRefs = useRef<{ handleSave: () => void; handleSaveAs: () => void; handleDelete: () => void }>({
    handleSave: () => {},
    handleSaveAs: () => {},
    handleDelete: () => {},
  });

  const showToast = useCallback((message: string, isError = false) => {
    setNotification({ message, isError });
    setTimeout(() => setNotification(null), 3000);
  }, []);


  const openPreviewWindow = async () => {
    try {
      const windows = await getAllWindows();
      const previewWin = windows.find(w => w.label === 'preview-window');
      
      if (previewWin) {
        // メイン画面のサイズ・位置を取得して、右隣に同じ高さでくっつける
        const mainWin = getCurrentWindow();
        const mainSize = await mainWin.outerSize();
        const mainPos = await mainWin.outerPosition();
        const currentPreviewSize = await previewWin.outerSize();

        const newWidth = currentPreviewSize.width || Math.floor(600 * await mainWin.scaleFactor()); 
        
        await previewWin.setSize(new PhysicalSize(newWidth, mainSize.height));
        await previewWin.setPosition(new PhysicalPosition(mainPos.x + mainSize.width, mainPos.y));

        await previewWin.show();
        await previewWin.setFocus();
      } else {
        const webview = new WebviewWindow('preview-window', {
          url: 'index.html#preview',
          title: 'テキストコピー プレビュー',
          width: 600,
          height: 800,
          center: true
        });
        webview.once('tauri://error', (e) => {
          console.error('Error creating preview window:', e);
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const page = document?.pages.get(currentPageIndex);
  const previewText = useMemo(() => {
    if (!page?.textBlocks) return "";
    const sorted = [...page.textBlocks].sort((a, b) => a.order - b.order);
    let text = "";
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        const isVertical = prev.writingMode === 'vertical';
        if (!isVertical) {
          if (Math.abs(curr.bbox.y - prev.bbox.y) > prev.bbox.height * 0.5) text += "\n";
          else if (curr.bbox.x - (prev.bbox.x + prev.bbox.width) > prev.bbox.height) text += " ";
        } else {
          if (Math.abs(prev.bbox.x - curr.bbox.x) > prev.bbox.width * 0.5) text += "\n";
          else if (Math.abs(curr.bbox.y - (prev.bbox.y + prev.bbox.height)) > prev.bbox.width) text += " ";
        }
      }
      text += curr.text;
    }
    return text;
  }, [page]);

  useEffect(() => {
    // 初回マウント時に自動でプレビューウインドウを開く
    openPreviewWindow();
  }, []);

  useEffect(() => {
    emit('preview-update', previewText).catch(e => console.error(e));
    const setupListener = async () => {
      return await listen('request-preview', () => {
        emit('preview-update', previewText).catch(e => console.error(e));
      });
    };
    let unlistenFn: (() => void) | undefined;
    setupListener().then(fn => unlistenFn = fn);
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [previewText]);

  useEffect(() => {
    if (window.location.hash !== '#preview') {
      const currentWindow = getCurrentWindow();
      let isUnmounted = false;
      let unlistenFn: (() => void) | undefined;
      
      const setupCloseListener = async () => {
        const fn = await currentWindow.onCloseRequested(async () => {
          try {
            const windows = await getAllWindows();
            for (const w of windows) {
              if (w.label !== currentWindow.label) {
                await w.close();
              }
            }
          } catch (e) {
            console.error(e);
          }
        });
        
        if (isUnmounted) {
          fn();
        } else {
          unlistenFn = fn;
        }
      };

      setupCloseListener();
      
      return () => {
        isUnmounted = true;
        if (unlistenFn) unlistenFn();
      };
    }
  }, []);

  useEffect(() => {
    const handleKeyDownGlob = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        setIsSpacePressed(true);
      }
    };
    const handleKeyUpGlob = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
        setIsPanning(false);
      }
    };
    window.addEventListener('keydown', handleKeyDownGlob);
    window.addEventListener('keyup', handleKeyUpGlob);
    return () => {
      window.removeEventListener('keydown', handleKeyDownGlob);
      window.removeEventListener('keyup', handleKeyUpGlob);
    };
  }, []);

  const startResizeLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
      setLeftWidth(Math.max(100, Math.min(500, startWidth + (moveEvent.clientX - startX))));
    };
    const onMouseUp = () => {
      window.document.removeEventListener('mousemove', onMouseMove);
      window.document.removeEventListener('mouseup', onMouseUp);
    };
    window.document.addEventListener('mousemove', onMouseMove);
    window.document.addEventListener('mouseup', onMouseUp);
  };

  const startResizeRight = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightWidth;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
      setRightWidth(Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX))));
    };
    const onMouseUp = () => {
      window.document.removeEventListener('mousemove', onMouseMove);
      window.document.removeEventListener('mouseup', onMouseUp);
    };
    window.document.addEventListener('mousemove', onMouseMove);
    window.document.addEventListener('mouseup', onMouseUp);
  };

  const handleViewerMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed) {
      e.stopPropagation();
      e.preventDefault();
      setIsPanning(true);
      const container = window.document.querySelector('.pdf-viewer-panel');
      if (container) {
        setPanStart({
          x: e.clientX,
          y: e.clientY,
          scrollX: container.scrollLeft,
          scrollY: container.scrollTop
        });
      }
    }
  };

  const handleViewerMouseMove = (e: React.MouseEvent) => {
    if (isPanning && isSpacePressed) {
      e.preventDefault();
      const container = window.document.querySelector('.pdf-viewer-panel');
      if (container) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        container.scrollLeft = panStart.scrollX - dx;
        container.scrollTop = panStart.scrollY - dy;
      }
    }
  };

  const handleViewerMouseUp = () => {
    if (isPanning) setIsPanning(false);
  };

  const fitToScreen = (keepAutoFitState = false) => {
    if (!keepAutoFitState) setIsAutoFit(true);
    const container = window.document.querySelector('.pdf-viewer-panel');
    const pageData = document?.pages.get(currentPageIndex);
    if (container && pageData) {
      const ratioH = (container.clientHeight - 40) / pageData.height;
      const ratioW = (container.clientWidth - 40) / pageData.width;
      const newZoom = Math.floor(Math.min(ratioH, ratioW) * 100);
      setZoom(Math.max(25, newZoom));
    }
  };

  useEffect(() => {
    if (!isAutoFit || !document) return;
    const container = window.document.querySelector('.pdf-viewer-panel');
    if (!container) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (isAutoFit) fitToScreen(true);
      }, 50);
    });
    
    observer.observe(container);
    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
    };
  }, [document, currentPageIndex, isAutoFit]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        fitToScreen(false);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) {
        e.preventDefault();
        setIsAutoFit(false);
        // e.deltaYが正なら下にスクロール（縮小）、負なら上にスクロール（拡大）
        const zoomStep = 10;
        const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
        const newZoom = Math.max(25, Math.min(500, zoom + delta));
        setZoom(newZoom);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // passive: false is required to allow e.preventDefault() for wheel events
    window.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [undo, redo, zoom, setZoom]);

  // Keyboard shortcuts that need stable registration (Ctrl+S, Delete, Ctrl+F)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement).isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (e.shiftKey) actionRefs.current.handleSaveAs();
        else actionRefs.current.handleSave();
      } else if (e.key === 'Delete' && !isEditing) {
        actionRefs.current.handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        window.document.querySelector<HTMLInputElement>('.search-box')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (document && !document.pages.has(currentPageIndex)) {
      loadCurrentPage(currentPageIndex);
    }
  }, [document, currentPageIndex]);

  const loadCurrentPage = async (pageIdx: number) => {
    const { originalBytes } = usePecoStore.getState();
    if (!originalBytes) {
      console.error("[loadCurrentPage] originalBytes is null");
      return;
    }
    try {
      console.log(`[loadCurrentPage] loading page ${pageIdx}, bytes length=${originalBytes.length}`);
      const pdf = await openPDF(originalBytes);
      const bboxMeta = await loadPecoToolBBoxMeta(pdf);
      const pageData = await loadPage(pdf, pageIdx, bboxMeta);
      console.log(`[loadCurrentPage] page ${pageIdx} loaded: ${pageData.textBlocks.length} blocks`);
      updatePageData(pageIdx, pageData, false);
    } catch (err) {
      console.error(`[loadCurrentPage] failed for page ${pageIdx}:`, err);
      alert(`ページ ${pageIdx + 1} のテキスト読み込みに失敗しました:\n${err}`);
    }
  };

  const handleOpen = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });

      if (selected && !Array.isArray(selected)) {
        const content = await readFile(selected);
        const blob = new Blob([content], { type: 'application/pdf' });
        const file = new File([blob], selected.split(/[\\/]/).pop() || 'document.pdf');

        const doc = await loadPDF(file);
        doc.filePath = selected;
        setDocument(doc, content);

        // Open PDF for thumbnails and text extraction
        const pdf = await openPDF(content);

        // Check for PecoTool-saved bbox metadata (enables lossless re-open)
        const bboxMeta = await loadPecoToolBBoxMeta(pdf);

        // Load page 0 text immediately (don't rely on useEffect timing)
        try {
          console.log('[handleOpen] loading page 0 text...');
          const pageData = await loadPage(pdf, 0, bboxMeta);
          console.log(`[handleOpen] page 0: ${pageData.textBlocks.length} text blocks`);
          updatePageData(0, pageData, false);
        } catch (err) {
          console.error('[handleOpen] page 0 text extraction failed:', err);
          alert(`テキスト抽出に失敗しました:\n${err}`);
        }

        // Generate thumbnails sequentially to prevent canvas OOM (black thumbnails)
        (async () => {
          for (let i = 0; i < doc.totalPages; i++) {
            // Add a small delay every 10 pages to let React UI thread breathe
            if (i > 0 && i % 10 === 0) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            try {
              const dataUrl = await generateThumbnail(pdf, i);
              setThumbnail(i, dataUrl);
            } catch (err) {
              console.error("Thumbnail error:", err);
            }
          }
        })();
      }
    } catch (err) {
      console.error("Failed to open file:", err);
    }
  };

  const handleSave = async () => {
    if (!document || !originalBytes) return;
    try {
      const savedBytes = await savePDF(originalBytes, document);
      await writeFile(document.filePath, savedBytes);
      resetDirty();
      showToast("保存しました。");
    } catch (err) {
      console.error("Failed to save:", err);
      showToast("保存に失敗しました。", true);
    }
  };

  const handleSaveAs = async () => {
    if (!document || !originalBytes) return;
    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path) {
        const savedBytes = await savePDF(originalBytes, document);
        await writeFile(path, savedBytes);
        resetDirty();
        showToast("名前を付けて保存しました。");
      }
    } catch (err) {
      console.error("Failed to save as:", err);
    }
  };

  const currentPage = document?.pages.get(currentPageIndex);

  const handleGroup = () => {
    if (!currentPage || selectedIds.size < 2) return;

    const selectedBlocks = currentPage.textBlocks.filter(b => selectedIds.has(b.id));
    const isVertical = selectedBlocks[0].writingMode === 'vertical';
    
    const sortedSelected = [...selectedBlocks].sort((a, b) => {
      if (!isVertical) {
        if (Math.abs(a.bbox.y - b.bbox.y) > a.bbox.height) return a.bbox.y - b.bbox.y;
        return a.bbox.x - b.bbox.x;
      } else {
        if (Math.abs(a.bbox.x - b.bbox.x) > a.bbox.width) return b.bbox.x - a.bbox.x;
        return a.bbox.y - b.bbox.y;
      }
    });

    let combinedText = sortedSelected[0].text;
    
    for (let i = 1; i < sortedSelected.length; i++) {
        const prev = sortedSelected[i - 1];
        const curr = sortedSelected[i];
        
        if (!isVertical) {
            const prevEndX = prev.bbox.x + prev.bbox.width;
            const gap = curr.bbox.x - prevEndX;
            if (gap > 0 && Math.abs(curr.bbox.y - prev.bbox.y) < prev.bbox.height) {
                const fontSize = prev.bbox.height;
                const ems = gap / fontSize;
                const numFull = Math.min(50, Math.floor(ems));
                const numHalf = Math.max(0, Math.round((ems - numFull) * 2));
                combinedText += "　".repeat(numFull) + " ".repeat(numHalf);
            } else if (Math.abs(curr.bbox.y - prev.bbox.y) >= prev.bbox.height) {
                combinedText += " "; 
            }
        } else {
            const prevEndY = prev.bbox.y + prev.bbox.height;
            const gap = curr.bbox.y - prevEndY;
            if (gap > 0 && Math.abs(curr.bbox.x - prev.bbox.x) < prev.bbox.width) {
                const fontSize = prev.bbox.width; 
                const ems = gap / fontSize;
                const numFull = Math.min(50, Math.floor(ems));
                combinedText += "　".repeat(numFull);
            } else if (Math.abs(curr.bbox.x - prev.bbox.x) >= prev.bbox.width) {
                combinedText += " ";
            }
        }
        combinedText += curr.text;
    }
    
    const minX = Math.min(...sortedSelected.map(b => b.bbox.x));
    const minY = Math.min(...sortedSelected.map(b => b.bbox.y));
    const maxX = Math.max(...sortedSelected.map(b => b.bbox.x + b.bbox.width));
    const maxY = Math.max(...sortedSelected.map(b => b.bbox.y + b.bbox.height));

    const insertIndex = Math.min(...sortedSelected.map(b => b.order));

    const newBlock = {
      id: crypto.randomUUID(),
      text: combinedText,
      originalText: "",
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      writingMode: sortedSelected[0].writingMode,
      order: insertIndex,
      isNew: true,
      isDirty: true,
      children: sortedSelected.map(b => b.id)
    };

    const newBlocks = currentPage.textBlocks.filter(b => !selectedIds.has(b.id));
    newBlocks.splice(insertIndex, 0, newBlock);
    
    const finalBlocks = newBlocks.map((b, i) => ({ ...b, order: i }));

    updatePageData(currentPageIndex, { textBlocks: finalBlocks, isDirty: true });
    clearSelection();
  };

  const handleDelete = () => {
    if (!currentPage || selectedIds.size === 0) return;
    const newBlocks = currentPage.textBlocks.filter(b => !selectedIds.has(b.id))
      .map((b, i) => ({ ...b, order: i }));
    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    clearSelection();
  };

  const handleDeduplicate = () => {
    if (!currentPage) return;
    let hasChanges = false;
    const blocksToKeep: TextBlock[] = [];
    
    // Sort so we process in deterministic order
    const sortedBlocks = [...currentPage.textBlocks].sort((a, b) => a.order - b.order);

    for (const block of sortedBlocks) {
      if (selectedIds.size > 0 && !selectedIds.has(block.id)) {
        blocksToKeep.push(block);
        continue;
      }
      
      const isDuplicate = blocksToKeep.some(existing => {
        // Ignore if we process only selected and 'existing' isn't selected
        if (selectedIds.size > 0 && !selectedIds.has(existing.id)) return false;

        // Check text exact match
        if (existing.text.trim() !== block.text.trim()) return false;
        
        // Check BoundingBox heavy overlap (e.g. within 5 pixels)
        const dx = Math.abs(existing.bbox.x - block.bbox.x);
        const dy = Math.abs(existing.bbox.y - block.bbox.y);
        const dw = Math.abs(existing.bbox.width - block.bbox.width);
        const dh = Math.abs(existing.bbox.height - block.bbox.height);
        
        return dx < 5 && dy < 5 && dw < 5 && dh < 5;
      });
      
      if (isDuplicate) {
        hasChanges = true;
      } else {
        blocksToKeep.push(block);
      }
    }

    if (hasChanges) {
      const finalBlocks = blocksToKeep.map((b, i) => ({ ...b, order: i }));
      updatePageData(currentPageIndex, { textBlocks: finalBlocks, isDirty: true });
    }
  };

  // Keep action refs fresh every render so the stable event listener calls the latest closures
  actionRefs.current.handleSave = handleSave;
  actionRefs.current.handleSaveAs = handleSaveAs;
  actionRefs.current.handleDelete = handleDelete;

  return (
    <div className="app-container">
      {/* Toolbar */}
      <header className="toolbar">
        <div className="toolbar-group">
          <button onClick={handleOpen} title="開く"><FolderOpen size={18} /><span>開く</span></button>
          <button 
            onClick={handleSave} 
            title="保存" 
            disabled={!document || (!isDirty && !currentPage?.isDirty)}
          >
            <Save size={18} />
            <span>保存</span>
          </button>
          <button 
            onClick={handleSaveAs} 
            title="名前を付けて保存" 
            disabled={!document}
          >
            <Save size={18} />
            <span>別名で保存</span>
          </button>
        </div>
        <div className="divider" />
        <div className="toolbar-group">
          <button onClick={undo} disabled={undoStack.length === 0} title="元に戻す (Ctrl+Z)"><RotateCcw size={18} /></button>
          <button onClick={redo} disabled={redoStack.length === 0} title="やり直し (Ctrl+Y)"><RotateCw size={18} /></button>
        </div>
        <div className="divider" />
        <div className="toolbar-group">
          <button onClick={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom + 10)); }} title="拡大"><ZoomIn size={18} /></button>
          <button onClick={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom - 10)); }} title="縮小"><ZoomOut size={18} /></button>
          <button onClick={() => fitToScreen(false)} title="フィット (Ctrl+0)" className={isAutoFit ? "active" : ""}><Maximize size={18} /></button>
        </div>
        <div className="divider" />
        <div className="toolbar-group">
          <button 
            onClick={toggleDrawingMode} 
            title="BB追加" 
            className={isDrawingMode ? "active" : ""}
            disabled={!document}
          >
            <Plus size={18} />
            <span>追加</span>
          </button>
          <button 
            onClick={toggleSplitMode} 
            title="BB分割 (枠内のクリックした位置で分割)" 
            className={isSplitMode ? "active" : ""}
            disabled={!document}
          >
            <Scissors size={18} />
            <span>分割</span>
          </button>
          <button onClick={handleGroup} title="グループ化" disabled={selectedIds.size < 2}><Group size={18} /><span>グループ化</span></button>
          <button onClick={handleDeduplicate} title="重なっている重複レイヤーを削除"><Eraser size={18} /><span>重複削除</span></button>
          <button onClick={handleDelete} title="削除" className="danger" disabled={selectedIds.size === 0}><Trash2 size={18} /></button>
        </div>
        <div className="divider" />
        <div className="toolbar-group">
          <button 
            onClick={toggleShowOcr} 
            title="OCR表示" 
            className={showOcr ? "active" : ""}
          >
            <Eye size={18} />
            <span>OCR表示</span>
          </button>
          {showOcr && (
            <label className="ocr-opacity-label" title="OCR表示の濃さ">
              <span>濃さ</span>
              <input
                type="range"
                className="ocr-opacity-slider"
                min="0.05"
                max="1"
                step="0.05"
                value={ocrOpacity}
                onChange={(e) => setOcrOpacity(parseFloat(e.target.value))}
              />
              <span>{Math.round(ocrOpacity * 100)}%</span>
            </label>
          )}
          <button 
            onClick={openPreviewWindow} 
            title="コピペプレビューを別ウィンドウで開く"
            className="feature-btn"
            disabled={!document}
          >
            <ClipboardList size={18} />
            <span>別ウインドウで確認</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        <aside className="thumbnails-panel" style={{ width: `${leftWidth}px` }}>
          <div className="panel-header">サムネイル</div>
          <div 
            className="scroll-content"
            tabIndex={0}
            onKeyDown={(e) => {
              if (!document) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                if (currentPageIndex < document.totalPages - 1) {
                  setCurrentPage(currentPageIndex + 1);
                }
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                if (currentPageIndex > 0) {
                  setCurrentPage(currentPageIndex - 1);
                }
              }
            }}
          >
            {document ? (
              Array.from({ length: document.totalPages }).map((_, i) => (
                <div 
                  key={i} 
                  className={`thumbnail-item ${i === currentPageIndex ? 'active' : ''}`}
                  onClick={() => setCurrentPage(i)}
                >
                  <div className="thumbnail-box">
                    {thumbnails.get(i)
                      ? <img src={thumbnails.get(i)} alt={`Page ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <span style={{ color: '#d1d5db', fontSize: 24 }}>{i + 1}</span>
                    }
                  </div>
                  <div className="thumbnail-label">{i + 1} ページ {document.pages.get(i)?.isDirty && "●"}</div>
                </div>
              ))
            ) : (
              <div className="placeholder">なし</div>
            )}
          </div>
        </aside>

        <div className="resizer" onMouseDown={startResizeLeft} />

        <section 
          className={`pdf-viewer-panel ${isSpacePressed ? (isPanning ? 'grabbing' : 'grab') : ''}`}
          onMouseDown={handleViewerMouseDown}
          onMouseMove={handleViewerMouseMove}
          onMouseUp={handleViewerMouseUp}
          onMouseLeave={handleViewerMouseUp}
        >
          <div className="pdf-canvas-container">
            {document ? (
              <PdfCanvas pageIndex={currentPageIndex} disableDrawing={isSpacePressed} />
            ) : (
              <div className="empty-state">
                <p>PDFファイルを [開く] から読み込んでください</p>
              </div>
            )}
          </div>
        </section>

        <div className="resizer" onMouseDown={startResizeRight} />

        <OcrEditor width={rightWidth} />
      </main>

      {/* Status Bar */}
      <footer className="status-bar">
        <div className="status-item">ページ: {document ? `${currentPageIndex + 1} / ${document.totalPages}` : "0 / 0"}</div>
        <div className="status-item">ズーム: {zoom}%</div>
        <div className="status-item">BB数: {currentPage?.textBlocks?.length || 0}</div>
        <div className="status-item flex-grow" />
        {(isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
      </footer>

      {notification && (
        <div className={`toast ${notification.isError ? 'toast-error' : 'toast-success'}`}>
          {notification.message}
        </div>
      )}
    </div>
  );
}

export default App;
