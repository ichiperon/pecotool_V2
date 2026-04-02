import React from 'react';
import { 
  FolderOpen, Save, RotateCcw, RotateCw, ZoomIn, ZoomOut, Maximize, 
  Plus, Group, Trash2, Eye, Scissors, ClipboardList, Eraser, X, 
  ChevronDown, Settings 
} from "lucide-react";

interface ToolbarProps {
  document: any;
  currentPage: any;
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
  recentFiles: string[];
  showRecentDropdown: boolean;
  showSettingsDropdown: boolean;
  
  onOpen: (path?: string) => void;
  onClose: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleDrawing: () => void;
  onToggleSplit: () => void;
  onGroup: () => void;
  onDeduplicate: () => void;
  onDelete: () => void;
  onToggleOcr: () => void;
  onSetOcrOpacity: (val: number) => void;
  onSetReorderThreshold: (val: number) => void;
  onTogglePreview: () => void;
  onToggleRecentDropdown: (e: React.MouseEvent) => void;
  onToggleSettingsDropdown: (e: React.MouseEvent) => void;
}

export const Toolbar: React.FC<ToolbarProps> = (props) => {
  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <div className="btn-group">
          <button onClick={() => props.onOpen()} title="開く"><FolderOpen size={18} /><span>開く</span></button>
          <button className="dropdown-btn" onClick={props.onToggleRecentDropdown} title="最近のファイル">
            <ChevronDown size={14} />
          </button>
          {props.showRecentDropdown && props.recentFiles.length > 0 && (
            <div className="recent-dropdown">
              {props.recentFiles.map((path, i) => (
                <div key={i} className="recent-item" onClick={() => props.onOpen(path)} title={path}>
                  {path.split(/[\\/]/).pop()}
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={props.onClose} title="閉じる" disabled={!props.document} className="danger"><X size={18} /><span>閉じる</span></button>
        <button onClick={props.onSave} title="保存" disabled={!props.document || (!props.isDirty && !props.currentPage?.isDirty)}><Save size={18} /><span>保存</span></button>
        <button onClick={props.onSaveAs} title="名前を付けて保存" disabled={!props.document}><Save size={18} /><span>別名で保存</span></button>
      </div>
      
      <div className="divider" />
      
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
    </header>
  );
};
