import React from 'react';
import { ZoomIn, ZoomOut, Maximize, Eye, ClipboardList } from 'lucide-react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';

interface ViewTabProps {
  isFileLoaded: boolean;
  zoom: number;
  isAutoFit: boolean;
  showOcr: boolean;
  ocrOpacity: number;
  reorderThreshold: number;
  isPreviewOpen: boolean;
  showSettingsDropdown: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleOcr: () => void;
  onTogglePreview: () => void;
  onSetOcrOpacity: (val: number) => void;
  onSetReorderThreshold: (val: number) => void;
  onToggleSettingsDropdown: (e: React.MouseEvent) => void;
}

export const ViewTab: React.FC<ViewTabProps> = (props) => {
  return (
    <>
      <RibbonGroup title="ズーム">
        <RibbonButton onClick={props.onZoomIn} title="拡大" size="large">
          <ZoomIn /><span>拡大</span>
        </RibbonButton>
        <RibbonButton onClick={props.onZoomOut} title="縮小" size="large">
          <ZoomOut /><span>縮小</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onFit}
          className={props.isAutoFit ? 'active' : ''}
          title="フィット (Ctrl+0)"
          size="large"
        >
          <Maximize /><span>フィット</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="パネル">
        <RibbonButton
          onClick={props.onToggleOcr}
          className={props.showOcr ? 'active' : ''}
          title="OCR表示 (Ctrl+Q)"
        >
          <Eye size={14} /><span>OCR表示</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onTogglePreview}
          disabled={!props.isFileLoaded}
          className={`feature-btn${props.isPreviewOpen ? ' active' : ''}`}
          title="プレビュー"
        >
          <ClipboardList size={14} /><span>テキスト確認</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="表示設定">
        <div className="ribbon-view-sliders">
          <div className="ribbon-slider-row">
            <span className="ribbon-slider-label">OCRオーバーレイ</span>
            <input
              type="range"
              className="ocr-opacity-slider"
              min="0.05"
              max="1"
              step="0.05"
              value={props.ocrOpacity}
              onChange={(e) => props.onSetOcrOpacity(parseFloat(e.target.value))}
            />
            <span className="ribbon-slider-value">{Math.round(props.ocrOpacity * 100)}%</span>
          </div>
          <div className="ribbon-slider-row">
            <span className="ribbon-slider-label">序列閾値</span>
            <input
              type="range"
              className="ocr-opacity-slider"
              min="0"
              max="100"
              step="5"
              value={props.reorderThreshold}
              onChange={(e) => props.onSetReorderThreshold(parseInt(e.target.value, 10))}
            />
            <span className="ribbon-slider-value">{props.reorderThreshold}%</span>
          </div>
        </div>
      </RibbonGroup>
    </>
  );
};
