import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from 'pdfjs-dist';
import "./App.css";
import { usePecoStore } from "./store/pecoStore";
import { FolderOpen, Save, RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize, Plus, Group, Trash2, Eye, Scissors, ClipboardList, Eraser, X, MousePointer2, ChevronDown, Settings, Terminal } from "lucide-react";
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { loadPDF, loadPage, loadPecoToolBBoxMeta, openPDF, openPDFTask, generateThumbnail } from "./utils/pdfLoader";
import { savePDF, estimateSizes } from "./utils/pdfSaver";
import { TextBlock } from "./types";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";
import { SaveDialog, formatFileSize } from "./components/SaveDialog";
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';

function App() {
  const { document, setDocument, setThumbnail, originalBytes, currentPageIndex, zoom, setZoom, setCurrentPage, updatePageData, selectedIds, clearSelection, showOcr, toggleShowOcr, ocrOpacity, setOcrOpacity, undo, redo, undoStack, redoStack, isDrawingMode, toggleDrawingMode, isSplitMode, toggleSplitMode, isDirty, thumbnails, resetDirty, copySelected, pasteClipboard } = usePecoStore();

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

  const [consoleLogs, setConsoleLogs] = useState<Array<{ level: 'error' | 'warn' | 'log'; message: string; time: string }>>([]);
  const [showConsole, setShowConsole] = useState(false);
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

  const currentPage = document?.pages.get(currentPageIndex);

  // --- Console log capture ---

  useEffect(() => {
    const addLog = (level: 'error' | 'warn' | 'log', args: unknown[]) => {
      const message = args.map(a => {
        if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
        if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      const time = new Date().toLocaleTimeString('ja-JP');
      setConsoleLogs(prev => [...prev.slice(-299), { level, message, time }]);
    };

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    const origLog = console.log.bind(console);

    console.error = (...args: unknown[]) => { origError(...args); addLog('error', args); };
    console.warn = (...args: unknown[]) => { origWarn(...args); addLog('warn', args); };
    console.log = (...args: unknown[]) => { origLog(...args); addLog('log', args); };

    const handleError = (e: ErrorEvent) => addLog('error', [`[UncaughtError] ${e.message}`, e.error].filter(Boolean));
    const handleRejection = (e: PromiseRejectionEvent) => addLog('error', [`[UnhandledRejection]`, e.reason].filter(Boolean));

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  useEffect(() => {
    if (showConsole) consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLogs, showConsole]);

  // --- Utility: Recent Files & Lock ---

  useEffect(() => {
    const saved = localStorage.getItem('peco-recent-files');
    if (saved) setRecentFiles(JSON.parse(saved));
  }, []);

  const addToRecent = (path: string) => {
    setRecentFiles(prev => {
      const next = [path, ...prev.filter(p => p !== path)].slice(0, 10);
      localStorage.setItem('peco-recent-files', JSON.stringify(next));
      return next;
    });
  };

  // --- Handlers ---

  const handleOpen = async (explicitPath?: string) => {
    try {
      let selected = explicitPath;
      if (!selected) {
        selected = await open({
          multiple: false,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }) as string;
      }

      if (selected && typeof selected === 'string') {
        const content = await readFile(selected);
        const bytesForStore = new Uint8Array(content); 
        
        const blob = new Blob([bytesForStore.slice()], { type: 'application/pdf' });
        const file = new File([blob], selected.split(/[\\/]/).pop() || 'document.pdf');

        const doc = await loadPDF(file);
        doc.filePath = selected;
        setDocument(doc, bytesForStore);
        addToRecent(selected);
        setShowRecentDropdown(false);

        const pdf = await openPDF(bytesForStore.slice());
        const bboxMeta = await loadPecoToolBBoxMeta(pdf);

        try {
          const pageData = await loadPage(pdf, 0, bboxMeta);
          updatePageData(0, pageData, false);
        } catch (err) {
          console.error('[handleOpen] page 0 text extraction failed:', err);
          alert(`テキスト抽出に失敗しました:\n${err}`);
        }

        (async () => {
          try {
            for (let i = 0; i < doc.totalPages; i++) {
              if (i > 0 && i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 10));
              try {
                const dataUrl = await generateThumbnail(pdf, i);
                setThumbnail(i, dataUrl);
              } catch (err) {
                console.error("Thumbnail error:", err);
              }
            }
          } finally {
            try {
              pdf.destroy();
            } catch (e) {
              console.error(e);
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
      console.log('[handleSave] starting save... 1');
      const bytesToSave = new Uint8Array(originalBytes); 
      const compressionPref = (localStorage.getItem('peco-save-compression') as 'none' | 'compressed' | 'rasterized') || 'none';
      const storedQuality = localStorage.getItem('peco-rasterize-quality');
      const qNum = storedQuality ? parseInt(storedQuality, 10) / 100 : 0.6;
      const savedBytes = await savePDF(bytesToSave, document, compressionPref, qNum);
      console.log('[handleSave] savePDF complete');
      
      await writeFile(document.filePath, savedBytes);
      resetDirty();
      showToast(`保存しました。(${formatFileSize(savedBytes.length)})`);
    } catch (err) {
      console.error("Failed to save:", err);
      showToast("保存に失敗しました。", true);
    }
  };

  const handleSaveAs = async () => {
    if (!document || !originalBytes) return;
    setShowSaveDialog(true);
    setIsEstimating(true);
    setEstimatedSizes(null);
    try {
      const sizes = await estimateSizes(new Uint8Array(originalBytes), document);
      setEstimatedSizes(sizes);
    } catch (err) {
      console.error("Failed to estimate sizes:", err);
    } finally {
      setIsEstimating(false);
    }
  };

  const executeSaveAs = async (compression: 'none' | 'compressed' | 'rasterized', quality?: number) => {
    setShowSaveDialog(false);
    if (!document || !originalBytes) return;
    try {
      const path = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: document.fileName
      });
      if (path && typeof path === 'string') {
        localStorage.setItem('peco-save-compression', compression);
        if (compression === 'rasterized' && typeof quality === 'number') {
          localStorage.setItem('peco-rasterize-quality', quality.toString());
        }

        const bytesToSave = new Uint8Array(originalBytes);
        
        // ラスタライズ時は重いのでToastでお知らせを出す
        if (compression === 'rasterized') {
          showToast(`高圧縮処理中です(画質${quality}%)...しばらくお待ち下さい`, false);
        }
        
        const savedBytes = await savePDF(bytesToSave, document, compression, quality ? quality / 100 : 0.6);

        await writeFile(path, savedBytes);
        document.filePath = path;
        resetDirty();
        showToast(`名前を付けて保存しました。(${formatFileSize(savedBytes.length)}・${compression === 'rasterized' ? '高圧縮' : compression === 'compressed' ? '標準圧縮' : '非圧縮'})`);
        addToRecent(path);
      }
    } catch (err) {
      console.error("Failed to save as:", err);
    }
  };

  const handleClose = useCallback(async () => {
    if (isDirty || Array.from(document?.pages.values() || []).some(p => p.isDirty)) {
      const confirmed = await ask('未保存の変更があります。閉じてもよろしいですか？', {
        title: '確認',
        kind: 'warning'
      });
      if (!confirmed) return;
    }
    setDocument(null);
  }, [isDirty, document, setDocument]);

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
    const sortedBlocks = [...currentPage.textBlocks].sort((a, b) => a.order - b.order);

    for (const block of sortedBlocks) {
      if (selectedIds.size > 0 && !selectedIds.has(block.id)) {
        blocksToKeep.push(block);
        continue;
      }
      const isDuplicate = blocksToKeep.some(existing => {
        if (selectedIds.size > 0 && !selectedIds.has(existing.id)) return false;
        if (existing.text.trim() !== block.text.trim()) return false;
        const dx = Math.abs(existing.bbox.x - block.bbox.x);
        const dy = Math.abs(existing.bbox.y - block.bbox.y);
        const dw = Math.abs(existing.bbox.width - block.bbox.width);
        const dh = Math.abs(existing.bbox.height - block.bbox.height);
        return dx < 5 && dy < 5 && dw < 5 && dh < 5;
      });
      if (isDuplicate) hasChanges = true;
      else blocksToKeep.push(block);
    }

    if (hasChanges) {
      const finalBlocks = blocksToKeep.map((b, i) => ({ ...b, order: i }));
      updatePageData(currentPageIndex, { textBlocks: finalBlocks, isDirty: true });
    }
  };

  // --- Refs & Effects ---

  const actionRefs = useRef<{ handleSave: () => void; handleSaveAs: () => void; handleDelete: () => void; handleGroup: () => void; toggleDrawingMode: () => void; toggleSplitMode: () => void; copySelected: () => void; pasteClipboard: () => void }>({
    handleSave: () => {},
    handleSaveAs: () => {},
    handleDelete: () => {},
    handleGroup: () => {},
    toggleDrawingMode: () => {},
    toggleSplitMode: () => {},
    copySelected: () => {},
    pasteClipboard: () => {},
  });

  actionRefs.current.handleSave = handleSave;
  actionRefs.current.handleSaveAs = handleSaveAs;
  actionRefs.current.handleDelete = handleDelete;
  actionRefs.current.handleGroup = handleGroup;
  actionRefs.current.toggleDrawingMode = toggleDrawingMode;
  actionRefs.current.toggleSplitMode = toggleSplitMode;
  actionRefs.current.copySelected = copySelected;
  actionRefs.current.pasteClipboard = pasteClipboard;

  const openPreviewWindow = async () => {
    try {
      const windows = await getAllWindows();
      const previewWin = windows.find(w => w.label === 'preview-window');
      
      if (previewWin) {
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

  const previewText = useMemo(() => {
    if (!currentPage?.textBlocks) return "";
    const sorted = [...currentPage.textBlocks].sort((a, b) => a.order - b.order);
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
  }, [currentPage]);

  useEffect(() => {
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
        const unlisten = await currentWindow.onCloseRequested(async (event) => {
          event.preventDefault();

          const state = usePecoStore.getState();
          const hasDirtyPages = Array.from(state.document?.pages.values() || []).some(p => p.isDirty);

          if (state.isDirty || hasDirtyPages) {
            const confirmed = await ask('未保存の変更があります。終了してもよろしいですか？', {
              title: '終了の確認',
              kind: 'warning'
            });
            if (!confirmed) return;
          }
          try {
            const windows = await getAllWindows();
            for (const w of windows) {
              if (w.label !== currentWindow.label) await w.close();
            }
          } catch (e) {
            console.error(e);
          }
          await currentWindow.destroy();
        });
        if (isUnmounted) unlisten();
        else unlistenFn = unlisten;
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
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;
      if (e.code === 'Space' && !isEditing) {
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
        if (e.shiftKey) redo();
        else undo();
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
        const zoomStep = 10;
        const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
        const newZoom = Math.max(25, Math.min(500, zoom + delta));
        setZoom(newZoom);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [undo, redo, zoom, setZoom]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (e.shiftKey) actionRefs.current.handleSaveAs();
        else actionRefs.current.handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing) {
        actionRefs.current.copySelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditing) {
        actionRefs.current.pasteClipboard();
      } else if (e.key === 'Delete' && !isEditing) {
        actionRefs.current.handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        window.document.querySelector<HTMLInputElement>('.search-box')?.focus();
      } else if (e.key === 'F10' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actionRefs.current.toggleDrawingMode();
      } else if (e.key === 'F11' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actionRefs.current.toggleSplitMode();
      } else if (e.key === 'F12' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actionRefs.current.handleGroup();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const latestLoadRef = useRef<number>(-1);
  const loadingTaskRef = useRef<ReturnType<typeof openPDFTask> | null>(null);

  useEffect(() => {
    if (document && !document.pages.has(currentPageIndex)) {
      loadCurrentPage(currentPageIndex);
    }
  }, [document, currentPageIndex]);

  const loadCurrentPage = async (pageIdx: number) => {
    latestLoadRef.current = pageIdx;

    // 短期間での連続呼び出し（高速スクロール等）をマージするためのデバウンス処理
    await new Promise(resolve => setTimeout(resolve, 50));
    if (latestLoadRef.current !== pageIdx) return;

    // 前の openPDF タスクが進行中ならキャンセル（並列ワーカー過多によるエラーを防ぐ）
    if (loadingTaskRef.current) {
      loadingTaskRef.current.destroy();
      loadingTaskRef.current = null;
    }

    const { originalBytes } = usePecoStore.getState();
    if (!originalBytes) return;

    let pdf: pdfjsLib.PDFDocumentProxy | null = null;
    const task = openPDFTask(originalBytes);
    loadingTaskRef.current = task;
    try {
      pdf = await task.promise;
      if (loadingTaskRef.current === task) loadingTaskRef.current = null;

      if (latestLoadRef.current !== pageIdx) return;

      const bboxMeta = await loadPecoToolBBoxMeta(pdf);
      const pageData = await loadPage(pdf, pageIdx, bboxMeta);

      if (latestLoadRef.current === pageIdx) {
        updatePageData(pageIdx, pageData, false);
      }
    } catch (err: any) {
      // キャンセルによる例外は無視
      if (latestLoadRef.current !== pageIdx) return;
      console.error(`[loadCurrentPage] failed for page ${pageIdx}:`, err);
      showToast(`ページ ${pageIdx + 1} の読み込みに失敗しました: ${err}`, true);
    } finally {
      if (loadingTaskRef.current === task) loadingTaskRef.current = null;
      if (pdf) {
        try {
          pdf.destroy();
        } catch (e) { console.error(e); }
      }
    }
  };

  // タイトルバー連動
  useEffect(() => {
    const updateTitle = async () => {
      try {
        const win = getCurrentWindow();
        const hasUnsaved = isDirty || Array.from(document?.pages.values() || []).some(p => p.isDirty);
        const dirtyMark = hasUnsaved ? "● " : "";
        const fileName = document ? ` - ${document.fileName}` : "";
        await win.setTitle(`${dirtyMark}PecoTool v2${fileName}`);
      } catch (e) {}
    };
    updateTitle();
  }, [isDirty, document, currentPageIndex]);

  // --- UI Resizing Handlers ---

  const startResizeLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    const onMouseMove = (moveEvent: MouseEvent) => setLeftWidth(Math.max(100, Math.min(500, startWidth + (moveEvent.clientX - startX))));
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
    const onMouseMove = (moveEvent: MouseEvent) => setRightWidth(Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX))));
    const onMouseUp = () => {
      window.document.removeEventListener('mousemove', onMouseMove);
      window.document.removeEventListener('mouseup', onMouseUp);
    };
    window.document.addEventListener('mousemove', onMouseMove);
    window.document.addEventListener('mouseup', onMouseUp);
  };

  const handleViewerMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed) {
      e.stopPropagation(); e.preventDefault();
      setIsPanning(true);
      const container = window.document.querySelector('.pdf-viewer-panel');
      if (container) setPanStart({ x: e.clientX, y: e.clientY, scrollX: container.scrollLeft, scrollY: container.scrollTop });
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

  const handleViewerMouseUp = () => { if (isPanning) setIsPanning(false); };

  // --- Render ---

  return (
    <div 
      className="app-container"
      onContextMenu={(e) => {
        e.preventDefault();
        setHelpMenu({ x: e.clientX, y: e.clientY, visible: true });
      }}
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
            <div className="help-item"><kbd>Alt</kbd>+<span>ドラッグで一括序列</span></div>
            <div className="help-item"><kbd>Alt</kbd>+<span>ホイールでズーム</span></div>
          </div>
        </div>
      )}

      <header className="toolbar">
        <div className="toolbar-group">
          <div className="btn-group">
            <button onClick={() => handleOpen()} title="開く"><FolderOpen size={18} /><span>開く</span></button>
            <button className="dropdown-btn" onClick={(e) => { e.stopPropagation(); setShowRecentDropdown(!showRecentDropdown); }} title="最近のファイル">
              <ChevronDown size={14} />
            </button>
            {showRecentDropdown && recentFiles.length > 0 && (
              <div className="recent-dropdown">
                {recentFiles.map((path, i) => (
                  <div key={i} className="recent-item" onClick={() => handleOpen(path)} title={path}>
                    {path.split(/[\\/]/).pop()}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={handleClose} title="閉じる" disabled={!document} className="danger"><X size={18} /><span>閉じる</span></button>
          <button onClick={handleSave} title="保存" disabled={!document || (!isDirty && !currentPage?.isDirty)}><Save size={18} /><span>保存</span></button>
          <button onClick={handleSaveAs} title="名前を付けて保存" disabled={!document}><Save size={18} /><span>別名で保存</span></button>
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
          <button onClick={toggleDrawingMode} title="BB追加" className={isDrawingMode ? "active" : ""} disabled={!document}><Plus size={18} /><span>追加</span></button>
          <button onClick={toggleSplitMode} title="BB分割" className={isSplitMode ? "active" : ""} disabled={!document}><Scissors size={18} /><span>分割</span></button>
          <button onClick={handleGroup} title="グループ化" disabled={selectedIds.size < 2}><Group size={18} /><span>グループ化</span></button>
          <button onClick={handleDeduplicate} title="重複削除"><Eraser size={18} /><span>重複削除</span></button>
          <button onClick={handleDelete} title="削除" className="danger" disabled={selectedIds.size === 0}><Trash2 size={18} /></button>
        </div>
        <div className="divider" />
        <div className="toolbar-group">
          <button onClick={toggleShowOcr} title="OCR表示" className={showOcr ? "active" : ""}><Eye size={18} /><span>OCR表示</span></button>
          
          <div className="btn-group">
            <button className={`dropdown-btn ${showSettingsDropdown ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); setShowSettingsDropdown(!showSettingsDropdown); setShowRecentDropdown(false); }} title="表示設定" style={{ padding: '4px 8px', borderLeft: '1px solid transparent', borderRadius: '4px' }}>
              <Settings size={14} style={{ marginRight: '4px' }}/><span>設定</span><ChevronDown size={14} style={{ marginLeft: '2px' }}/>
            </button>
            {showSettingsDropdown && (
              <div className="recent-dropdown settings-dropdown" onClick={(e) => e.stopPropagation()}>
                <div className="settings-item">
                  <div className="settings-item-header">OCRオーバーレイの濃さ</div>
                  <label className="settings-slider-row">
                    <input type="range" className="ocr-opacity-slider" min="0.05" max="1" step="0.05" value={ocrOpacity} onChange={(e) => setOcrOpacity(parseFloat(e.target.value))} />
                    <span>{Math.round(ocrOpacity * 100)}%</span>
                  </label>
                </div>
                <div className="help-divider" />
                <div className="settings-item">
                  <div className="settings-item-header">序列修正の閾値 <span style={{fontSize: '10px', color: '#9ca3af'}}>(Alt+ドラッグ)</span></div>
                  <label className="settings-slider-row">
                    <input type="range" className="ocr-opacity-slider" min="0" max="100" step="5" value={reorderThreshold} onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setReorderThreshold(val);
                      localStorage.setItem('peco-reorder-threshold', val.toString());
                    }} />
                    <span>{reorderThreshold}%</span>
                  </label>
                </div>
              </div>
            )}
          </div>
          
          <button onClick={openPreviewWindow} title="プレビュー" className="feature-btn" disabled={!document}><ClipboardList size={18} /><span>テキスト確認</span></button>
        </div>
      </header>

      <main className="main-content">
        <aside className="thumbnails-panel" style={{ width: `${leftWidth}px` }}>
          <div className="panel-header">サムネイル</div>
          <div className="scroll-content" tabIndex={0} onKeyDown={(e) => {
            if (!document) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); if (currentPageIndex < document.totalPages - 1) setCurrentPage(currentPageIndex + 1); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); if (currentPageIndex > 0) setCurrentPage(currentPageIndex - 1); }
          }}>
            {document ? Array.from({ length: document.totalPages }).map((_, i) => (
              <div key={i} className={`thumbnail-item ${i === currentPageIndex ? 'active' : ''}`} onClick={() => setCurrentPage(i)}>
                <div className="thumbnail-box">{thumbnails.get(i) ? <img src={thumbnails.get(i)} alt={`Page ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ color: '#d1d5db', fontSize: 24 }}>{i + 1}</span>}</div>
                <div className="thumbnail-label">{i + 1} ページ {document.pages.get(i)?.isDirty && "●"}</div>
              </div>
            )) : <div className="placeholder">なし</div>}
          </div>
        </aside>
        <div className="resizer" onMouseDown={startResizeLeft} />
        <section className={`pdf-viewer-panel ${isSpacePressed ? (isPanning ? 'grabbing' : 'grab') : ''}`} onMouseDown={handleViewerMouseDown} onMouseMove={handleViewerMouseMove} onMouseUp={handleViewerMouseUp} onMouseLeave={handleViewerMouseUp}>
          <div className="pdf-canvas-container">{document ? <PdfCanvas pageIndex={currentPageIndex} disableDrawing={isSpacePressed} /> : <div className="empty-state"><p>PDFファイルを [開く] から読み込んでください</p></div>}</div>
        </section>
        <div className="resizer" onMouseDown={startResizeRight} />
        <OcrEditor width={rightWidth} />
      </main>

      {showConsole && (
        <div className="console-panel">
          <div className="console-panel-header">
            <span className="console-panel-title">コンソール</span>
            <div className="console-panel-actions">
              <button className="console-panel-btn" onClick={() => setConsoleLogs([])}>クリア</button>
              <button className="console-panel-btn" onClick={() => setShowConsole(false)}>✕</button>
            </div>
          </div>
          <div className="console-log-list">
            {consoleLogs.length === 0
              ? <div style={{ padding: '8px 10px', color: '#6a9955', fontSize: 11 }}>ログなし</div>
              : consoleLogs.map((log, i) => (
                <div key={i} className={`console-log-entry ${log.level}`}>
                  <span className="console-log-time">{log.time}</span>
                  <span className="console-log-level">{log.level.toUpperCase()}</span>
                  <span className="console-log-message">{log.message}</span>
                </div>
              ))
            }
            <div ref={consoleEndRef} />
          </div>
        </div>
      )}

      <footer className="status-bar">
        <div className="status-item">ページ: {document ? `${currentPageIndex + 1} / ${document.totalPages}` : "0 / 0"}</div>
        <div className="status-item">ズーム: {zoom}%</div>
        <div className="status-item">BB数: {currentPage?.textBlocks?.length || 0}</div>
        <div className="status-item flex-grow" />
        {(isDirty || currentPage?.isDirty) && <div className="status-item unsaved">● 未保存の変更あり</div>}
        <div
          className={`status-item console-toggle-btn${consoleLogs.filter(l => l.level === 'error').length > 0 ? ' has-errors' : ''}`}
          onClick={() => setShowConsole(v => !v)}
          title="コンソールを開く"
        >
          <Terminal size={12} />
          <span>コンソール</span>
          {consoleLogs.filter(l => l.level === 'error').length > 0 && (
            <span className="console-error-badge">{consoleLogs.filter(l => l.level === 'error').length}</span>
          )}
        </div>
      </footer>
      {notification && <div className={`toast ${notification.isError ? 'toast-error' : 'toast-success'}`}>{notification.message}</div>}

      {showSaveDialog && (
        <SaveDialog 
          isEstimating={isEstimating}
          estimatedSizes={estimatedSizes}
          onConfirm={executeSaveAs}
          onCancel={() => setShowSaveDialog(false)}
          defaultCompression={(localStorage.getItem('peco-save-compression') as 'none' | 'compressed' | 'rasterized') || 'none'}
          defaultRasterizeQuality={localStorage.getItem('peco-rasterize-quality') ? parseInt(localStorage.getItem('peco-rasterize-quality')!, 10) : 60}
        />
      )}
    </div>
  );
}

export default App;
