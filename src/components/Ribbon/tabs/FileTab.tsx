import React, { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';
import type { TextExportFormat } from '../../../utils/textExport';

interface FileTabProps {
  isFileLoaded: boolean;
  isDirty: boolean;
  currentPageIsDirty: boolean;
  recentFiles: string[];
  onOpen: (path?: string) => void;
  onClose: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onReload: () => void;
  onExport: (scope: 'current' | 'all', format: TextExportFormat) => void;
}

export const FileTab: React.FC<FileTabProps> = (props) => {
  const [showRecent, setShowRecent] = useState(false);
  const [showExport, setShowExport] = useState<'current' | 'all' | null>(null);

  useEffect(() => {
    if (!showRecent && showExport === null) return;
    const close = () => {
      setShowRecent(false);
      setShowExport(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showRecent, showExport]);

  const canSave = props.isFileLoaded && (props.isDirty || props.currentPageIsDirty);

  return (
    <>
      <RibbonGroup title="開く/保存">
        <RibbonButton onClick={() => props.onOpen()} title="開く (Ctrl+O)">
          開く
        </RibbonButton>
        <RibbonButton
          onClick={props.onSave}
          disabled={!canSave}
          title="保存 (Ctrl+S)"
        >
          保存
        </RibbonButton>
        <RibbonButton
          onClick={props.onSaveAs}
          disabled={!props.isFileLoaded}
          title="別名で保存 (Ctrl+Shift+S)"
        >
          別名保存
        </RibbonButton>
        <RibbonButton
          onClick={props.onClose}
          disabled={!props.isFileLoaded}
          title="閉じる"
        >
          閉じる
        </RibbonButton>
        <RibbonButton
          onClick={props.onReload}
          disabled={!props.isFileLoaded}
          title="再読み込み (F5)"
        >
          再読込
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="最近">
        <div className="ribbon-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
          <RibbonButton
            onClick={() => setShowRecent(!showRecent)}
            title="最近使ったファイル"
          >
            最近 <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} />
          </RibbonButton>
          {showRecent && (
            <div className="ribbon-dropdown">
              {props.recentFiles.length === 0 ? (
                <div className="ribbon-dropdown-item disabled">履歴なし</div>
              ) : (
                props.recentFiles.map((path, i) => (
                  <button
                    key={i}
                    type="button"
                    className="ribbon-dropdown-item"
                    title={path}
                    onClick={() => { setShowRecent(false); props.onOpen(path); }}
                  >
                    {path.split(/[\\/]/).pop()}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </RibbonGroup>

      <RibbonGroup title="エクスポート">
        <div className="ribbon-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
          <RibbonButton
            disabled={!props.isFileLoaded}
            onClick={() => props.isFileLoaded && setShowExport(showExport === 'current' ? null : 'current')}
            title="現在のページをエクスポート"
          >
            現在ページ <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} />
          </RibbonButton>
          {showExport === 'current' && props.isFileLoaded && (
            <div className="ribbon-dropdown">
              {(['txt', 'md', 'csv', 'json'] as TextExportFormat[]).map(fmt => (
                <button
                  key={fmt}
                  type="button"
                  className="ribbon-dropdown-item"
                  onClick={() => { setShowExport(null); props.onExport('current', fmt); }}
                >
                  {fmt === 'txt' ? 'テキスト (.txt)' : fmt === 'md' ? 'Markdown (.md)' : fmt === 'csv' ? 'CSV (.csv)' : 'JSON (.json)'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ribbon-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
          <RibbonButton
            disabled={!props.isFileLoaded}
            onClick={() => props.isFileLoaded && setShowExport(showExport === 'all' ? null : 'all')}
            title="全ページをエクスポート"
          >
            全ページ <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} />
          </RibbonButton>
          {showExport === 'all' && props.isFileLoaded && (
            <div className="ribbon-dropdown">
              {(['txt', 'md', 'csv', 'json'] as TextExportFormat[]).map(fmt => (
                <button
                  key={fmt}
                  type="button"
                  className="ribbon-dropdown-item"
                  onClick={() => { setShowExport(null); props.onExport('all', fmt); }}
                >
                  {fmt === 'txt' ? 'テキスト (.txt)' : fmt === 'md' ? 'Markdown (.md)' : fmt === 'csv' ? 'CSV (.csv)' : 'JSON (.json)'}
                </button>
              ))}
            </div>
          )}
        </div>
      </RibbonGroup>
    </>
  );
};
