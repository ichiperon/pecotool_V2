import React, { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import "./App.css";
import { usePecoStore } from "./store/pecoStore";
import { MousePointer2, Terminal } from "lucide-react";
import { ask } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { generateThumbnail, loadPecoToolBBoxMeta, loadPage, getSharedPdfProxy, destroySharedPdfProxy } from "./utils/pdfLoader";
import { estimateSizes } from "./utils/pdfSaver";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
import { SaveDialog } from "./components/SaveDialog";
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { TextBlock } from "./types";

// Hooks
import { useFileOperations } from "./hooks/useFileOperations";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useConsoleLogs } from "./hooks/useConsoleLogs";
import { usePreviewWindow } from "./hooks/usePreviewWindow";
import { useFontLoader } from "./hooks/useFontLoader";

// Components
import { Toolbar } from "./components/Toolbar/Toolbar";
import { ThumbnailPanel } from "./components/Sidebar/ThumbnailPanel";
import { ConsolePanel } from "./components/Console/ConsolePanel";

function App() {
  const { 
    document, currentPageIndex, zoom, setZoom, 
    setCurrentPage, updatePageData, selectedIds, showOcr, toggleShowOcr, 
    ocrOpacity, setOcrOpacity, undo, redo, undoStack, redoStack, 
    isDrawingMode, toggleDrawingMode, isSplitMode, toggleSplitMode, 
    isDirty, thumbnails, copySelected, pasteClipboard 
  } = usePecoStore();

  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(400);
  const [isAutoFit, setIsAutoFit] = useState(true);
  
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollX: 0, scrollY: 0 });
  const [notification, setNotification] = useState<{ message: string; isError: boolean } | null>(null);
  const [helpMenu, setHelpMenu] = useState<{ x: number, y: number, visible: boolean }>({ x: 0, y: 0, visible: false });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [isEstimating, setIsEstimating] = useState(false);
  const [estimatedSizes, setEstimatedSizes] = useState<{ uncompressed: number; compressed: number } | null>(null);

  const [reorderThreshold, setReorderThreshold] = useState(() => {
    const stored = localStorage.getItem('peco-reorder-threshold');
    return stored ? parseInt(stored, 10) : 50;
  });

  const showToast = useCallback((message: string, isError = false) => {
    setNotification({ message, isError });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // --- External Hooks ---
  useFontLoader();
  const { logs, showConsole, setShowConsole, clearLogs } = useConsoleLogs();
  const { isPreviewOpen, togglePreviewWindow, initPreviewWindow } = usePreviewWindow();
  const { handleOpen, handleSave, executeSaveAs } = useFileOperations(showToast);

  const currentPage = document?.pages.get(currentPageIndex);

  // --- Handlers ---
  const handleSaveAs = async () => {
    if (!document) return;
    setShowSaveDialog(true);
    setIsEstimating(true);
    setEstimatedSizes(null);
    try {
      const content = await readFile(document.filePath);
      const bytes = new Uint8Array(content);
      const sizes = await estimateSizes(bytes, document);
      setEstimatedSizes(sizes);
    } catch (err) {
      console.error("Failed to estimate sizes:", err);
    } finally {
      setIsEstimating(false);
    }
  };

  const handleClose = useCallback(async () => {
    if (isDirty || Array.from(document?.pages.values() || []).some(p => p.isDirty)) {
      const confirmed = await ask('未保存の変更があります。閉じてもよろしいですか？', {
        title: '閉じる確認',
        kind: 'warning'
      });
      if (!confirmed) return;
    }
    destroySharedPdfProxy();
    usePecoStore.getState().setDocument(null);
  }, [document, isDirty]);

  const viewerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const fitToScreen = (keepAutoFitState = false) => {
    if (!keepAutoFitState) setIsAutoFit(true);
    const container = viewerRef.current;
    const pageData = document?.pages.get(currentPageIndex);
    if (container && pageData) {
      const ratioH = (container.clientHeight - 40) / pageData.height;
      const ratioW = (container.clientWidth - 40) / pageData.width;
      const newZoom = Math.floor(Math.min(ratioH, ratioW) * 100);
      setZoom(Math.max(25, newZoom));
    }
  };

  const handleDelete = () => {
    if (selectedIds.size === 0 || !currentPage) return;
    const newBlocks = currentPage.textBlocks.filter(b => !selectedIds.has(b.id));
    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    usePecoStore.getState().clearSelection();
  };

  const handleDeduplicate = () => {
    if (!currentPage) return;
    const blocks = [...currentPage.textBlocks];
    const toKeep: TextBlock[] = [];
    const seen = new Set<string>();

    blocks.forEach(b => {
      const key = `${b.text}-${b.bbox.x}-${b.bbox.y}-${b.bbox.width}-${b.bbox.height}`;
      if (!seen.has(key)) {
        seen.add(key);
        toKeep.push(b);
      }
    });

    if (toKeep.length !== blocks.length) {
      updatePageData(currentPageIndex, { textBlocks: toKeep, isDirty: true });
      showToast(`${blocks.length - toKeep.length}個の重複を削除しました。`);
    } else {
      showToast("重複は見つかりませんでした。");
    }
  };

  const handleGroup = () => {
    if (selectedIds.size < 2 || !currentPage) return;
    const selectedBlocks = currentPage.textBlocks.filter(b => selectedIds.has(b.id));
    
    const minX = Math.min(...selectedBlocks.map(b => b.bbox.x));
    const minY = Math.min(...selectedBlocks.map(b => b.bbox.y));
    const maxX = Math.max(...selectedBlocks.map(b => b.bbox.x + b.bbox.width));
    const maxY = Math.max(...selectedBlocks.map(b => b.bbox.y + b.bbox.height));

    const newBlock: TextBlock = {
      id: crypto.randomUUID(),
      text: selectedBlocks.map(b => b.text).join(''),
      originalText: selectedBlocks.map(b => b.originalText).join(''),
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      writingMode: selectedBlocks[0].writingMode,
      order: Math.min(...selectedBlocks.map(b => b.order)),
      isNew: true,
      isDirty: true
    };

    const remainingBlocks = currentPage.textBlocks.filter(b => !selectedIds.has(b.id));
    const updatedBlocks = [...remainingBlocks, newBlock].sort((a, b) => a.order - b.order).map((b, i) => ({ ...b, order: i }));

    updatePageData(currentPageIndex, { textBlocks: updatedBlocks, isDirty: true });
    usePecoStore.getState().setSelectedIds([newBlock.id]);
    showToast(`${selectedBlocks.length}個のブロックをグループ化しました。`);
  };

  // --- useKeyboardShortcuts ---
  useKeyboardShortcuts({
    undo, redo, fitToScreen, handleSave, handleSaveAs, copySelected, 
    pasteClipboard, handleDelete, toggleDrawingMode, toggleSplitMode, 
    handleGroup, setZoom, zoom, setIsAutoFit,
    searchInputRef
  });

  const latestLoadRef = useRef<number>(-1);

  const thumbnailQueueRef = useRef<number[]>([]);
  const isThumbnailProcessingRef = useRef<boolean>(false);

  const processThumbnailQueue = useCallback(async () => {
    if (isThumbnailProcessingRef.current || !document) return;
    isThumbnailProcessingRef.current = true;

    try {
      let pdfProxy: pdfjsLib.PDFDocumentProxy | null = null;

      while (thumbnailQueueRef.current.length > 0) {
        const pageIdx = thumbnailQueueRef.current.shift()!;
        const state = usePecoStore.getState();
        if (state.thumbnails.has(pageIdx)) continue;

        // Uses URL-based shared proxy (much faster, no readFile needed)
        pdfProxy = await getSharedPdfProxy(document.filePath);

        const dataUrl = await generateThumbnail(pdfProxy, pageIdx);
        usePecoStore.getState().setThumbnail(pageIdx, dataUrl);
      }
    } catch (err) {
      console.error("Thumbnail error:", err);
    } finally {
      isThumbnailProcessingRef.current = false;
      if (thumbnailQueueRef.current.length > 0) {
        setTimeout(processThumbnailQueue, 0); // Next tick
      }
    }
  }, [document]);

  const thumbnailTimerRef = useRef<NodeJS.Timeout | null>(null);

  const requestThumbnail = useCallback((pageIndex: number) => {
    const state = usePecoStore.getState();
    if (state.thumbnails.has(pageIndex) || !document) return;
    
    if (!thumbnailQueueRef.current.includes(pageIndex)) {
      thumbnailQueueRef.current.push(pageIndex);
    }

    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);
    thumbnailTimerRef.current = setTimeout(() => {
      processThumbnailQueue();
    }, 300); // メイン画像のレンダリングを優先させるため300ms遅延
  }, [processThumbnailQueue, document]);

    const loadCurrentPage = useCallback(async (pageIdx: number) => {
    latestLoadRef.current = pageIdx;
    await new Promise(resolve => setTimeout(resolve, 50));
    if (latestLoadRef.current !== pageIdx) return;

    if (!document) return;

    try {
      // Uses URL-based shared proxy (much faster, no readFile needed)
      const pdf = await getSharedPdfProxy(document.filePath);

      if (latestLoadRef.current !== pageIdx) return;

      const bboxMeta = await loadPecoToolBBoxMeta(pdf);
      const pageData = await loadPage(pdf, pageIdx, document.filePath, bboxMeta);

      if (latestLoadRef.current === pageIdx) {
        updatePageData(pageIdx, pageData, false);
      }
    } catch (err: any) {
      if (latestLoadRef.current !== pageIdx) return;
      console.error(`[loadCurrentPage] failed for page ${pageIdx}:`, err);
      showToast(`ページ ${pageIdx + 1} の読み込みに失敗しました: ${err}`, true);
    }
  }, [document, updatePageData, showToast]);

  useEffect(() => {
    if (document && !document.pages.has(currentPageIndex)) {
      loadCurrentPage(currentPageIndex);
    }
  }, [document, currentPageIndex, loadCurrentPage]);

  // --- Effects ---
  useEffect(() => {
    const saved = localStorage.getItem('peco-recent-files');
    if (saved) setRecentFiles(JSON.parse(saved));
    initPreviewWindow();
  }, [initPreviewWindow]);

  useEffect(() => {
    if (window.location.hash !== '#preview') {
      const currentWindow = getCurrentWindow();
      const setupCloseListener = async () => {
        await currentWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          const state = usePecoStore.getState();
          const hasDirtyPages = Array.from(state.document?.pages.values() || []).some(p => p.isDirty);
          if (state.isDirty || hasDirtyPages) {
            const confirmed = await ask('未保存の変更があります。終了してもよろしいですか？', {
              title: '終了の確認', kind: 'warning'
            });
            if (!confirmed) return;
          }
          const windows = await getAllWindows();
          for (const w of windows) if (w.label !== currentWindow.label) await w.close();
          await currentWindow.destroy();
        });
      };
      setupCloseListener();
    }
  }, []);

  useEffect(() => {
    const handleKeyDownGlob = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;
      if (e.code === 'Space' && !isEditing) { e.preventDefault(); setIsSpacePressed(true); }
    };
    const handleKeyUpGlob = (e: KeyboardEvent) => {
      if (e.code === 'Space') { setIsSpacePressed(false); setIsPanning(false); }
    };
    window.addEventListener('keydown', handleKeyDownGlob);
    window.addEventListener('keyup', handleKeyUpGlob);
    return () => {
      window.removeEventListener('keydown', handleKeyDownGlob);
      window.removeEventListener('keyup', handleKeyUpGlob);
    };
  }, []);

  useEffect(() => {
    if (!isAutoFit || !document) return;
    const container = viewerRef.current;
    if (!container) return;
    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (isAutoFit) fitToScreen(true);
      });
    });
    observer.observe(container);
    return () => { observer.disconnect(); cancelAnimationFrame(rafId); };
  }, [document, currentPageIndex, isAutoFit]);

  // --- Resizing ---
  const startResizeLeft = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = leftWidth;
    const onMouseMove = (moveEvent: MouseEvent) => setLeftWidth(Math.max(100, Math.min(500, startWidth + (moveEvent.clientX - startX))));
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const startResizeRight = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = rightWidth;
    const onMouseMove = (moveEvent: MouseEvent) => setRightWidth(Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX))));
    const onMouseUp = () => { window.removeEventListener('mouseup', onMouseUp); window.removeEventListener('mousemove', onMouseMove); };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleViewerMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed) {
      e.stopPropagation(); e.preventDefault();
      setIsPanning(true);
      const container = viewerRef.current;
      if (container) setPanStart({ x: e.clientX, y: e.clientY, scrollX: container.scrollLeft, scrollY: container.scrollTop });
    }
  };

  const handleViewerMouseMove = (e: React.MouseEvent) => {
    if (isPanning && isSpacePressed) {
      e.preventDefault();
      const container = viewerRef.current;
      if (container) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        container.scrollLeft = panStart.scrollX - dx;
        container.scrollTop = panStart.scrollY - dy;
      }
    }
  };

  return (
    <div 
      className="app-container"
      onContextMenu={(e) => { e.preventDefault(); setHelpMenu({ x: e.clientX, y: e.clientY, visible: true }); }}
      onClick={() => {
        if (helpMenu.visible) setHelpMenu({ ...helpMenu, visible: false });
        if (showRecentDropdown) setShowRecentDropdown(false);
        if (showSettingsDropdown) setShowSettingsDropdown(false);
      }}
    >
      {helpMenu.visible && (
        <div className="help-context-menu" style={{ top: helpMenu.y, left: helpMenu.x }} onClick={(e) => e.stopPropagation()}>
          <div className="help-header"><MousePointer2 size={14} />ショートカットヘルプ</div>
          <div className="help-grid">
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F10</kbd><span>追加</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F11</kbd><span>分割</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F12</kbd><span>グループ化</span></div>
            <div className="help-divider" />
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>C</kbd><span>コピー</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>V</kbd><span>貼り付け</span></div>
            <div className="help-divider" />
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名保存</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
            <div className="help-item"><kbd>Delete</kbd><span>削除</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>0</kbd><span>フィット</span></div>
            <div className="help-item"><kbd>Space</kbd>+<span>ドラッグで移動</span></div>
          </div>
        </div>
      )}

      <Toolbar 
        document={document} currentPage={currentPage} isDirty={isDirty}
        undoStackLength={undoStack.length} redoStackLength={redoStack.length}
        zoom={zoom} isAutoFit={isAutoFit} isDrawingMode={isDrawingMode} isSplitMode={isSplitMode}
        selectedIdsCount={selectedIds.size} showOcr={showOcr} ocrOpacity={ocrOpacity}
        reorderThreshold={reorderThreshold} isPreviewOpen={isPreviewOpen}
        recentFiles={recentFiles} showRecentDropdown={showRecentDropdown} showSettingsDropdown={showSettingsDropdown}
        onOpen={handleOpen} onClose={handleClose} onSave={handleSave} onSaveAs={handleSaveAs}
        onUndo={undo} onRedo={redo} onZoomIn={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom + 10)); }}
        onZoomOut={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom - 10)); }}
        onFit={() => fitToScreen(false)} onToggleDrawing={toggleDrawingMode} onToggleSplit={toggleSplitMode}
        onGroup={handleGroup} onDeduplicate={handleDeduplicate} onDelete={handleDelete}
        onToggleOcr={toggleShowOcr} onSetOcrOpacity={setOcrOpacity} 
        onSetReorderThreshold={(val) => { setReorderThreshold(val); localStorage.setItem('peco-reorder-threshold', val.toString()); }}
        onTogglePreview={togglePreviewWindow}
        onToggleRecentDropdown={(e) => { e.stopPropagation(); setShowRecentDropdown(!showRecentDropdown); }}
        onToggleSettingsDropdown={(e) => { e.stopPropagation(); setShowSettingsDropdown(!showSettingsDropdown); setShowRecentDropdown(false); }}
      />

      <main className="main-content">
        <ThumbnailPanel 
          width={leftWidth} document={document} currentPageIndex={currentPageIndex} 
          thumbnails={thumbnails} onSelectPage={setCurrentPage} onRequestThumbnail={requestThumbnail}
        />
        <div className="resizer" onMouseDown={startResizeLeft} />
        <section 
          ref={viewerRef}
          className={`pdf-viewer-panel ${isSpacePressed ? (isPanning ? 'grabbing' : 'grab') : ''}`} 
          onMouseDown={handleViewerMouseDown} onMouseMove={handleViewerMouseMove} onMouseUp={() => setIsPanning(false)} onMouseLeave={() => setIsPanning(false)}
        >
          <div className="pdf-canvas-container">
            {document ? <PdfCanvas pageIndex={currentPageIndex} disableDrawing={isSpacePressed} /> : <div className="empty-state"><p>PDFファイルを [開く] から読み込んでください</p></div>}
          </div>
        </section>
        <div className="resizer" onMouseDown={startResizeRight} />
        <OcrEditor width={rightWidth} searchInputRef={searchInputRef} />
      </main>

      {showConsole && (
        <ConsolePanel logs={logs} onClear={clearLogs} onClose={() => setShowConsole(false)} endRef={consoleEndRef} />
      )}

      <footer className="status-bar">
        <div className="status-item">ページ: {document ? `${currentPageIndex + 1} / ${document.totalPages}` : "0 / 0"}</div>
        <div className="status-item">ズーム: {zoom}%</div>
        <div className="status-item">BB数: {currentPage?.textBlocks?.length || 0}</div>
        <div className="status-item flex-grow" />
        {(isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
        <div className={`status-item console-toggle-btn${logs.filter(l => l.level === 'error').length > 0 ? ' has-errors' : ''}`} onClick={() => setShowConsole(v => !v)} title="コンソールを開く">
          <Terminal size={12} /><span>コンソール</span>
          {logs.filter(l => l.level === 'error').length > 0 && <span className="console-error-badge">{logs.filter(l => l.level === 'error').length}</span>}
        </div>
      </footer>
      {notification && <div className={`toast ${notification.isError ? 'toast-error' : 'toast-success'}`}>{notification.message}</div>}

      {showSaveDialog && (
        <SaveDialog 
          isEstimating={isEstimating} estimatedSizes={estimatedSizes} onConfirm={executeSaveAs} onCancel={() => setShowSaveDialog(false)}
          defaultCompression={(localStorage.getItem('peco-save-compression') as any) || 'none'}
          defaultRasterizeQuality={localStorage.getItem('peco-rasterize-quality') ? parseInt(localStorage.getItem('peco-rasterize-quality')!, 10) : 60}
        />
      )}
    </div>
  );
}

export default App;
