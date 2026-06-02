import { useEffect, useRef } from 'react';
import { MousePointer2, X } from 'lucide-react';
import type { HelpMenuState } from '../hooks/useDialogState';

interface Props {
  helpMenu: HelpMenuState;
  onClose: () => void;
}

// 右クリックショートカットヘルプ（既存機能を維持）
// Issue #156: キーボード操作対応 (Esc で閉じる + 閉じるボタン + role/aria-label)
export function HelpMenu({ helpMenu, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!helpMenu.visible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    // 表示時に閉じるボタンへフォーカスを移してキーボード操作の起点を作る
    closeBtnRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [helpMenu.visible, onClose]);

  if (!helpMenu.visible) return null;
  return (
    <div
      ref={rootRef}
      className="help-context-menu"
      style={{ top: helpMenu.y, left: helpMenu.x }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="false"
      aria-label="ショートカットヘルプメニュー"
    >
      <div className="help-header">
        <MousePointer2 size={14} />
        <span>ショートカットヘルプ</span>
        <button
          ref={closeBtnRef}
          type="button"
          className="help-close-btn"
          aria-label="ヘルプメニューを閉じる"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="help-grid">
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>O</kbd><span>開く</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名保存</span></div>
        <div className="help-divider" />
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
        <div className="help-divider" />
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>B</kbd><span>追加</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>X</kbd><span>分割</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>G</kbd><span>グループ化</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd><span>スペース削除</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd><span>BB移動</span></div>
        <div className="help-item"><kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd><span>隣接OCR/BBカード追加選択</span></div>
        <div className="help-divider" />
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>C</kbd><span>コピー</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>V</kbd><span>貼り付け</span></div>
        <div className="help-item"><kbd>Delete</kbd><span>BB削除</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>0</kbd><span>フィット</span></div>
        <div className="help-item"><kbd>Space</kbd>+<span>ドラッグで画面移動</span></div>
      </div>
    </div>
  );
}
