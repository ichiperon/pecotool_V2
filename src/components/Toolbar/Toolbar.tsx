import React, { useEffect, useState } from 'react';
import {
  RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize,
  Plus, Group, Trash2, Eye, Scissors, ClipboardList, Eraser,
  ChevronDown, Settings, RemoveFormatting, ScanText, X, Loader2
} from "lucide-react";
import { PageData, PecoDocument } from '../../types';

interface ToolbarProps {
  document: PecoDocument | null;
  currentPage: PageData | undefined;
  isDirty: boolean;
  undoStackLength: number;
  redoStackLength: number;
  zoom: number;
  isAutoFit: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  selectedIdsCount: number;
  showOcr: boolean;
  ocrOpacity: number;
  reorderThreshold: number;
  isPreviewOpen: boolean;
  showSettingsDropdown: boolean;
  isOcrRunning: boolean;
  ocrProgress: { current: number; total: number } | null;

  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleDrawing: () => void;
  onToggleSplit: () => void;
  onGroup: () => void;
  onDeduplicate: () => void;
  onRemoveSpaces: () => void;
  onDelete: () => void;
  onToggleOcr: () => void;
  onSetOcrOpacity: (val: number) => void;
  onSetReorderThreshold: (val: number) => void;
  onTogglePreview: () => void;
  onToggleSettingsDropdown: (e: React.MouseEvent) => void;
  onRunOcrCurrentPage: () => void;
  onRunOcrAllPages: () => void;
  onCancelOcr: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = (props) => {
  const [showOcrDropdown, setShowOcrDropdown] = useState(false);

  useEffect(() => {
    if (!showOcrDropdown) return;
    const close = () => setShowOcrDropdown(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showOcrDropdown]);

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
        <button onClick={props.onToggleDrawing} title="BB追加" className={props.isDrawingMode ? "active" : ""} disabled={!props.document}><Plus size={18} /><span>追加</span></button>
        <button onClick={props.onToggleSplit} title="BB分割" className={props.isSplitMode ? "active" : ""} disabled={!props.document}><Scissors size={18} /><span>分割</span></button>
        <button onClick={props.onGroup} title="グループ化" disabled={props.selectedIdsCount < 2}><Group size={18} /><span>グループ化</span></button>
        <button onClick={props.onDeduplicate} title="重複削除"><Eraser size={18} /><span>重複削除</span></button>
        <button onClick={props.onRemoveSpaces} title="スペース削除 (Ctrl+Shift+Space)" disabled={props.selectedIdsCount === 0}><RemoveFormatting size={18} /><span>スペース削除</span></button>
        <button onClick={props.onDelete} title="削除" className="danger" disabled={props.selectedIdsCount === 0}><Trash2 size={18} /></button>
      </div>
      
      <div className="divider" />
      
      <div className="toolbar-group">
        <button onClick={props.onToggleOcr} title="OCR表示" className={props.showOcr ? "active" : ""}><Eye size={18} /><span>OCR表示</span></button>
        
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
        
        <button onClick={props.onTogglePreview} title="プレビュー" className={`feature-btn ${props.isPreviewOpen ? 'active' : ''}`} disabled={!props.document}><ClipboardList size={18} /><span>テキスト確認</span></button>
      </div>

      <div className="divider" />

      <div className="toolbar-group">
        <div className="btn-group">
          <button
            className={`dropdown-btn ${showOcrDropdown ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowOcrDropdown(!showOcrDropdown); }}
            disabled={!props.document || props.isOcrRunning}
            title="OCR実行"
            style={{ padding: '4px 8px', borderLeft: '1px solid transparent', borderRadius: '4px' }}
          >
            {props.isOcrRunning
              ? <Loader2 size={14} style={{ marginRight: '4px', animation: 'spin 1s linear infinite' }} />
              : <ScanText size={14} style={{ marginRight: '4px' }} />
            }
            <span>
              {props.isOcrRunning && props.ocrProgress
                ? `OCR ${props.ocrProgress.current}/${props.ocrProgress.total}`
                : 'OCR実行'}
            </span>
            {!props.isOcrRunning && <ChevronDown size={14} style={{ marginLeft: '2px' }} />}
          </button>
          {showOcrDropdown && !props.isOcrRunning && (
            <div className="recent-dropdown ocr-dropdown" onClick={(e) => e.stopPropagation()}>
              <div
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrCurrentPage(); }}
              >
                現在のページ
              </div>
              <div
                className="recent-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrAllPages(); }}
              >
                全ページ
              </div>
            </div>
          )}
        </div>
        {props.isOcrRunning && props.ocrProgress && (
          <button onClick={props.onCancelOcr} title="キャンセル" className="danger">
            <X size={14} /><span>キャンセル</span>
          </button>
        )}
      </div>
    </header>
  );
};
