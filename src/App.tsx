import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  usePecoStore,
  selectDocument,
  selectCurrentPageIndex,
  selectShowOcr,
  selectOcrOpacity,
  selectSelectedIds,
  selectIsDrawingMode,
  selectIsSplitMode,
  selectIsDirty,
  selectUndoStack,
  selectRedoStack,
} from "./store/pecoStore";
import { Terminal } from "lucide-react";
import { ask } from '@tauri-apps/plugin-dialog';
import { destroySharedPdfProxy } from "./utils/pdfLoader";
import { readReorderThreshold, writeReorderThreshold } from "./utils/reorderThreshold";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
import { TextBlock } from "./types";

// Hooks
import { useFileOperations } from "./hooks/useFileOperations";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useConsoleLogs } from "./hooks/useConsoleLogs";
import { usePreviewWindow } from "./hooks/usePreviewWindow";
import { useOcrEngine } from "./hooks/useOcrEngine";
import { useThumbnailPanel } from "./hooks/useThumbnailPanel";
import { useBackupManagement } from "./hooks/useBackupManagement";
import { usePdfViewerState } from "./hooks/usePdfViewerState";
import { usePageNavigation } from "./hooks/usePageNavigation";
import { useDialogState } from "./hooks/useDialogState";
import { useLayoutPanels } from "./hooks/useLayoutPanels";
import { useViewerPan } from "./hooks/useViewerPan";
import { useTauriCloseGuard } from "./hooks/useTauriCloseGuard";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { ThumbnailPanel } from "./components/Sidebar/ThumbnailPanel";

// Components
import { Toolbar } from "./components/Toolbar/Toolbar";
import { MenuBar } from "./components/MenuBar/MenuBar";
import { HelpMenu } from "./components/HelpMenu";

// Lazy-loaded modal/dialog components: 初回描画に不要なため code-split
const OcrSettingsModal = lazy(() =>
  import("./components/OcrSettingsModal").then(m => ({ default: m.OcrSettingsModal }))
);
const BackupRestoreDialog = lazy(() =>
  import("./components/BackupRestoreDialog").then(m => ({ default: m.BackupRestoreDialog }))
);
const HelpModal = lazy(() =>
  import("./components/HelpModal").then(m => ({ default: m.HelpModal }))
);
const ConsolePanel = lazy(() =>
  import("./components/Console/ConsolePanel").then(m => ({ default: m.ConsolePanel }))
);

function App() {
  // 細粒度selectorで購読: 各state変化が独立してComponentに伝わる
  const document = usePecoStore(selectDocument);
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);
  const selectedIds = usePecoStore(selectSelectedIds);
  const showOcr = usePecoStore(selectShowOcr);
  const ocrOpacity = usePecoStore(selectOcrOpacity);
  const isDrawingMode = usePecoStore(selectIsDrawingMode);
  const isSplitMode = usePecoStore(selectIsSplitMode);
  const isDirty = usePecoStore(selectIsDirty);
  const undoStack = usePecoStore(selectUndoStack);
  const redoStack = usePecoStore(selectRedoStack);
  // Actions
  const updatePageData = usePecoStore(s => s.updatePageData);
  const toggleShowOcr = usePecoStore(s => s.toggleShowOcr);
  const setOcrOpacity = usePecoStore(s => s.setOcrOpacity);
  const undo = usePecoStore(s => s.undo);
  const redo = usePecoStore(s => s.redo);
  const toggleDrawingMode = usePecoStore(s => s.toggleDrawingMode);
  const toggleSplitMode = usePecoStore(s => s.toggleSplitMode);
  const copySelected = usePecoStore(s => s.copySelected);
  const pasteClipboard = usePecoStore(s => s.pasteClipboard);
  const clearOcrCurrentPage = usePecoStore(s => s.clearOcrCurrentPage);
  const clearOcrAllPages = usePecoStore(s => s.clearOcrAllPages);

  const currentPage = document?.pages.get(currentPageIndex);

  // --- 分割された責務（フック群） ---
  const { leftWidth, rightWidth, startResizeLeft, startResizeRight } = useLayoutPanels();
  const {
    notification, helpMenu, setHelpMenu,
    showSettingsDropdown, setShowSettingsDropdown,
    helpModal, setHelpModal,
    showOcrSettings, setShowOcrSettings,
    showToast,
  } = useDialogState();
  const { zoom, setZoom, isAutoFit, setIsAutoFit, viewerRef, fitToScreen } =
    usePdfViewerState(document, currentPageIndex);
  const { isSpacePressed, isPanning, handleViewerMouseDown, handleViewerMouseMove, stopPanning } =
    useViewerPan(viewerRef);

  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const { recentFiles } = useRecentFiles();

  const consoleEndRef = useRef<HTMLDivElement>(null);

  const [reorderThreshold, setReorderThreshold] = useState(() => readReorderThreshold());

  // --- External Hooks ---
  const { logs, showConsole, setShowConsole, clearLogs } = useConsoleLogs();
  const { isPreviewOpen, togglePreviewWindow } = usePreviewWindow();
  const { loadEpoch, subscribeThumbnail, getThumbnail, requestThumbnail, handleSelectPage: handleThumbnailSelectPage, fakeDocument, triggerThumbnailLoad } = useThumbnailPanel();
  const { isOcrRunning, ocrProgress, runOcrCurrentPage, runOcrAllPages, cancelOcr, checkAndPromptOcrZero } = useOcrEngine(showToast);
  const { handleOpen, handleSave, executeSaveAs } = useFileOperations(
    showToast, setIsSaving, setIsLoadingFile,
    (doc) => { checkAndPromptOcrZero(doc); }
  );

  const {
    pendingBackups,
    setPendingBackups,
    processingBackupPath,
    handleRestoreBackup,
    handleDiscardBackup,
  } = useBackupManagement({ showToast, handleOpen });

  const {
    isLoadingPage,
    isLoadingPageMeta,
    pageLoadError,
    pageInputValue,
    setPageInputValue,
    loadCurrentPage,
    handlePageInputCommit,
    handlePageInputKeyDown,
    markRenderComplete,
  } = usePageNavigation({
    document,
    currentPageIndex,
    showToast,
    triggerThumbnailLoad,
  });

  // --- Handlers ---
  const handleReload = useCallback(async () => {
    if (!document?.filePath) return;
    await handleOpen(document.filePath);
  }, [document?.filePath, handleOpen]);

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

  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const handleClearOcrCurrentPage = async () => {
    const confirmed = await ask('現在のページのOCRテキストをすべて削除しますか？', {
      title: 'OCR消去', kind: 'warning'
    });
    if (!confirmed) return;
    clearOcrCurrentPage();
    showToast('現在のページのOCRテキストを削除しました。');
  };

  const handleClearOcrAllPages = async () => {
    const confirmed = await ask('全ページのOCRテキストをすべて削除しますか？この操作は元に戻せません。', {
      title: 'OCR消去（全ページ）', kind: 'warning'
    });
    if (!confirmed) return;
    clearOcrAllPages();
    showToast('全ページのOCRテキストを削除しました。');
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
    searchInputRef, handleRemoveSpaces,
    handleOpen,
  });

  // --- Effects ---
  useTauriCloseGuard();

  useEffect(() => {
    const handleF5 = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        const doc = usePecoStore.getState().document;
        if (doc?.filePath) handleOpen(doc.filePath);
      }
    };
    window.addEventListener('keydown', handleF5);
    return () => window.removeEventListener('keydown', handleF5);
  }, [handleOpen]);

  return (
    <div
      className="app-container"
      onContextMenu={(e) => { e.preventDefault(); setHelpMenu({ x: e.clientX, y: e.clientY, visible: true }); }}
      onClick={() => {
        if (helpMenu.visible) setHelpMenu({ ...helpMenu, visible: false });
        if (showSettingsDropdown) setShowSettingsDropdown(false);
      }}
    >
      <HelpMenu helpMenu={helpMenu} />

      {/* バックアップ復元ダイアログ */}
      {pendingBackups.length > 0 && (
        <Suspense fallback={null}>
          <BackupRestoreDialog
            backups={pendingBackups}
            onRestore={handleRestoreBackup}
            onDiscard={handleDiscardBackup}
            onClose={() => setPendingBackups([])}
            processingFilePath={processingBackupPath}
          />
        </Suspense>
      )}

      {/* ヘルプモーダル */}
      {showOcrSettings && (
        <Suspense fallback={null}>
          <OcrSettingsModal onClose={() => setShowOcrSettings(false)} />
        </Suspense>
      )}

      {helpModal && (
        <Suspense fallback={null}>
          <HelpModal helpModal={helpModal} onClose={() => setHelpModal(null)} />
        </Suspense>
      )}

      <MenuBar
        document={document}
        isDirty={isDirty}
        currentPageIsDirty={currentPage?.isDirty ?? false}
        recentFiles={recentFiles}
        onOpen={handleOpen}
        onClose={handleClose}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onShowShortcuts={() => setHelpModal('shortcuts')}
        onShowUsage={() => setHelpModal('usage')}
        onShowVersion={() => setHelpModal('version')}
        onReload={handleReload}
        onShowOcrSettings={() => setShowOcrSettings(true)}
      />

      <Toolbar
        document={document} currentPage={currentPage} isDirty={isDirty}
        undoStackLength={undoStack.length} redoStackLength={redoStack.length}
        zoom={zoom} isAutoFit={isAutoFit} isDrawingMode={isDrawingMode} isSplitMode={isSplitMode}
        selectedIdsCount={selectedIds.size} showOcr={showOcr} ocrOpacity={ocrOpacity}
        reorderThreshold={reorderThreshold} isPreviewOpen={isPreviewOpen}
        showSettingsDropdown={showSettingsDropdown}
        isOcrRunning={isOcrRunning} ocrProgress={ocrProgress}
        onUndo={undo} onRedo={redo} onZoomIn={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom + 10)); }}
        onZoomOut={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom - 10)); }}
        onFit={() => fitToScreen(false)} onToggleDrawing={toggleDrawingMode} onToggleSplit={toggleSplitMode}
        onGroup={handleGroup} onDeduplicate={handleDeduplicate} onRemoveSpaces={handleRemoveSpaces} onDelete={handleDelete}
        onToggleOcr={toggleShowOcr} onSetOcrOpacity={setOcrOpacity}
        onSetReorderThreshold={(val) => { setReorderThreshold(writeReorderThreshold(val)); }}
        onTogglePreview={togglePreviewWindow}
        onToggleSettingsDropdown={(e) => { e.stopPropagation(); setShowSettingsDropdown(!showSettingsDropdown); }}
        onRunOcrCurrentPage={runOcrCurrentPage}
        onRunOcrAllPages={runOcrAllPages}
        onCancelOcr={cancelOcr}
        onClearOcrCurrentPage={handleClearOcrCurrentPage}
        onClearOcrAllPages={handleClearOcrAllPages}
      />

      <main className="main-content">
        <ThumbnailPanel
          width={leftWidth}
          document={fakeDocument}
          currentPageIndex={currentPageIndex}
          loadEpoch={loadEpoch}
          isOcrRunning={isOcrRunning}
          onSelectPage={handleThumbnailSelectPage}
          onRequestThumbnail={requestThumbnail}
          onSubscribeThumbnail={subscribeThumbnail}
          onGetThumbnail={getThumbnail}
        />
        <div className="resizer" onMouseDown={startResizeLeft} />
        <section
          ref={viewerRef}
          className={`pdf-viewer-panel ${isSpacePressed ? (isPanning ? 'grabbing' : 'grab') : ''}`}
          onMouseDown={handleViewerMouseDown} onMouseMove={handleViewerMouseMove} onMouseUp={stopPanning} onMouseLeave={stopPanning}
        >
          <div className="pdf-canvas-container">
            {document ? <PdfCanvas pageIndex={currentPageIndex} disableDrawing={isSpacePressed} onFirstRender={triggerThumbnailLoad} onRenderComplete={markRenderComplete} /> : <div className="empty-state"><p>PDFファイルを [開く] から読み込んでください</p></div>}
          </div>
          {(isLoadingFile || isLoadingPageMeta) && (
            <div className="loading-overlay">
              <div className="loading-spinner" />
              <div className="loading-message">
                {isLoadingFile ? 'PDFを読み込んでいます...' : 'ページを読み込んでいます...'}
              </div>
            </div>
          )}
          {pageLoadError !== null && !isLoadingPage && !isLoadingFile && (
            <div className="loading-overlay" style={{ cursor: 'default' }}>
              <div style={{ textAlign: 'center', color: '#e2e8f0' }}>
                <div style={{ fontSize: 14, marginBottom: 12 }}>
                  ページ {pageLoadError + 1} の読み込みに失敗しました
                </div>
                <button
                  onClick={() => loadCurrentPage(pageLoadError)}
                  style={{
                    padding: '8px 20px',
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  再読み込み
                </button>
              </div>
            </div>
          )}
          {isOcrRunning && (
            <div className="ocr-processing-overlay">
              <div className="loading-spinner" />
              <div className="loading-message">
                {ocrProgress ? `OCR処理中... (${ocrProgress.current}/${ocrProgress.total})` : 'OCR処理中...'}
              </div>
            </div>
          )}
        </section>
        <div className="resizer" onMouseDown={startResizeRight} />
        <OcrEditor width={rightWidth} searchInputRef={searchInputRef} />
      </main>

      {showConsole && (
        <Suspense fallback={null}>
          <ConsolePanel logs={logs} onClear={clearLogs} onClose={() => setShowConsole(false)} endRef={consoleEndRef} />
        </Suspense>
      )}

      <footer className="status-bar">
        <div className="status-left">
          <div className="status-item">ズーム: {zoom}%</div>
          <div className="status-item">BB数: {currentPage?.textBlocks?.length || 0}</div>
        </div>
        <div className="status-center">
          <div className="status-item">
            <input
              type="text"
              className="page-input"
              value={pageInputValue !== null ? pageInputValue : String(document ? currentPageIndex + 1 : 0)}
              onFocus={() => setPageInputValue(String(document ? currentPageIndex + 1 : 0))}
              onChange={(e) => setPageInputValue(e.target.value)}
              onBlur={handlePageInputCommit}
              onKeyDown={handlePageInputKeyDown}
              disabled={!document}
            />
            <span>/ {document ? document.totalPages : 0}</span>
          </div>
        </div>
        <div className="status-right">
          {isLoadingFile && <div className="status-item status-loading">📂 PDF読込中...</div>}
          {!isLoadingFile && isLoadingPage && <div className="status-item status-loading">⏳ ページ読込中...</div>}
          {isSaving && <div className="status-item status-loading">💾 保存中...</div>}
          {!isSaving && (isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
          <div className={`status-item console-toggle-btn${logs.filter(l => l.level === 'error').length > 0 ? ' has-errors' : ''}`} onClick={() => setShowConsole(v => !v)} title="コンソールを開く">
            <Terminal size={12} /><span>コンソール</span>
            {logs.filter(l => l.level === 'error').length > 0 && <span className="console-error-badge">{logs.filter(l => l.level === 'error').length}</span>}
          </div>
        </div>
      </footer>
      {notification && <div className={`toast ${notification.isError ? 'toast-error' : 'toast-success'}`}>{notification.message}</div>}
    </div>
  );
}

export default App;
