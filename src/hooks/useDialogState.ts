import { useCallback, useState } from 'react';

export type HelpModalKind = 'shortcuts' | 'usage' | 'version' | null;

export interface HelpMenuState {
  x: number;
  y: number;
  visible: boolean;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  isError: boolean;
  action?: ToastAction;
}

// 各種モーダル・トースト・メニューの state を集約
export function useDialogState() {
  const [notification, setNotification] = useState<ToastState | null>(null);
  const [helpMenu, setHelpMenu] = useState<HelpMenuState>({ x: 0, y: 0, visible: false });
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [helpModal, setHelpModal] = useState<HelpModalKind>(null);
  const [showOcrSettings, setShowOcrSettings] = useState(false);

  // action 付きトーストはユーザー操作待ちのため、自動消滅させずに表示し続ける。
  // 保存失敗フォールバック (issue #53) のように「別名で保存」ボタンを押されるまで
  // 残しておきたいケースに使う。
  const showToast = useCallback((message: string, isError = false, action?: ToastAction) => {
    setNotification({ message, isError, action });
    if (!action) {
      setTimeout(() => setNotification(null), 3000);
    }
  }, []);

  return {
    notification,
    setNotification,
    helpMenu,
    setHelpMenu,
    showSettingsDropdown,
    setShowSettingsDropdown,
    helpModal,
    setHelpModal,
    showOcrSettings,
    setShowOcrSettings,
    showToast,
  };
}
