import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  usePecoStore,
  selectCurrentPageIndex,
  selectShowOcr,
  selectOcrOpacity,
  selectSelectedIds,
  selectIsDrawingMode,
  selectIsSplitMode,
  selectIsDirty,
  selectUndoStack,
  selectRedoStack,
  selectCurrentPage,
} from "./store/pecoStore";
import { Database, FileCheck2, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import { ask } from '@tauri-apps/plugin-dialog';
import { destroySharedPdfProxy } from "./utils/pdfLoader";
import { readReorderThreshold, writeReorderThreshold } from "./utils/reorderThreshold";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
import { TextBlock } from "./types";
import { perf } from "./utils/perfLogger";

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
const ReplaceDialog = lazy(() =>
  import("./components/ReplaceDialog").then(m => ({ default: m.ReplaceDialog }))
);
const ConsolePanel = lazy(() =>
  import("./components/Console/ConsolePanel").then(m => ({ default: m.ConsolePanel }))
);

function App() {
  // 細粒度selectorで購読: 各state変化が独立してComponentに伝わる。
  // document 全体は購読せず、UI で実際に使う primitive のみを個別 selector で取る。
  // これにより updatePageData (pages Map 差し替え) で App 全体が再レンダされない。
  const filePath = usePecoStore(s => s.document?.filePath);
  const totalPages = usePecoStore(s => s.document?.totalPages ?? 0);
  const isFileLoaded = usePecoStore(s => s.document !== null);
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);
  const currentPage = usePecoStore(selectCurrentPage);
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

  // --- 分割された責務（フック群） ---
  const { leftWidth, rightWidth, startResizeLeft, startResizeRight } = useLayoutPanels();
  const {
    notification, setNotification, helpMenu, setHelpMenu,
    showSettingsDropdown, setShowSettingsDropdown,
    helpModal, setHelpModal,
    showOcrSettings, setShowOcrSettings,
    showReplace, setShowReplace,
    showToast,
  } = useDialogState();
  const { zoom, setZoom, isAutoFit, setIsAutoFit, viewerRef, fitToScreen } =
    usePdfViewerState(currentPageIndex);
  const { isSpacePressed, isPanning, handleViewerMouseDown, handleViewerMouseMove, stopPanning } =
    useViewerPan(viewerRef);

  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const { recentFiles } = useRecentFiles();

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const folderOpenPdfRef = useRef<(filePath: string) => Promise<boolean>>(async () => false);
  // #48: フォルダ OCR ループが保存失敗で即時中止できるよう Promise<boolean> を返す。
  const folderSavePdfRef = useRef<() => Promise<boolean>>(async () => false);
  // #102: useFileOperations.handleOpen / useKeyboardShortcuts に渡す。
  // 値同期は useOcrEngine の戻り isOcrRunning が変わるたびに行う (下の useEffect)。
  const isOcrRunningRef = useRef(false);

  const [reorderThreshold, setReorderThreshold] = useState(() => readReorderThreshold());

  // --- External Hooks ---
  const { logs, showConsole, setShowConsole, clearLogs } = useConsoleLogs();
  const { isPreviewOpen, togglePreviewWindow } = usePreviewWindow();
  const { loadEpoch, subscribeThumbnail, getThumbnail, subscribeActivePage, getIsActivePage, subscribeDirtyPage, getIsDirtyPage, requestThumbnail, handleSelectPage: handleThumbnailSelectPage, fakeDocument, triggerThumbnailLoad } = useThumbnailPanel();
  const {
    isOcrRunning,
    ocrProgress,
    runOcrCurrentPage,
    runOcrAllPages,
    runOcrFolder,
    cancelOcr,
    checkAndPromptOcrZero
  } = useOcrEngine(showToast, {
    openPdf: (path) => folderOpenPdfRef.current(path),
    savePdf: () => folderSavePdfRef.current(),
  });
  // #102: isOcrRunning の最新値を ref 同期 (handleOpen 内ガードで参照)。
  isOcrRunningRef.current = isOcrRunning;
  const { handleOpen, handleSave, executeSaveAs } = useFileOperations(
    showToast, setIsSaving, setIsLoadingFile,
    (doc) => { checkAndPromptOcrZero(doc); },
    isOcrRunningRef,
  );
  // #102: フォルダ OCR ループ内では openPdf に bypassOcrGuard=true を立てて呼ぶ。
  // これがないと OCR 中の handleOpen ガードに引っかかってループが進まない。
  folderOpenPdfRef.current = (path: string) => handleOpen(path, { bypassOcrGuard: true });
  folderSavePdfRef.current = handleSave;

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
    currentPageIndex,
    showToast,
    triggerThumbnailLoad,
  });

  // --- Handlers ---
  const handleReload = useCallback(async () => {
    if (isSaving) {
      showToast('保存中は再読み込みできません。');
      return;
    }
    // #102: OCR 実行中の F5/再読み込みは古い doc に OCR 結果が書き込まれる
    // 不可逆汚染の原因となるためブロックする。handleOpen 内部にもガードがあるが、
    // ここでメッセージを明示的に出して UX を整える。
    if (isOcrRunning) {
      showToast('OCR実行中は再読み込みできません。OCRを中止してから再度お試しください。');
      return;
    }
    if (!filePath) return;
    perf.mark('ui.reload');
    await handleOpen(filePath);
  }, [filePath, handleOpen, isOcrRunning, isSaving, showToast]);

  const handleSaveAs = async () => {
    if (!isFileLoaded) return;
    perf.mark('ui.saveAs');
    await executeSaveAs();
  };

  const handleOpenLogFolder = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_log_folder');
    } catch (err) {
      console.error('[app] open_log_folder failed:', err);
      showToast('ログフォルダを開けませんでした。', true);
    }
  }, [showToast]);

  const handleClose = useCallback(async () => {
    if (isSaving) {
      showToast('保存中は閉じられません。');
      return;
    }
    // pages の iteration は subscribe せず getState() で実行 (再レンダトリガーにしない)
    const doc = usePecoStore.getState().document;
    if (isDirty || Array.from(doc?.pages.values() || []).some(p => p.isDirty)) {
      const confirmed = await ask('未保存の変更があります。閉じてもよろしいですか？', {
        title: '閉じる確認',
        kind: 'warning'
      });
      if (!confirmed) return;
    }
    destroySharedPdfProxy();
    usePecoStore.getState().setDocument(null);
  }, [isDirty, isSaving, showToast]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleDelete = () => {
    if (selectedIds.size === 0 || !currentPage) return;
    perf.mark('ui.blockDelete', { count: selectedIds.size });
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
    perf.mark('ui.blockGroup', { count: selectedIds.size });
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

  const handleSelectAllText = () => {
    if (!currentPage || currentPage.textBlocks.length === 0) return;
    usePecoStore.getState().setSelectedIds(currentPage.textBlocks.map(block => block.id));
  };

  const handleClearOcrCurrentPage = async () => {
    const confirmed = await ask('現在のページのOCRテキストをすべて削除しますか？\nCtrl+Z で元に戻せます。', {
      title: 'OCR消去', kind: 'warning'
    });
    if (!confirmed) return;
    perf.mark('ui.ocrClearCurrentPage');
    clearOcrCurrentPage();
    showToast('現在のページのOCRテキストを削除しました。');
  };

  const handleClearOcrAllPages = async () => {
    const confirmed = await ask('全ページのOCRテキストをすべて削除しますか？この操作は元に戻せません。', {
      title: 'OCR消去（全ページ）', kind: 'warning'
    });
    if (!confirmed) return;
    perf.mark('ui.ocrClearAllPages');
    clearOcrAllPages();
    showToast('全ページのOCRテキストを削除しました。');
  };

  const handleRemoveSpaces = () => {
    if (selectedIds.size === 0 || !currentPage) return;
    perf.mark('ui.blockRemoveSpaces', { count: selectedIds.size });
    const newBlocks = currentPage.textBlocks.map(b => {
      if (!selectedIds.has(b.id)) return b;
      const stripped = b.text.replace(/[ \u3000]/g, '');
      if (stripped === b.text) return b;
      return { ...b, text: stripped, isDirty: true };
    });
    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
  };

  // issue #93: Find & Replace \u306e\u5b9f\u884c\u30cf\u30f3\u30c9\u30e9\u3002
  //  - \u5168\u30da\u30fc\u30b8\u30b9\u30b3\u30fc\u30d7 \u00d7 50 \u4ef6\u8d85\u306e\u3068\u304d\u3060\u3051 ask() \u78ba\u8a8d\u3092\u631f\u3080
  //  - contentEditable \u306b focus \u304c\u3042\u308b\u7de8\u96c6\u4e2d\u30d6\u30ed\u30c3\u30af\u306f blur() \u3057\u3066\u304b\u3089\u5b9f\u884c
  //    (\u672c\u5b9f\u88c5\u3067\u306f editor \u306f currentPage \u306e\u5404 BB \u3092 contentEditable \u3067\u63cf\u753b\u3059\u308b\u305f\u3081\u3001
  //     focus \u3055\u308c\u3066\u3044\u308b DOM \u306e data-block-id \u3092\u898b\u3066 skipBlockIds \u3092\u69cb\u7bc9\u3059\u308b)
  const handleReplaceConfirm = useCallback(async (params: {
    scope: 'selection' | 'current' | 'all';
    pattern: string;
    replacement: string;
    caseSensitive: boolean;
    useRegex: boolean;
    expectedHits: number;
  }) => {
    if (params.scope === 'all' && params.expectedHits > 50) {
      const confirmed = await ask(
        `\u5168\u30da\u30fc\u30b8\u3067 ${params.expectedHits} \u4ef6\u306e\u7f6e\u63db\u3092\u5b9f\u884c\u3057\u307e\u3059\u3002\u3088\u308d\u3057\u3044\u3067\u3059\u304b\uff1f`,
        { title: '\u691c\u7d22\u3068\u7f6e\u63db', kind: 'warning' },
      );
      if (!confirmed) return;
    }

    // \u7de8\u96c6\u4e2d\u30d6\u30ed\u30c3\u30af\u691c\u51fa: ocr-card-content \u306b focus \u304c\u3042\u308b\u5834\u5408\u306f blur() \u3057\u3066\u30c7\u30fc\u30bf\u3092\u78ba\u5b9a\u3055\u305b\u308b\u3002
    // \u53cd\u6620\u3067\u304d\u306a\u3044 (= isEditing) \u30d6\u30ed\u30c3\u30af\u306f skipBlockIds \u306b\u6e21\u3057\u3001\u4ef6\u6570\u3092 toast \u8b66\u544a\u3059\u308b\u3002
    const active = window.document.activeElement as HTMLElement | null;
    const editingEl =
      active && active.classList?.contains('ocr-card-content') ? active : null;
    const skipBlockIds = new Set<string>();
    if (editingEl) {
      const blockId = editingEl.closest('[data-block-id]')?.getAttribute('data-block-id');
      if (blockId) skipBlockIds.add(blockId);
      // blur \u3057\u3066\u3082 DOM \u540c\u671f\u304c\u9593\u306b\u5408\u308f\u306a\u3044\u305f\u3081\u3001\u5bfe\u8c61\u30d6\u30ed\u30c3\u30af\u306f\u5b89\u5168\u5074\u3067 skip \u3057\u3066\u304a\u304f\u3002
      editingEl.blur();
    }

    perf.mark('ui.replaceTextExecute', {
      scope: params.scope,
      hits: params.expectedHits,
    });
    const result = await usePecoStore.getState().replaceText({
      scope: params.scope,
      pattern: params.pattern,
      replacement: params.replacement,
      caseSensitive: params.caseSensitive,
      useRegex: params.useRegex,
      skipBlockIds,
    });

    if (result.skippedBlocks > 0) {
      showToast(
        `${result.hits} \u4ef6\u7f6e\u63db\u3057\u307e\u3057\u305f (\u7de8\u96c6\u4e2d\u306e ${result.skippedBlocks} \u30d6\u30ed\u30c3\u30af\u306f\u30b9\u30ad\u30c3\u30d7)\u3002`,
        true,
      );
    } else {
      showToast(
        `${result.hits} \u4ef6 / ${result.blocks} \u30d6\u30ed\u30c3\u30af / ${result.pages} \u30da\u30fc\u30b8 \u3092\u7f6e\u63db\u3057\u307e\u3057\u305f\u3002`,
      );
    }
    setShowReplace(false);
  }, [setShowReplace, showToast]);

  const getVisiblePdfCenter = useCallback(() => {
    const viewer = viewerRef.current;
    const wrapper = viewer?.querySelector<HTMLElement>('.canvas-wrapper');
    if (!viewer || !wrapper) return undefined;

    const viewerRect = viewer.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const left = Math.max(viewerRect.left, wrapperRect.left);
    const right = Math.min(viewerRect.right, wrapperRect.right);
    const top = Math.max(viewerRect.top, wrapperRect.top);
    const bottom = Math.min(viewerRect.bottom, wrapperRect.bottom);
    if (right <= left || bottom <= top) return undefined;

    const scale = zoom / 100;
    return {
      x: ((left + right) / 2 - wrapperRect.left) / scale,
      y: ((top + bottom) / 2 - wrapperRect.top) / scale,
    };
  }, [viewerRef, zoom]);

  const handlePasteClipboard = useCallback(() => {
    pasteClipboard(getVisiblePdfCenter());
  }, [getVisiblePdfCenter, pasteClipboard]);

  // --- useKeyboardShortcuts ---
  useKeyboardShortcuts({
    undo, redo, fitToScreen, handleSave, handleSaveAs, copySelected,
    pasteClipboard: handlePasteClipboard, handleDelete, toggleDrawingMode, toggleSplitMode,
    toggleShowOcr, handleGroup, setZoom, zoom, setIsAutoFit,
    searchInputRef, handleRemoveSpaces,
    handleOpen,
    // #102/#103: OCR 実行中の Ctrl+O / Ctrl+H をブロックするための最新値参照。
    isOcrRunning,
    // issue #93: Ctrl+H で Find & Replace 起動 (ファイル未ロード時は no-op)
    // #103: OCR 実行中は Replace ダイアログを開けない (置換結果が OCR で上書きされる事故防止)
    openReplace: () => {
      if (!isFileLoaded) return;
      if (isOcrRunning) {
        showToast('OCR実行中は検索と置換を実行できません。OCRを中止してから再度お試しください。');
        return;
      }
      setShowReplace(true);
    },
  });

  // issue #163: OCR 実行中の Esc キーで cancelOcr。
  // overlay 表示中はそれ以外の入力路がほぼ無効になるため、capture フェーズで
  // どこからでも拾えるようにする (input にフォーカスがあっても効く)。
  useEffect(() => {
    if (!isOcrRunning) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelOcr();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOcrRunning, cancelOcr]);

  // issue #74 / CloseGuard: isSaving の最新値を ref に同期。
  // useTauriCloseGuard と F5 ガードに渡す前に宣言する必要がある (TDZ 回避)。
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;

  // --- Effects ---
  // CloseGuard: 保存中の close を suppress するため isSavingRef を渡す (Critical: rename race のデータロス回避)。
  useTauriCloseGuard({ isSavingRef });

  useEffect(() => {
    const handleF5 = (e: KeyboardEvent) => {
      if (e.key !== 'F5') return;
      e.preventDefault();
      // issue #74: バックアップ復元中 / モーダル表示中は F5 を握りつぶす。
      // 復元中の二重 open でデータ消失、モーダル表示中の意図せぬ消去を防ぐ。
      if (processingBackupPath || helpModal || showOcrSettings || showReplace || pendingBackups.length > 0) return;
      handleReload();
    };
    window.addEventListener('keydown', handleF5);
    return () => window.removeEventListener('keydown', handleF5);
  }, [handleReload, processingBackupPath, helpModal, showOcrSettings, showReplace, pendingBackups.length]);

  useEffect(() => {
    if (!isSaving) return;
    const blockKeys = (e: KeyboardEvent) => {
      // Issue #47: 保存中でも Esc は通す (モーダル/ダイアログから抜けられないと UX が詰む)
      if (e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', blockKeys, true);
    return () => window.removeEventListener('keydown', blockKeys, true);
  }, [isSaving]);

  // ──────────── 計測モード (perfLogger) ────────────
  // Ctrl+Shift+P: localStorage.pecoPerf='1' をトグル + 再読込
  // F10:          有効時のみ、ndjson をダウンロード & Tauri 経由で appdata に保存
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+P: 有効/無効トグル → 再読込
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        try {
          const cur = localStorage.getItem('pecoPerf');
          if (cur === '1' || cur === 'verbose') {
            localStorage.removeItem('pecoPerf');
            showToast('計測モードを無効化します。再読込中...');
          } else {
            localStorage.setItem('pecoPerf', '1');
            showToast('計測モードを有効化します。再読込中...');
          }
          setTimeout(() => location.reload(), 400);
        } catch (err) {
          console.error('[perf] toggle failed:', err);
        }
        return;
      }
      // F10: 計測結果書き出し
      if (e.key === 'F10' && !e.ctrlKey && !e.metaKey) {
        if (!perf.enabled) return;
        e.preventDefault();
        // Tauri 環境では appdata に書き込み → パスを Toast 表示
        perf.sendToTauri(`perf-${Date.now()}`).then((path) => {
          if (path) {
            showToast(`計測ログを保存しました: ${path}`);
          } else {
            showToast('計測ログの保存に失敗しました（有効化されていない可能性）', true);
          }
        }).catch((err) => {
          console.error('[perf] sendToTauri failed:', err);
          showToast(`計測ログの Tauri 保存に失敗: ${err}`, true);
        });
        // 同時に Blob ダウンロード (ユーザー環境で動く方を使える)
        perf.download().catch((err) => {
          console.error('[perf] download failed:', err);
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showToast]);

  return (
    <div
      className="app-container"
      onContextMenu={(e) => {
        e.preventDefault();
        // Issue #45: モーダル/ダイアログ表示中は背後に HelpMenu を重ねて開かない
        if (helpModal || showOcrSettings || showReplace || pendingBackups.length > 0) return;
        setHelpMenu({ x: e.clientX, y: e.clientY, visible: true });
      }}
      onClick={() => {
        if (helpMenu.visible) setHelpMenu({ ...helpMenu, visible: false });
        if (showSettingsDropdown) setShowSettingsDropdown(false);
      }}
    >
      <HelpMenu helpMenu={helpMenu} onClose={() => setHelpMenu({ ...helpMenu, visible: false })} />

      {/* バックアップ復元ダイアログ */}
      {pendingBackups.length > 0 && (
        <Suspense fallback={null}>
          <BackupRestoreDialog
            backups={pendingBackups}
            onRestore={handleRestoreBackup}
            onDiscard={handleDiscardBackup}
            onClose={() => {
              // Issue #42: 復元/破棄処理中は閉じない (中途半端な状態で保存されてしまう)
              if (processingBackupPath) {
                showToast('復元処理中はダイアログを閉じられません。完了までお待ちください。', true);
                return;
              }
              setPendingBackups([]);
            }}
            processingFilePath={processingBackupPath}
            onCloseSuppressed={() =>
              showToast('復元処理中はダイアログを閉じられません。完了までお待ちください。', true)
            }
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

      {/* issue #93: 検索と置換ダイアログ */}
      {showReplace && (
        <Suspense fallback={null}>
          <ReplaceDialog
            onClose={() => setShowReplace(false)}
            onConfirm={handleReplaceConfirm}
            hasSelection={selectedIds.size > 0}
          />
        </Suspense>
      )}

      <MenuBar
        isFileLoaded={isFileLoaded}
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
        onOpenLogFolder={handleOpenLogFolder}
      />

      <Toolbar
        isFileLoaded={isFileLoaded} currentPage={currentPage ?? undefined} isDirty={isDirty}
        undoStackLength={undoStack.length} redoStackLength={redoStack.length}
        zoom={zoom} isAutoFit={isAutoFit} isDrawingMode={isDrawingMode} isSplitMode={isSplitMode}
        selectedIdsCount={selectedIds.size} showOcr={showOcr} ocrOpacity={ocrOpacity}
        reorderThreshold={reorderThreshold} isPreviewOpen={isPreviewOpen}
        showSettingsDropdown={showSettingsDropdown}
        isOcrRunning={isOcrRunning} ocrProgress={ocrProgress}
        onUndo={undo} onRedo={redo} onZoomIn={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom + 10)); }}
        onZoomOut={() => { setIsAutoFit(false); setZoom(Math.max(25, zoom - 10)); }}
        onFit={() => fitToScreen(false)} onToggleDrawing={toggleDrawingMode} onToggleSplit={toggleSplitMode}
        onGroup={handleGroup} onDeduplicate={handleDeduplicate} onSelectAllText={handleSelectAllText} onRemoveSpaces={handleRemoveSpaces} onDelete={handleDelete}
        onToggleOcr={toggleShowOcr} onSetOcrOpacity={setOcrOpacity}
        onSetReorderThreshold={(val) => { setReorderThreshold(writeReorderThreshold(val)); }}
        onTogglePreview={togglePreviewWindow}
        onToggleSettingsDropdown={(e) => { e.stopPropagation(); setShowSettingsDropdown(!showSettingsDropdown); }}
        onRunOcrCurrentPage={runOcrCurrentPage}
        onRunOcrAllPages={runOcrAllPages}
        onRunOcrFolder={runOcrFolder}
        onCancelOcr={cancelOcr}
        onClearOcrCurrentPage={handleClearOcrCurrentPage}
        onClearOcrAllPages={handleClearOcrAllPages}
        onOpenReplace={() => {
          // #103: OCR 実行中の Replace は disabled prop で UI レベルでも防いでいるが、
          // 念のためハンドラ側でも二重ガードする (将来 UI 経路追加時の事故防止)。
          if (isOcrRunning) {
            showToast('OCR実行中は検索と置換を実行できません。OCRを中止してから再度お試しください。');
            return;
          }
          setShowReplace(true);
        }}
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
          onSubscribeActivePage={subscribeActivePage}
          onGetIsActivePage={getIsActivePage}
          onSubscribeDirtyPage={subscribeDirtyPage}
          onGetIsDirtyPage={getIsDirtyPage}
        />
        <div className="resizer" onMouseDown={startResizeLeft} />
        <section
          ref={viewerRef}
          className={`pdf-viewer-panel ${isSpacePressed ? (isPanning ? 'grabbing' : 'grab') : ''}`}
          onMouseDown={handleViewerMouseDown} onMouseMove={handleViewerMouseMove} onMouseUp={stopPanning} onMouseLeave={stopPanning}
        >
          <div className="pdf-canvas-container">
            {isFileLoaded ? <PdfCanvas pageIndex={currentPageIndex} disableDrawing={isSpacePressed} onFirstRender={triggerThumbnailLoad} onRenderComplete={markRenderComplete} /> : <div className="empty-state"><p>PDFファイルを [開く] から読み込んでください</p></div>}
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
                {ocrProgress
                  ? ocrProgress.fileTotal
                    ? `OCR処理中... (${ocrProgress.fileCurrent}/${ocrProgress.fileTotal}ファイル ${ocrProgress.current}/${ocrProgress.total}ページ)`
                    : `OCR処理中... (${ocrProgress.current}/${ocrProgress.total})`
                  : 'OCR処理中...'}
              </div>
              {/* issue #163: overlay 内に大きなキャンセル動線を配置。
                  従来は Toolbar の小さな X だけで気付きにくく、Esc も効かなかった。 */}
              <button
                type="button"
                className="ocr-cancel-button"
                onClick={cancelOcr}
                aria-label="OCR処理をキャンセル"
              >
                キャンセル (Esc)
              </button>
            </div>
          )}
        </section>
        <div className="resizer" onMouseDown={startResizeRight} />
        <OcrEditor
          width={rightWidth}
          searchInputRef={searchInputRef}
        />
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
              value={pageInputValue !== null ? pageInputValue : String(isFileLoaded ? currentPageIndex + 1 : 0)}
              onFocus={() => setPageInputValue(String(isFileLoaded ? currentPageIndex + 1 : 0))}
              onChange={(e) => setPageInputValue(e.target.value)}
              onBlur={handlePageInputCommit}
              onKeyDown={handlePageInputKeyDown}
              disabled={!isFileLoaded}
            />
            <span>/ {isFileLoaded ? totalPages : 0}</span>
          </div>
        </div>
        <div className="status-right">
          {isLoadingFile && <div className="status-item status-loading">📂 PDF読込中...</div>}
          {!isLoadingFile && isLoadingPage && <div className="status-item status-loading">⏳ ページ読込中...</div>}
          {isSaving && <div className="status-item status-loading">💾 保存中...</div>}
          {!isSaving && (isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
          {(() => {
            const errorCount = logs.filter(l => l.level === 'error').length;
            const label = errorCount > 0 ? `コンソールを開く (エラー ${errorCount} 件)` : 'コンソールを開く';
            return (
              <button
                type="button"
                className={`status-item console-toggle-btn${errorCount > 0 ? ' has-errors' : ''}`}
                onClick={() => setShowConsole(v => !v)}
                title="コンソールを開く"
                aria-label={label}
              >
                <Terminal size={12} aria-hidden="true" /><span>コンソール</span>
                {errorCount > 0 && <span className="console-error-badge" aria-hidden="true">{errorCount}</span>}
              </button>
            );
          })()}
        </div>
      </footer>
      {isSaving && (
        <div className="save-lock-overlay" role="alert" aria-live="assertive" aria-busy="true">
          <div className="save-lock-shell">
            <div className="save-lock-orbit" aria-hidden="true">
              <div className="save-lock-ring" />
              <div className="save-lock-core">
                <LockKeyhole size={30} strokeWidth={1.8} />
              </div>
            </div>
            <div className="save-lock-copy">
              <div className="save-lock-kicker"><ShieldCheck size={15} /> PDF 保護モード</div>
              <div className="save-lock-title">保存中は操作をロックしています</div>
              <div className="save-lock-subtitle">
                テキストレイヤーを書き出し、一時ファイルを検証してから安全に置き換えています。
              </div>
            </div>
            <div className="save-lock-rail" aria-hidden="true">
              <div className="save-lock-rail-fill" />
            </div>
            <div className="save-lock-steps">
              <div className="save-lock-step active"><Database size={14} /> 変更回収</div>
              <div className="save-lock-step active"><FileCheck2 size={14} /> PDF生成</div>
              <div className="save-lock-step active"><ShieldCheck size={14} /> 安全置換</div>
            </div>
          </div>
        </div>
      )}
      {notification && (notification.isError ? (
        <div className="toast toast-error" role="alert" aria-live="assertive">
          <span>{notification.message}</span>
          {notification.action && (
            <button
              type="button"
              className="toast-action-btn"
              onClick={() => {
                const action = notification.action;
                setNotification(null);
                action?.onClick();
              }}
            >
              {notification.action.label}
            </button>
          )}
        </div>
      ) : (
        <div className="toast toast-success" role="status" aria-live="polite">
          <span>{notification.message}</span>
          {notification.action && (
            <button
              type="button"
              className="toast-action-btn"
              onClick={() => {
                const action = notification.action;
                setNotification(null);
                action?.onClick();
              }}
            >
              {notification.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default App;
