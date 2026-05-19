import { useCallback, useEffect, useRef, useState } from 'react';

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
  // issue #93: Find & Replace ダイアログ表示フラグ
  const [showReplace, setShowReplace] = useState(false);

  // action 付きトーストはユーザー操作待ちのため、自動消滅させずに表示し続ける。
  // 保存失敗フォールバック (issue #53) のように「別名で保存」ボタンを押されるまで
  // 残しておきたいケースに使う。
  //
  // Issue #72 regression: showToast を立て続けに呼ぶと、直前トーストが張った
  // 3 秒タイマーが新しい action 付きトーストまで消してしまっていた。
  // → 毎回 clearTimeout してから新しいタイマーを張り直す。action 付きの場合は
  //   タイマーを張らないため、後続トーストで消されない (#53 のセマンティクスを維持)。
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
  const showToast = useCallback((message: string, isError = false, action?: ToastAction) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNotification({ message, isError, action });
    if (!action) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setNotification(null);
      }, 3000);
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
    showReplace,
    setShowReplace,
    showToast,
  };
}
