import React, { useState, useEffect } from 'react';
import { ScanText, Loader2, X, FileX, ChevronDown, Crop } from 'lucide-react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';

interface OcrTabProps {
  isFileLoaded: boolean;
  isRangeOcrMode: boolean;
  isOcrRunning: boolean;
  ocrProgress: {
    current: number;
    total: number;
    fileCurrent?: number;
    fileTotal?: number;
    fileName?: string;
  } | null;
  onRunOcrCurrentPage: () => void;
  onRunOcrAllPages: () => void;
  onRunOcrRange: () => void;
  onRunOcrFolder: () => void;
  onOpenBatchJob: () => void;
  onCancelOcr: () => void;
  onToggleRangeOcr: () => void;
  onClearOcrCurrentPage: () => void;
  onClearOcrAllPages: () => void;
  onShowOcrSettings: () => void;
}

export const OcrTab: React.FC<OcrTabProps> = (props) => {
  const [showOcrDropdown, setShowOcrDropdown] = useState(false);
  const [showClearDropdown, setShowClearDropdown] = useState(false);

  useEffect(() => {
    if (!showOcrDropdown) return;
    const close = () => setShowOcrDropdown(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showOcrDropdown]);

  useEffect(() => {
    if (!showClearDropdown) return;
    const close = () => setShowClearDropdown(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showClearDropdown]);

  const progressLabel = props.isOcrRunning && props.ocrProgress
    ? props.ocrProgress.fileTotal
      ? `OCR ${props.ocrProgress.fileCurrent}/${props.ocrProgress.fileTotal} ${props.ocrProgress.current}/${props.ocrProgress.total}`
      : `OCR ${props.ocrProgress.current}/${props.ocrProgress.total}`
    : 'OCR実行';

  return (
    <>
      <RibbonGroup title="実行">
        <div className="ribbon-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
          <RibbonButton
            onClick={(e) => { e.stopPropagation(); setShowOcrDropdown(!showOcrDropdown); }}
            disabled={props.isOcrRunning}
            title="OCR実行"
            data-tour="toolbar-ocr"
          >
            {props.isOcrRunning
              ? <Loader2 size={14} style={{ marginRight: 4, animation: 'spin 1s linear infinite' }} />
              : <ScanText size={14} style={{ marginRight: 4 }} />
            }
            <span>{progressLabel}</span>
            {!props.isOcrRunning && <ChevronDown size={12} style={{ marginLeft: 2 }} />}
          </RibbonButton>
          {showOcrDropdown && !props.isOcrRunning && (
            <div className="ribbon-dropdown" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="ribbon-dropdown-item" disabled={!props.isFileLoaded}
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrCurrentPage(); }}>
                現在のページ
              </button>
              <button type="button" className="ribbon-dropdown-item" disabled={!props.isFileLoaded}
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrAllPages(); }}>
                全ページ
              </button>
              <button type="button" className="ribbon-dropdown-item" disabled={!props.isFileLoaded}
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrRange(); }}>
                ページ範囲指定...
              </button>
              <button type="button" className="ribbon-dropdown-item"
                onClick={() => { setShowOcrDropdown(false); props.onRunOcrFolder(); }}>
                フォルダ内PDF
              </button>
              <button type="button" className="ribbon-dropdown-item"
                onClick={() => { setShowOcrDropdown(false); props.onOpenBatchJob(); }}>
                フォルダ一括処理 (高度)
              </button>
            </div>
          )}
        </div>
        {props.isOcrRunning && props.ocrProgress && (
          <RibbonButton
            onClick={props.onCancelOcr}
            className="danger"
            title="キャンセル"
          >
            <X size={14} /><span>キャンセル</span>
          </RibbonButton>
        )}
      </RibbonGroup>

      <RibbonGroup title="範囲">
        <RibbonButton
          onClick={props.onToggleRangeOcr}
          disabled={!props.isFileLoaded || props.isOcrRunning}
          className={props.isRangeOcrMode ? 'active' : ''}
          aria-pressed={props.isRangeOcrMode ? 'true' : 'false'}
          title="範囲指定OCR"
        >
          <Crop size={14} /><span>範囲指定</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="消去">
        <div className="ribbon-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
          <RibbonButton
            onClick={(e) => { e.stopPropagation(); setShowClearDropdown(!showClearDropdown); }}
            disabled={!props.isFileLoaded}
            title="OCRテキストを消去"
          >
            <FileX size={14} style={{ marginRight: 4 }} />
            <span>OCR消去</span>
            <ChevronDown size={12} style={{ marginLeft: 2 }} />
          </RibbonButton>
          {showClearDropdown && (
            <div className="ribbon-dropdown" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="ribbon-dropdown-item"
                onClick={() => { setShowClearDropdown(false); props.onClearOcrCurrentPage(); }}>
                現在のページ
              </button>
              <button type="button" className="ribbon-dropdown-item"
                onClick={() => { setShowClearDropdown(false); props.onClearOcrAllPages(); }}>
                全ページ
              </button>
            </div>
          )}
        </div>
      </RibbonGroup>

      <RibbonGroup title="設定">
        <RibbonButton onClick={props.onShowOcrSettings} title="OCR序列設定">
          OCR序列設定
        </RibbonButton>
      </RibbonGroup>
    </>
  );
};
