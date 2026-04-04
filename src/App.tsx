import React, { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { usePecoStore } from "./store/pecoStore";
import { MousePointer2, Terminal } from "lucide-react";
import { ask } from '@tauri-apps/plugin-dialog';
import { generateThumbnail, loadPecoToolBBoxMeta, loadPage, getSharedPdfProxy, destroySharedPdfProxy } from "./utils/pdfLoader";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
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
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [helpMenu, setHelpMenu] = useState<{ x: number, y: number, visible: boolean }>({ x: 0, y: 0, visible: false });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);

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
  const { handleOpen, handleSave, executeSaveAs } = useFileOperations(showToast, setIsSaving);

  const currentPage = document?.pages.get(currentPageIndex);

  // --- Handlers ---
  const handleSaveAs = async () => {
    if (!document) return;
    await executeSaveAs();
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
      // padding: 24px (上下左右計48px) + 余裕 12px = 60px
      const margin = 60;
      const ratioH = (container.clientHeight - margin) / pageData.height;
      const ratioW = (container.clientWidth - margin) / pageData.width;
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

  const handleRemoveSpaces = () => {
    if (selectedIds.size === 0 || !currentPage) return;
    const newBlocks = currentPage.textBlocks.map(b => {
      if (!selectedIds.has(b.id)) return b;
      const stripped = b.text.replace(/[ \u3000]/g, '');
      if (stripped === b.text) return b;
      return { ...b, text: stripped, isDirty: true };
    });
    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
  };

  // --- useKeyboardShortcuts ---
  useKeyboardShortcuts({
    undo, redo, fitToScreen, handleSave, handleSaveAs, copySelected,
    pasteClipboard, handleDelete, toggleDrawingMode, toggleSplitMode,
    handleGroup, setZoom, zoom, setIsAutoFit,
    searchInputRef, handleRemoveSpaces
  });

  const latestLoadRef = useRef<number>(-1);
  const bboxMetaRef = useRef<Record<string, Array<{
    bbox: import('./types').BoundingBox;
    writingMode: string;
    order: number;
    text: string;
  }>> | null | undefined>(undefined);

  const thumbnailQueueRef = useRef<number[]>([]);
  const isThumbnailProcessingRef = useRef<boolean>(false);

  const THUMBNAIL_CONCURRENCY = 4;

  const processThumbnailQueue = useCallback(async () => {
    const doc = usePecoStore.getState().document;
    if (isThumbnailProcessingRef.current || !doc) return;
    isThumbnailProcessingRef.current = true;

    try {
      while (thumbnailQueueRef.current.length > 0) {
        const batch: number[] = [];
        while (batch.length < THUMBNAIL_CONCURRENCY && thumbnailQueueRef.current.length > 0) {
          const pageIdx = thumbnailQueueRef.current.shift()!;
          if (!usePecoStore.getState().thumbnails.has(pageIdx)) {
            batch.push(pageIdx);
          }
        }
        if (batch.length === 0) continue;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            const dataUrl = await generateThumbnail(doc.filePath, pageIdx);
            usePecoStore.getState().setThumbnail(pageIdx, dataUrl);
          })
        );
      }
    } catch (err) {
      console.error("Thumbnail error:", err);
    } finally {
      isThumbnailProcessingRef.current = false;
      if (thumbnailQueueRef.current.length > 0) {
        setTimeout(processThumbnailQueue, 0);
      }
    }
  }, []);

  const thumbnailTimerRef = useRef<number | null>(null);

  const requestThumbnail = useCallback((pageIndex: number) => {
    const state = usePecoStore.getState();
    if (state.thumbnails.has(pageIndex) || !state.document) return;

    if (!thumbnailQueueRef.current.includes(pageIndex)) {
      thumbnailQueueRef.current.push(pageIndex);
    }

    if (thumbnailTimerRef.current !== null) {
      ((window as any).cancelIdleCallback ?? clearTimeout)(thumbnailTimerRef.current);
    }
    // メイン画像のレンダリングを優先させるため、アイドル時 or 最大400ms後に処理開始
    thumbnailTimerRef.current = ((window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300)))(
      () => { processThumbnailQueue(); },
      { timeout: 400 }
    ) as number;
  }, [processThumbnailQueue]);

  const loadCurrentPage = useCallback(async (pageIdx: number) => {
    latestLoadRef.current = pageIdx;
    if (latestLoadRef.current !== pageIdx) return;

    const doc = usePecoStore.getState().document;
    if (!doc) return;

    setIsLoadingPage(true);
    try {
      const pdf = await getSharedPdfProxy(doc.filePath);

      if (latestLoadRef.current !== pageIdx) return;

      // bboxMetaが未取得の場合、1ページ目表示をブロックせずバックグラウンドで取得する。
      // 取得完了後にキャッシュ済みでないページを再ロードしてbboxMetaを反映する。
      if (bboxMetaRef.current === undefined) {
        bboxMetaRef.current = null; // 取得中フラグ（undefinedでなくnullにして再取得を防ぐ）
        loadPecoToolBBoxMeta(pdf).then((meta) => {
          bboxMetaRef.current = meta;
          if (!meta) return; // PecoTool保存でなければ何もしない
          // bboxMetaがあるファイルの場合、ロード済みページを再取得して正確なbboxを反映
          const state = usePecoStore.getState();
          if (!state.document || state.document.filePath !== doc.filePath) return;
          state.document.pages.forEach((_, i) => {
            loadPage(pdf, i, doc.filePath, meta)
              .then((pd) => {
                const s = usePecoStore.getState();
                if (s.document?.filePath === doc.filePath) updatePageData(i, pd, false);
              })
              .catch(() => {});
          });
        }).catch(() => {});
      }

      const pageData = await loadPage(pdf, pageIdx, doc.filePath, bboxMetaRef.current);

      if (latestLoadRef.current === pageIdx) {
        updatePageData(pageIdx, pageData, false);
      }

      // 隣接ページのデータをバックグラウンドでプリフェッチ（50ms遅延でメインレンダーを優先）
      const prefetchPage = (i: number) => {
        if (i < 0 || i >= doc.totalPages) return;
        if (usePecoStore.getState().document?.pages.has(i)) return;
        setTimeout(() => {
          const currentDoc = usePecoStore.getState().document;
          if (!currentDoc || currentDoc.filePath !== doc.filePath) return;
          loadPage(pdf, i, doc.filePath, bboxMetaRef.current)
            .then((pd) => {
              const state = usePecoStore.getState();
              if (state.document?.filePath === doc.filePath && !state.document.pages.has(i)) {
                updatePageData(i, pd, false);
              }
            })
            .catch(() => {});
        }, 50);
      };
      prefetchPage(pageIdx - 1);
      prefetchPage(pageIdx + 1);
    } catch (err: any) {
      if (latestLoadRef.current !== pageIdx) return;
      console.error(`[loadCurrentPage] failed for page ${pageIdx}:`, err);
      showToast(`ページ ${pageIdx + 1} の読み込みに失敗しました: ${err}`, true);
    } finally {
      if (latestLoadRef.current === pageIdx) {
        setIsLoadingPage(false);
      }
    }
  }, [updatePageData, showToast]);

  // ファイルが変わったときにbboxMetaキャッシュをリセット
  const prevFilePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (document?.filePath !== prevFilePathRef.current) {
      bboxMetaRef.current = undefined;
      prevFilePathRef.current = document?.filePath;
    }
  }, [document?.filePath]);

  useEffect(() => {
    if (document && !document.pages.has(currentPageIndex)) {
      loadCurrentPage(currentPageIndex);
    }
  }, [document?.filePath, document?.pages, currentPageIndex, loadCurrentPage]);

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
        {isLoadingPage && <div className="status-item status-loading">⏳ ページ読込中...</div>}
        {isSaving && <div className="status-item status-loading">💾 保存中...</div>}
        {!isSaving && (isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
        <div className={`status-item console-toggle-btn${logs.filter(l => l.level === 'error').length > 0 ? ' has-errors' : ''}`} onClick={() => setShowConsole(v => !v)} title="コンソールを開く">
          <Terminal size={12} /><span>コンソール</span>
          {logs.filter(l => l.level === 'error').length > 0 && <span className="console-error-badge">{logs.filter(l => l.level === 'error').length}</span>}
        </div>
      </footer>
      {notification && <div className={`toast ${notification.isError ? 'toast-error' : 'toast-success'}`}>{notification.message}</div>}
    </div>
  );
}

export default App;
