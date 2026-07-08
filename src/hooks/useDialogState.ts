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
  // issue #197: 別名で保存ダイアログ表示フラグ
  const [showSaveDialog, setShowSaveDialog] = useState(false);

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
  // Wave4 regression: #72 の修正はタイマー消去のみで、action 付きトーストが
  // action 無しの後続 showToast (自動バックアップ通知等) に setNotification で
  // 置き換えられてしまう問題は残っていた。「別名で保存」等の復旧導線をユーザーが
  // 選ぶ前に消えてしまうと、そのまま失敗を放置される。
  // → 優先度ルールを追加: action 付きトーストは action 無しの後続トーストでは
  //   上書きしない。action 付き同士は後勝ちで置き換える (ユーザー操作待ちの
  //   復旧導線を別の復旧導線で差し替えるのは妥当なため)。
  // 上書きを抑止したメッセージは黙って捨てず console.warn に残す
  // (プロジェクトの eslint no-console 設定は warn/error のみ許可のため)。
  // dismiss 導線: action ボタンは自身のクリックで setNotification(null) された
  // 後に action.onClick() が呼ばれる仕様 (App.tsx 側) のため、既存 UI の範囲で
  // ユーザーは action ボタンから既に dismiss 可能。新規クローズ UI は追加しない。
  const showToast = useCallback((message: string, isError = false, action?: ToastAction) => {
    setNotification(prev => {
      if (prev?.action && !action) {
        console.warn('[toast] suppressed by pending action toast:', message);
        return prev;
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!action) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setNotification(null);
        }, 3000);
      }
      return { message, isError, action };
    });
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
    showSaveDialog,
    setShowSaveDialog,
    showToast,
  };
}
