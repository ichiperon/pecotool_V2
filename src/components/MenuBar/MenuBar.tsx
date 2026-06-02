import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TextExportFormat } from '../../utils/textExport';

type ActiveMenu = 'file' | 'settings' | 'help' | null;

interface MenuBarProps {
  isFileLoaded: boolean;
  isDirty: boolean;
  currentPageIsDirty: boolean;
  recentFiles: string[];
  onOpen: (path?: string) => void;
  onClose: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onShowShortcuts: () => void;
  onShowUsage: () => void;
  onShowVersion: () => void;
  onReload: () => void;
  onShowOcrSettings: () => void;
  onOpenLogFolder: () => void;
  onExport: (scope: 'current' | 'all', format: TextExportFormat) => void;
}

export const MenuBar: React.FC<MenuBarProps> = (props) => {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [showExport, setShowExport] = useState<'current' | 'all' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
        setShowRecent(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (menu: ActiveMenu) => {
    setActiveMenu(prev => prev === menu ? null : menu);
    setShowRecent(false);
    setShowExport(null);
  };

  const close = () => {
    setActiveMenu(null);
    setShowRecent(false);
    setShowExport(null);
  };

  const run = (fn: () => void) => {
    close();
    fn();
  };

  const canSave = props.isFileLoaded && (props.isDirty || props.currentPageIsDirty);

  return (
    <div className="menubar" ref={barRef}>
      {/* ファイル */}
      <div className="menubar-item-wrap">
        <button
          className={`menubar-item ${activeMenu === 'file' ? 'active' : ''}`}
          onClick={() => toggle('file')}
        >
          ファイル
        </button>
        {activeMenu === 'file' && (
          <div className="menu-dropdown">
            <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onOpen())}>
              開く<span className="menu-shortcut">Ctrl+O</span>
            </button>

            {/* 最近使ったファイル (親はサブメニュー hover トリガなので div のまま) */}
            <div
              className={`menu-dropdown-item menu-has-sub ${showRecent ? 'active' : ''}`}
              onMouseEnter={() => setShowRecent(true)}
              onMouseLeave={() => setShowRecent(false)}
            >
              最近使ったファイル
              <ChevronRight size={12} className="menu-sub-arrow" />
              {showRecent && props.recentFiles.length > 0 && (
                <div className="menu-submenu">
                  {props.recentFiles.map((path, i) => (
                    <button
                      type="button"
                      key={i}
                      className="menu-dropdown-item"
                      title={path}
                      onClick={() => run(() => props.onOpen(path))}
                    >
                      {path.split(/[\\/]/).pop()}
                    </button>
                  ))}
                </div>
              )}
              {showRecent && props.recentFiles.length === 0 && (
                <div className="menu-submenu">
                  <div className="menu-dropdown-item disabled">履歴なし</div>
                </div>
              )}
            </div>

            <button
              type="button"
              className={`menu-dropdown-item ${!props.isFileLoaded ? 'disabled' : ''}`}
              onClick={() => run(props.onReload)}
              disabled={!props.isFileLoaded}
            >
              再読み込み<span className="menu-shortcut">F5</span>
            </button>
            <div className="menu-separator" />
            <button
              type="button"
              className={`menu-dropdown-item ${!props.isFileLoaded ? 'disabled' : ''}`}
              onClick={() => run(props.onClose)}
              disabled={!props.isFileLoaded}
            >
              閉じる
            </button>
            <div className="menu-separator" />
            <button
              type="button"
              className={`menu-dropdown-item ${!canSave ? 'disabled' : ''}`}
              onClick={() => run(props.onSave)}
              disabled={!canSave}
            >
              保存<span className="menu-shortcut">Ctrl+S</span>
            </button>
            <button
              type="button"
              className={`menu-dropdown-item ${!props.isFileLoaded ? 'disabled' : ''}`}
              onClick={() => run(props.onSaveAs)}
              disabled={!props.isFileLoaded}
            >
              別名で保存<span className="menu-shortcut">Ctrl+Shift+S</span>
            </button>
            <div className="menu-separator" />

            {/* エクスポート */}
            <div
              className={`menu-dropdown-item menu-has-sub ${!props.isFileLoaded ? 'disabled' : ''} ${showExport !== null ? 'active' : ''}`}
              onMouseEnter={() => props.isFileLoaded && setShowExport(null)}
              onMouseLeave={() => setShowExport(null)}
              aria-disabled={!props.isFileLoaded ? 'true' : 'false'}
            >
              エクスポート
              <ChevronRight size={12} className="menu-sub-arrow" />
              {props.isFileLoaded && (
                <div className="menu-submenu">
                  {/* 現在のページ */}
                  <div
                    className={`menu-dropdown-item menu-has-sub ${showExport === 'current' ? 'active' : ''}`}
                    onMouseEnter={() => setShowExport('current')}
                    onMouseLeave={() => setShowExport(null)}
                  >
                    現在のページ
                    <ChevronRight size={12} className="menu-sub-arrow" />
                    {showExport === 'current' && (
                      <div className="menu-submenu">
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('current', 'txt'))}>
                          テキスト (.txt)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('current', 'md'))}>
                          Markdown (.md)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('current', 'csv'))}>
                          CSV (.csv)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('current', 'json'))}>
                          JSON (.json)
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 全ページ */}
                  <div
                    className={`menu-dropdown-item menu-has-sub ${showExport === 'all' ? 'active' : ''}`}
                    onMouseEnter={() => setShowExport('all')}
                    onMouseLeave={() => setShowExport(null)}
                  >
                    全ページ
                    <ChevronRight size={12} className="menu-sub-arrow" />
                    {showExport === 'all' && (
                      <div className="menu-submenu">
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('all', 'txt'))}>
                          テキスト (.txt)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('all', 'md'))}>
                          Markdown (.md)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('all', 'csv'))}>
                          CSV (.csv)
                        </button>
                        <button type="button" className="menu-dropdown-item" onClick={() => run(() => props.onExport('all', 'json'))}>
                          JSON (.json)
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 設定 */}
      <div className="menubar-item-wrap">
        <button
          className={`menubar-item ${activeMenu === 'settings' ? 'active' : ''}`}
          onClick={() => toggle('settings' as ActiveMenu)}
        >
          設定
        </button>
        {activeMenu === 'settings' && (
          <div className="menu-dropdown">
            <button type="button" className="menu-dropdown-item" onClick={() => run(props.onShowOcrSettings)}>
              OCR 序列設定
            </button>
          </div>
        )}
      </div>

      {/* ヘルプ */}
      <div className="menubar-item-wrap">
        <button
          className={`menubar-item ${activeMenu === 'help' ? 'active' : ''}`}
          onClick={() => toggle('help')}
        >
          ヘルプ
        </button>
        {activeMenu === 'help' && (
          <div className="menu-dropdown">
            <button type="button" className="menu-dropdown-item" onClick={() => run(props.onShowShortcuts)}>
              ショートカットキー一覧
            </button>
            <button type="button" className="menu-dropdown-item" onClick={() => run(props.onShowUsage)}>
              ツールの使い方
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-dropdown-item" onClick={() => run(props.onOpenLogFolder)}>
              ログフォルダを開く
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-dropdown-item" onClick={() => run(props.onShowVersion)}>
              バージョン情報
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
