import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { PecoDocument } from '../../types';

type ActiveMenu = 'file' | 'help' | null;

interface MenuBarProps {
  document: PecoDocument | null;
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
}

export const MenuBar: React.FC<MenuBarProps> = (props) => {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [showRecent, setShowRecent] = useState(false);
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
  };

  const close = () => {
    setActiveMenu(null);
    setShowRecent(false);
  };

  const run = (fn: () => void) => {
    close();
    fn();
  };

  const canSave = !!props.document && (props.isDirty || props.currentPageIsDirty);

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
            <div className="menu-dropdown-item" onClick={() => run(() => props.onOpen())}>
              開く<span className="menu-shortcut">Ctrl+O</span>
            </div>

            {/* 最近使ったファイル */}
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
                    <div
                      key={i}
                      className="menu-dropdown-item"
                      title={path}
                      onClick={() => run(() => props.onOpen(path))}
                    >
                      {path.split(/[\\/]/).pop()}
                    </div>
                  ))}
                </div>
              )}
              {showRecent && props.recentFiles.length === 0 && (
                <div className="menu-submenu">
                  <div className="menu-dropdown-item disabled">履歴なし</div>
                </div>
              )}
            </div>

            <div className="menu-separator" />
            <div
              className={`menu-dropdown-item ${!props.document ? 'disabled' : ''}`}
              onClick={() => props.document && run(props.onClose)}
            >
              閉じる
            </div>
            <div className="menu-separator" />
            <div
              className={`menu-dropdown-item ${!canSave ? 'disabled' : ''}`}
              onClick={() => canSave && run(props.onSave)}
            >
              保存<span className="menu-shortcut">Ctrl+S</span>
            </div>
            <div
              className={`menu-dropdown-item ${!props.document ? 'disabled' : ''}`}
              onClick={() => props.document && run(props.onSaveAs)}
            >
              別名で保存<span className="menu-shortcut">Ctrl+Shift+S</span>
            </div>
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
            <div className="menu-dropdown-item" onClick={() => run(props.onShowShortcuts)}>
              ショートカットキー一覧
            </div>
            <div className="menu-dropdown-item" onClick={() => run(props.onShowUsage)}>
              ツールの使い方
            </div>
            <div className="menu-separator" />
            <div className="menu-dropdown-item" onClick={() => run(props.onShowVersion)}>
              バージョン情報
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
