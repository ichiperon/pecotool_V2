import { MousePointer2 } from 'lucide-react';
import type { HelpMenuState } from '../hooks/useDialogState';

interface Props {
  helpMenu: HelpMenuState;
}

// 右クリックショートカットヘルプ（既存機能を維持）
export function HelpMenu({ helpMenu }: Props) {
  if (!helpMenu.visible) return null;
  return (
    <div
      className="help-context-menu"
      style={{ top: helpMenu.y, left: helpMenu.x }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="help-header"><MousePointer2 size={14} />ショートカットヘルプ</div>
      <div className="help-grid">
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>O</kbd><span>開く</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名保存</span></div>
        <div className="help-divider" />
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
        <div className="help-divider" />
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F10</kbd><span>追加</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F11</kbd><span>分割</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F12</kbd><span>グループ化</span></div>
        <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd><span>スペース削除</span></div>
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
