import React, { useEffect, useState } from 'react';
import {
  RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize,
  Plus, Group, Trash2, Eye, Scissors, ClipboardList, Eraser,
  ChevronDown, Settings, RemoveFormatting, ScanText, X, Loader2, FileX, Replace, SquareCheckBig, Spline, Crop
} from "lucide-react";
import { PageData } from '../../types';

interface ToolbarProps {
  isFileLoaded: boolean;
  currentPage: PageData | undefined;
  isDirty: boolean;
  undoStackLength: number;
  redoStackLength: number;
  zoom: number;
  isAutoFit: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  isCurveMode: boolean;
  isRangeOcrMode: boolean;
  selectedIdsCount: number;
  showOcr: boolean;
  ocrOpacity: number;
  reorderThreshold: number;
  isPreviewOpen: boolean;
  showSettingsDropdown: boolean;
  isOcrRunning: boolean;
  ocrProgress: {
    current: number;
    total: number;
    fileCurrent?: number;
    fileTotal?: number;
    fileName?: string;
  } | null;

  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleDrawing: () => void;
  onToggleSplit: () => void;
  onToggleCurve: () => void;
  onToggleRangeOcr: () => void;
  onGroup: () => void;
  onDeduplicate: () => void;
  onSelectAllText: () => void;
  onRemoveSpaces: () => void;
  onDelete: () => void;
  onToggleOcr: () => void;
  onSetOcrOpacity: (val: number) => void;
  onSetReorderThreshold: (val: number) => void;
  onTogglePreview: () => void;
  onToggleSettingsDropdown: (e: React.MouseEvent) => void;
  onRunOcrCurrentPage: () => void;
  onRunOcrAllPages: () => void;
  onRunOcrRange: () => void;
  onRunOcrFolder: () => void;
  onCancelOcr: () => void;
  onClearOcrCurrentPage: () => void;
  onClearOcrAllPages: () => void;
  /** issue #93: Find & Replace ダイアログを開く。ファイル未ロードなら disabled */
  onOpenReplace: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = (props) => {
  const [showOcrDropdown, setShowOcrDropdown] = useState(false);
  const [showClearOcrDropdown, setShowClearOcrDropdown] = useState(false);

  useEffect(() => {
    if (!showOcrDropdown) return;
    const close = () => setShowOcrDropdown(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showOcrDropdown]);

  useEffect(() => {
    if (!showClearOcrDropdown) return;
    const close = () => setShowClearOcrDropdown(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showClearOcrDropdown]);

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button onClick={props.onUndo} disabled={props.undoStackLength === 0} title="元に戻す (Ctrl+Z)"><RotateCcw size={18} /></button>
        <button onClick={props.onRedo} disabled={props.redoStackLength === 0} title="やり直し (Ctrl+Y)"><RotateCw size={18} /></button>
      </div>
      
      <div className="divider" />
      
      <div className="toolbar-group">
        <button onClick={props.onZoomIn} title="拡大"><ZoomIn size={18} /></button>
        <button onClick={props.onZoomOut} title="縮小"><ZoomOut size={18} /></button>
        <button onClick={props.onFit} title="フィット (Ctrl+0)" className={props.isAutoFit ? "active" : ""}><Maximize size={18} /></button>
      </div>
      
      <div className="divider" />
      
      <div className="toolbar-group">
        <button onClick={props.onToggleDrawing} title="BB追加" className={props.isDrawingMode ? "active" : ""} disabled={!props.isFileLoaded}><Plus size={18} /><span>追加</span></button>
        <button onClick={props.onToggleSplit} title="BB分割" className={props.isSplitMode ? "active" : ""} disabled={!props.isFileLoaded}><Scissors size={18} /><span>分割</span></button>
        {props.isCurveMode ? (
          <button type="button" onClick={props.onToggleCurve} title="湾曲モード" className="active" aria-pressed="true" disabled={!props.isFileLoaded}><Spline size={18} /><span>湾曲</span></button>
        ) : (
          <button type="button" onClick={props.onToggleCurve} title="湾曲モード" aria-pressed="false" disabled={!props.isFileLoaded}><Spline size={18} /><span>湾曲</span></button>
        )}
        {props.isRangeOcrMode ? (
          <button type="button" onClick={props.onToggleRangeOcr} title="範囲指定OCR" className="active" aria-pressed="true" disabled={!props.isFileLoaded || props.isOcrRunning}><Crop size={18} /><span>範囲OCR</span></button>
        ) : (
          <button type="button" onClick={props.onToggleRangeOcr} title="範囲指定OCR" aria-pressed="false" disabled={!props.isFileLoaded || props.isOcrRunning}><Crop size={18} /><span>範囲OCR</span></button>
        )}
        <button onClick={props.onGroup} title="グループ化" disabled={props.selectedIdsCount < 2}><Group size={18} /><span>グループ化</span></button>
        <button onClick={props.onDeduplicate} title="重複削除"><Eraser size={18} /><span>重複削除</span></button>
        <button onClick={props.onSelectAllText} title="テキスト全選択" disabled={!props.currentPage || props.currentPage.textBlocks.length === 0}><SquareCheckBig size={18} /><span>全選択</span></button>
        <button onClick={props.onRemoveSpaces} title="スペース削除 (Ctrl+Shift+Space)" disabled={props.selectedIdsCount === 0}><RemoveFormatting size={18} /><span>スペース削除</span></button>
        <button
          onClick={props.onOpenReplace}
          title={props.isOcrRunning ? '検索と置換 (OCR実行中は無効)' : '検索と置換 (Ctrl+H)'}
          /* #103: OCR 実行中は Replace を開けないようにする。
             置換結果が後追い OCR で上書きされる事故を防ぐ。 */
          disabled={!props.isFileLoaded || props.isOcrRunning}
        ><Replace size={18} /><span>検索と置換</span></button>
        <button onClick={props.onDelete} title="削除" className="danger" disabled={props.selectedIdsCount === 0}><Trash2 size={18} /></button>
      </div>
      
      <div className="divider" />
      
      <div className="toolbar-group">
        <button onClick={props.onToggleOcr} title="OCR表示 (Ctrl+Q)" className={props.showOcr ? "active" : ""}><Eye size={18} /><span>OCR表示</span></button>
        
        <div className="btn-group">
          <button className={`dropdown-btn ${props.showSettingsDropdown ? 'active' : ''}`} onClick={props.onToggleSettingsDropdown} title="表示設定" style={{ padding: '4px 8px', borderLeft: '1px solid transparent', borderRadius: '4px' }}>
            <Settings size={14} style={{ marginRight: '4px' }}/><span>設定</span><ChevronDown size={14} style={{ marginLeft: '2px' }}/>
          </button>
          {props.showSettingsDropdown && (
            <div className="recent-dropdown settings-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="settings-item">
                <div className="settings-item-header">OCRオーバーレイの濃さ</div>
                <label className="settings-slider-row">
                  <input type="range" className="ocr-opacity-slider" min="0.05" max="1" step="0.05" value={props.ocrOpacity} onChange={(e) => props.onSetOcrOpacity(parseFloat(e.target.value))} />
                  <span>{Math.round(props.ocrOpacity * 100)}%</span>
                </label>
              </div>
              <div className="help-divider" />
              <div className="settings-item">
                <div className="settings-item-header">序列修正の閾値 <span style={{fontSize: '10px', color: '#9ca3af'}}>(Alt+ドラッグ)</span></div>
                <label className="settings-slider-row">
                  <input type="range" className="ocr-opacity-slider" min="0" max="100" step="5" value={props.reorderThreshold} onChange={(e) => props.onSetReorderThreshold(parseInt(e.target.value, 10))} />
                  <span>{props.reorderThreshold}%</span>
                </label>
              </div>
            </div>
          )}
        </div>
        
        <button onClick={props.onTogglePreview} title="プレビュー" className={`feature-btn ${props.isPreviewOpen ? 'active' : ''}`} disabled={!props.isFileLoaded}><ClipboardList size={18} /><span>テキスト確認</span></button>
      </div>

      <div className="divider" />

      <div className="toolbar-group">
        <div className="btn-group">
          <button
            className={`dropdown-btn ${showOcrDropdown ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowOcrDropdown(!showOcrDropdown); }}
            disabled={props.isOcrRunning}
            title="OCR実行"
            style={{ padding: '4px 8px', borderLeft: '1px solid transparent', borderRadius: '4px' }}
            data-tour="toolbar-ocr"
          >
            {props.isOcrRunning
              ? <Loader2 size={14} style={{ marginRight: '4px', animation: 'spin 1s linear infinite' }} />
              : <ScanText size={14} style={{ marginRight: '4px' }} />
            }
            <span>
              {props.isOcrRunning && props.ocrProgress
                ? props.ocrProgress.fileTotal
                  ? `OCR ${props.ocrProgress.fileCurrent}/${props.ocrProgress.fileTotal} ${props.ocrProgress.current}/${props.ocrProgress.total}`
                  : `OCR ${props.ocrProgress.current}/${props.ocrProgress.total}`
                : 'OCR実行'}
            </span>
            {!props.isOcrRunning && <ChevronDown size={14} style={{ marginLeft: '2px' }} />}
          </button>
          {showOcrDropdown && !props.isOcrRunning && (
            <div className="recent-dropdown ocr-dropdown" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrCurrentPage(); }}
                disabled={!props.isFileLoaded}
              >
                現在のページ
              </button>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrAllPages(); }}
                disabled={!props.isFileLoaded}
              >
                全ページ
              </button>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrRange(); }}
                disabled={!props.isFileLoaded}
              >
                ページ範囲指定...
              </button>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrFolder(); }}
              >
                フォルダ内PDF
              </button>
            </div>
          )}
        </div>
        {props.isOcrRunning && props.ocrProgress && (
          <button onClick={props.onCancelOcr} title="キャンセル" className="danger">
            <X size={14} /><span>キャンセル</span>
          </button>
        )}

        <div className="btn-group">
          <button
            className={`dropdown-btn ${showClearOcrDropdown ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowClearOcrDropdown(!showClearOcrDropdown); }}
            disabled={!props.isFileLoaded}
            title="OCRテキストを消去"
            style={{ padding: '4px 8px', borderLeft: '1px solid transparent', borderRadius: '4px' }}
          >
            <FileX size={14} style={{ marginRight: '4px' }} />
            <span>OCR消去</span>
            <ChevronDown size={14} style={{ marginLeft: '2px' }} />
          </button>
          {showClearOcrDropdown && (
            <div className="recent-dropdown ocr-dropdown" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowClearOcrDropdown(false); props.onClearOcrCurrentPage(); }}
              >
                現在のページ
              </button>
              <button
                type="button"
                className="recent-item"
                onClick={() => { setShowClearOcrDropdown(false); props.onClearOcrAllPages(); }}
              >
                全ページ
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
