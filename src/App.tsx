import { useEffect, useState } from "react";
import "./App.css";
import { usePecoStore } from "./store/pecoStore";
import { FolderOpen, Save, RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize, Plus, Group, Trash2, Eye, Scissors } from "lucide-react";
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { loadPDF, loadPage, openPDF, generateThumbnail } from "./utils/pdfLoader";
import { savePDF } from "./utils/pdfSaver";
import { PdfCanvas } from "./components/PdfCanvas";
import { OcrEditor } from "./components/OcrEditor";

function App() {
  const { document, setDocument, setThumbnail, originalBytes, currentPageIndex, zoom, setZoom, setCurrentPage, updatePageData, selectedIds, clearSelection, showOcr, toggleShowOcr, undo, redo, undoStack, redoStack, isDrawingMode, toggleDrawingMode, isSplitMode, toggleSplitMode, isDirty, thumbnails } = usePecoStore();

  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(350);

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

  const fitToScreen = () => {
    const container = window.document.querySelector('.pdf-canvas-container');
    const canvas = window.document.querySelector('.canvas-wrapper canvas');
    if (container && canvas) {
      const canvasH = (canvas as HTMLCanvasElement).height;
      const canvasW = (canvas as HTMLCanvasElement).width;
      if (canvasH > 0 && canvasW > 0) {
        const baseH = canvasH / (zoom / 100);
        const baseW = canvasW / (zoom / 100);
        const ratioH = (container.clientHeight - 40) / baseH;
        const ratioW = (container.clientWidth - 40) / baseW;
        setZoom(Math.floor(Math.min(ratioH, ratioW) * 100));
      }
    }
  };

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
        fitToScreen();
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) {
        e.preventDefault();
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

  useEffect(() => {
    if (document && !document.pages.has(currentPageIndex)) {
      loadCurrentPage();
    }
  }, [document, currentPageIndex]);

  const loadCurrentPage = async () => {
    if (!document || !originalBytes) return;
    try {
      // Use openPDF (which calls .slice() internally) to avoid transferring the shared buffer
      const pdf = await openPDF(originalBytes);
      const pageData = await loadPage(pdf, currentPageIndex);
      updatePageData(currentPageIndex, pageData);
    } catch (err) {
      console.error("Failed to load page data:", err);
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

        // Generate thumbnails for all pages in background
        const pdf = await openPDF(content);
        for (let i = 0; i < doc.totalPages; i++) {
          generateThumbnail(pdf, i).then(dataUrl => setThumbnail(i, dataUrl));
        }
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
      alert("保存しました。");
    } catch (err) {
      console.error("Failed to save:", err);
      alert("保存に失敗しました。");
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
        alert("名前を付けて保存しました。");
      }
    } catch (err) {
      console.error("Failed to save as:", err);
    }
  };

  const currentPage = document?.pages.get(currentPageIndex);

  const handleGroup = () => {
    if (!currentPage || selectedIds.size < 2) return;

    const selectedBlocks = currentPage.textBlocks.filter(b => selectedIds.has(b.id));
    const sortedSelected = [...selectedBlocks].sort((a, b) => a.order - b.order);
    
    const combinedText = sortedSelected.map(b => b.text).join("");
    
    const minX = Math.min(...sortedSelected.map(b => b.bbox.x));
    const minY = Math.min(...sortedSelected.map(b => b.bbox.y));
    const maxX = Math.max(...sortedSelected.map(b => b.bbox.x + b.bbox.width));
    const maxY = Math.max(...sortedSelected.map(b => b.bbox.y + b.bbox.height));

    const insertIndex = sortedSelected[0].order;

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
          <button onClick={() => setZoom(Math.max(25, zoom + 10))} title="拡大"><ZoomIn size={18} /></button>
          <button onClick={() => setZoom(Math.max(25, zoom - 10))} title="縮小"><ZoomOut size={18} /></button>
          <button onClick={fitToScreen} title="フィット (Ctrl+0)"><Maximize size={18} /></button>
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
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        <aside className="thumbnails-panel" style={{ width: `${leftWidth}px` }}>
          <div className="panel-header">サムネイル</div>
          <div className="scroll-content">
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

        <section className="pdf-viewer-panel">
          <div className="pdf-canvas-container">
            {document ? (
              <PdfCanvas pageIndex={currentPageIndex} />
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
    </div>
  );
}

export default App;
