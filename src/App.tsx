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
import { useOcrEngine } from "./hooks/useOcrEngine";

// Components
import { Toolbar } from "./components/Toolbar/Toolbar";
import { MenuBar } from "./components/MenuBar/MenuBar";
import { ThumbnailPanel } from "./components/Sidebar/ThumbnailPanel";
import { ConsolePanel } from "./components/Console/ConsolePanel";
import { OcrSettingsModal } from "./components/OcrSettingsModal";

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
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [helpMenu, setHelpMenu] = useState<{ x: number, y: number, visible: boolean }>({ x: 0, y: 0, visible: false });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [helpModal, setHelpModal] = useState<'shortcuts' | 'usage' | 'version' | null>(null);
  const [showOcrSettings, setShowOcrSettings] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);

  const [reorderThreshold, setReorderThreshold] = useState(() => {
    const stored = localStorage.getItem('peco-reorder-threshold');
    return stored ? parseInt(stored, 10) : 50;
  });

  const [pageInputValue, setPageInputValue] = useState<string | null>(null);

  const handlePageInputCommit = () => {
    if (pageInputValue !== null && document) {
      const pageNum = parseInt(pageInputValue, 10);
      if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= document.totalPages) {
        setCurrentPage(pageNum - 1);
      }
    }
    setPageInputValue(null);
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setPageInputValue(null);
      e.currentTarget.blur();
    }
  };

  const showToast = useCallback((message: string, isError = false) => {
    setNotification({ message, isError });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // --- External Hooks ---
  useFontLoader();
  const { logs, showConsole, setShowConsole, clearLogs } = useConsoleLogs();
  const { isPreviewOpen, togglePreviewWindow, initPreviewWindow } = usePreviewWindow();
  const { isOcrRunning, ocrProgress, runOcrCurrentPage, runOcrAllPages, cancelOcr, checkAndPromptOcrZero } = useOcrEngine(showToast);
  const { handleOpen, handleSave, executeSaveAs } = useFileOperations(
    showToast, setIsSaving, setIsLoadingFile,
    (doc) => { checkAndPromptOcrZero(doc); }
  );

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
    searchInputRef, handleRemoveSpaces,
    handleOpen,
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
          // bboxMetaがあるファイルの場合、メモリにロード済みかつDirtyでないページのみ
          // 再取得してbboxMetaを反映する（Dirtyページは既に編集済みのため上書き不要）
          const state = usePecoStore.getState();
          if (!state.document || state.document.filePath !== doc.filePath) return;
          state.document.pages.forEach((pageData, i) => {
            if (pageData.isDirty) return; // 編集済みページは上書きしない
            loadPage(pdf, i, doc.filePath, meta, doc.mtime)
              .then((pd) => {
                const s = usePecoStore.getState();
                if (s.document?.filePath === doc.filePath) updatePageData(i, pd, false);
              })
              .catch(() => {});
          });
        }).catch(() => {});
      }

      const pageData = await loadPage(pdf, pageIdx, doc.filePath, bboxMetaRef.current, doc.mtime);

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
          loadPage(pdf, i, doc.filePath, bboxMetaRef.current, doc.mtime)
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
        if (showSettingsDropdown) setShowSettingsDropdown(false);
      }}
    >
      {/* 右クリックショートカットヘルプ（既存機能を維持） */}
      {helpMenu.visible && (
        <div className="help-context-menu" style={{ top: helpMenu.y, left: helpMenu.x }} onClick={(e) => e.stopPropagation()}>
          <div className="help-header"><MousePointer2 size={14} />ショートカットヘルプ</div>
          <div className="help-grid">
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>O</kbd><span>開く</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名保存</span></div>
            <div className="help-divider" />
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
            <div className="help-divider" />
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F10</kbd><span>追加</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F11</kbd><span>分割</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F12</kbd><span>グループ化</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd><span>スペース削除</span></div>
            <div className="help-divider" />
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>C</kbd><span>コピー</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>V</kbd><span>貼り付け</span></div>
            <div className="help-item"><kbd>Delete</kbd><span>BB削除</span></div>
            <div className="help-item"><kbd>Ctrl</kbd>+<kbd>0</kbd><span>フィット</span></div>
            <div className="help-item"><kbd>Space</kbd>+<span>ドラッグで画面移動</span></div>
          </div>
        </div>
      )}

      {/* ヘルプモーダル */}
      {showOcrSettings && <OcrSettingsModal onClose={() => setShowOcrSettings(false)} />}

      {helpModal && (
        <div className="modal-backdrop" onClick={() => setHelpModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              {helpModal === 'shortcuts' && 'ショートカットキー一覧'}
              {helpModal === 'usage' && 'ツールの使い方'}
              {helpModal === 'version' && 'バージョン情報'}
              <button className="modal-close" onClick={() => setHelpModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {helpModal === 'shortcuts' && (
                <div className="help-grid">
                  <div className="modal-section-title">ファイル操作</div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>O</kbd><span>開く</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名で保存</span></div>
                  <div className="help-divider" />
                  <div className="modal-section-title">編集</div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>C</kbd><span>BBをコピー（非編集時）</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>V</kbd><span>BBを貼り付け（非編集時）</span></div>
                  <div className="help-item"><kbd>Delete</kbd><span>選択BBを削除（非編集時）</span></div>
                  <div className="help-divider" />
                  <div className="modal-section-title">BB操作</div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F10</kbd><span>BB追加モード</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F11</kbd><span>BB分割モード</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F12</kbd><span>選択BBをグループ化</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd><span>選択BB内のスペース削除</span></div>
                  <div className="help-divider" />
                  <div className="modal-section-title">表示</div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>0</kbd><span>画面にフィット</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>/<kbd>Alt</kbd>+<kbd>ホイール</kbd><span>ズーム</span></div>
                  <div className="help-item"><kbd>Space</kbd>+<span>ドラッグ 画面移動（パン）</span></div>
                  <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F</kbd><span>テキスト検索</span></div>
                </div>
              )}
              {helpModal === 'usage' && (
                <div className="usage-guide">
                  <div className="usage-section">
                    <div className="usage-title">基本的な流れ</div>
                    <ol className="usage-list">
                      <li>「ファイル → 開く」からPDFを読み込む</li>
                      <li>左のサムネイルでページを選択</li>
                      <li>中央のPDFビュー上でBB（テキストブロック）を確認・編集</li>
                      <li>右パネルでBBのテキストを直接編集</li>
                      <li>「ファイル → 保存」で保存</li>
                    </ol>
                  </div>
                  <div className="usage-section">
                    <div className="usage-title">BBの選択</div>
                    <ul className="usage-list">
                      <li>PDFビューまたは右パネルのBBをクリックで選択</li>
                      <li><kbd>Ctrl</kbd>+クリック で複数選択</li>
                      <li><kbd>Shift</kbd>+クリック で範囲選択（右パネルのみ）</li>
                    </ul>
                  </div>
                  <div className="usage-section">
                    <div className="usage-title">BB操作</div>
                    <ul className="usage-list">
                      <li><b>追加：</b> Ctrl+F10 で追加モード → PDFビュー上をドラッグ</li>
                      <li><b>移動・リサイズ：</b> 選択後にPDFビュー上でドラッグ</li>
                      <li><b>分割：</b> Ctrl+F11 で分割モード → BBをクリック</li>
                      <li><b>グループ化：</b> 複数選択して Ctrl+F12</li>
                      <li><b>並び順修正：</b> <kbd>Alt</kbd>+ドラッグで位置を移動して序列を更新</li>
                    </ul>
                  </div>
                  <div className="usage-section">
                    <div className="usage-title">テキスト編集</div>
                    <ul className="usage-list">
                      <li>右パネルのBBカードをクリックして直接入力</li>
                      <li>OCRの誤認識スペースは「スペース削除」ボタンまたは Ctrl+Shift+Space で一括削除</li>
                      <li>Ctrl+↑↓ でBB間を移動</li>
                    </ul>
                  </div>
                </div>
              )}
              {helpModal === 'version' && (
                <div className="version-info">
                  <div className="version-logo">PecoTool V2</div>
                  <div className="version-number">バージョン 1.3.0</div>
                  <div className="version-desc">PDF OCR 手動編集ツール</div>
                </div>
              )}
            </div>
          </div>
        </div>
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
        onSetReorderThreshold={(val) => { setReorderThreshold(val); localStorage.setItem('peco-reorder-threshold', val.toString()); }}
        onTogglePreview={togglePreviewWindow}
        onToggleSettingsDropdown={(e) => { e.stopPropagation(); setShowSettingsDropdown(!showSettingsDropdown); }}
        onRunOcrCurrentPage={runOcrCurrentPage}
        onRunOcrAllPages={runOcrAllPages}
        onCancelOcr={cancelOcr}
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
          {(isLoadingFile || isLoadingPage) && (
            <div className="loading-overlay">
              <div className="loading-spinner" />
              <div className="loading-message">
                {isLoadingFile ? 'PDFを読み込んでいます...' : 'ページを読み込んでいます...'}
              </div>
            </div>
          )}
        </section>
        <div className="resizer" onMouseDown={startResizeRight} />
        <OcrEditor width={rightWidth} searchInputRef={searchInputRef} />
      </main>

      {showConsole && (
        <ConsolePanel logs={logs} onClear={clearLogs} onClose={() => setShowConsole(false)} endRef={consoleEndRef} />
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
