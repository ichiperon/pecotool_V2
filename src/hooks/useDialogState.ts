import { useCallback, useState } from 'react';

export type HelpModalKind = 'shortcuts' | 'usage' | 'version' | null;

export interface HelpMenuState {
  x: number;
  y: number;
  visible: boolean;
}

export interface ToastState {
  message: string;
  isError: boolean;
}

// 各種モーダル・トースト・メニューの state を集約
export function useDialogState() {
  const [notification, setNotification] = useState<ToastState | null>(null);
  const [helpMenu, setHelpMenu] = useState<HelpMenuState>({ x: 0, y: 0, visible: false });
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [helpModal, setHelpModal] = useState<HelpModalKind>(null);
  const [showOcrSettings, setShowOcrSettings] = useState(false);

  const showToast = useCallback((message: string, isError = false) => {
    setNotification({ message, isError });
    setTimeout(() => setNotification(null), 3000);
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
