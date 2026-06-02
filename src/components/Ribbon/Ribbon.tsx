import React, { useState, useEffect, useRef } from 'react';
import { RibbonTab } from './RibbonTab';
import { FileTab } from './tabs/FileTab';
import { EditTab } from './tabs/EditTab';
import { OcrTab } from './tabs/OcrTab';
import { ViewTab } from './tabs/ViewTab';
import { SettingsTab } from './tabs/SettingsTab';
import { HelpTab } from './tabs/HelpTab';
import './Ribbon.css';
import type { PageData } from '../../types';
import type { TextExportFormat } from '../../utils/textExport';

type TabKey = 'file' | 'edit' | 'ocr' | 'view' | 'settings' | 'help';

export interface RibbonProps {
  // --- State props ---
  isFileLoaded: boolean;
  currentPage: PageData | undefined;
  isDirty: boolean;
  currentPageIsDirty: boolean;
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
  recentFiles: string[];

  // --- Action props (from Toolbar) ---
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
  onOpenBatchJob: () => void;
  onCancelOcr: () => void;
  onClearOcrCurrentPage: () => void;
  onClearOcrAllPages: () => void;
  onOpenReplace: () => void;

  // --- Action props (from MenuBar) ---
  onOpen: (path?: string) => void;
  onClose: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onReload: () => void;
  onExport: (scope: 'current' | 'all', format: TextExportFormat) => void;
  onShowShortcuts: () => void;
  onShowUsage: () => void;
  onShowVersion: () => void;
  onShowTour: () => void;
  onShowOcrSettings: () => void;
  onOpenLogFolder: () => void;
  onCheckUpdate: () => void;
}

type CompactClass = '' | 'ribbon--compact' | 'ribbon--icon-only';

export const Ribbon: React.FC<RibbonProps> = (props) => {
  const [activeTab, setActiveTab] = useState<TabKey>('file');
  const [compactClass, setCompactClass] = useState<CompactClass>('');
  const ribbonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ribbonRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width < 700) {
        setCompactClass('ribbon--icon-only');
      } else if (width < 900) {
        setCompactClass('ribbon--compact');
      } else {
        setCompactClass('');
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ribbonRef}
      className={`ribbon${compactClass ? ` ${compactClass}` : ''}`}
      role="toolbar"
      aria-label="リボン"
    >
      <div className="ribbon-tabs" role="tablist">
        <RibbonTab
          id="file"
          active={activeTab === 'file'}
          onClick={() => setActiveTab('file')}
          data-tour="menubar-file"
        >
          ファイル
        </RibbonTab>
        <RibbonTab
          id="edit"
          active={activeTab === 'edit'}
          onClick={() => setActiveTab('edit')}
        >
          編集
        </RibbonTab>
        <RibbonTab
          id="ocr"
          active={activeTab === 'ocr'}
          onClick={() => setActiveTab('ocr')}
        >
          OCR
        </RibbonTab>
        <RibbonTab
          id="view"
          active={activeTab === 'view'}
          onClick={() => setActiveTab('view')}
        >
          表示
        </RibbonTab>
        <RibbonTab
          id="settings"
          active={activeTab === 'settings'}
          onClick={() => setActiveTab('settings')}
        >
          設定
        </RibbonTab>
        <RibbonTab
          id="help"
          active={activeTab === 'help'}
          onClick={() => setActiveTab('help')}
          data-tour="menubar-help"
        >
          ヘルプ
        </RibbonTab>
      </div>

      <div
        className="ribbon-panel"
        role="tabpanel"
        id={`ribbon-panel-${activeTab}`}
        aria-labelledby={`ribbon-tab-${activeTab}`}
      >
        {activeTab === 'file' && (
          <FileTab
            isFileLoaded={props.isFileLoaded}
            isDirty={props.isDirty}
            currentPageIsDirty={props.currentPageIsDirty}
            recentFiles={props.recentFiles}
            onOpen={props.onOpen}
            onClose={props.onClose}
            onSave={props.onSave}
            onSaveAs={props.onSaveAs}
            onReload={props.onReload}
            onExport={props.onExport}
          />
        )}
        {activeTab === 'edit' && (
          <EditTab
            isFileLoaded={props.isFileLoaded}
            currentPage={props.currentPage}
            undoStackLength={props.undoStackLength}
            redoStackLength={props.redoStackLength}
            selectedIdsCount={props.selectedIdsCount}
            isDrawingMode={props.isDrawingMode}
            isSplitMode={props.isSplitMode}
            isCurveMode={props.isCurveMode}
            isOcrRunning={props.isOcrRunning}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            onSelectAllText={props.onSelectAllText}
            onRemoveSpaces={props.onRemoveSpaces}
            onOpenReplace={props.onOpenReplace}
            onToggleDrawing={props.onToggleDrawing}
            onToggleSplit={props.onToggleSplit}
            onToggleCurve={props.onToggleCurve}
            onGroup={props.onGroup}
            onDeduplicate={props.onDeduplicate}
            onDelete={props.onDelete}
          />
        )}
        {activeTab === 'ocr' && (
          <OcrTab
            isFileLoaded={props.isFileLoaded}
            isRangeOcrMode={props.isRangeOcrMode}
            isOcrRunning={props.isOcrRunning}
            ocrProgress={props.ocrProgress}
            onRunOcrCurrentPage={props.onRunOcrCurrentPage}
            onRunOcrAllPages={props.onRunOcrAllPages}
            onRunOcrRange={props.onRunOcrRange}
            onRunOcrFolder={props.onRunOcrFolder}
            onOpenBatchJob={props.onOpenBatchJob}
            onCancelOcr={props.onCancelOcr}
            onToggleRangeOcr={props.onToggleRangeOcr}
            onClearOcrCurrentPage={props.onClearOcrCurrentPage}
            onClearOcrAllPages={props.onClearOcrAllPages}
            onShowOcrSettings={props.onShowOcrSettings}
          />
        )}
        {activeTab === 'view' && (
          <ViewTab
            isFileLoaded={props.isFileLoaded}
            zoom={props.zoom}
            isAutoFit={props.isAutoFit}
            showOcr={props.showOcr}
            ocrOpacity={props.ocrOpacity}
            reorderThreshold={props.reorderThreshold}
            isPreviewOpen={props.isPreviewOpen}
            showSettingsDropdown={props.showSettingsDropdown}
            onZoomIn={props.onZoomIn}
            onZoomOut={props.onZoomOut}
            onFit={props.onFit}
            onToggleOcr={props.onToggleOcr}
            onTogglePreview={props.onTogglePreview}
            onSetOcrOpacity={props.onSetOcrOpacity}
            onSetReorderThreshold={props.onSetReorderThreshold}
            onToggleSettingsDropdown={props.onToggleSettingsDropdown}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            onOpenLogFolder={props.onOpenLogFolder}
            onCheckUpdate={props.onCheckUpdate}
          />
        )}
        {activeTab === 'help' && (
          <HelpTab
            onShowTour={props.onShowTour}
            onShowShortcuts={props.onShowShortcuts}
            onShowUsage={props.onShowUsage}
            onShowVersion={props.onShowVersion}
          />
        )}
      </div>
    </div>
  );
};
