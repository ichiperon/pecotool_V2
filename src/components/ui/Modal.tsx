import { ReactNode, useEffect, useId, useRef } from 'react';

/**
 * 共通モーダル抽象 (Issue #40).
 *
 * すべてのアプリ内モーダル/ダイアログはこのコンポーネントで包み、
 *   - Esc キーで onClose
 *   - role="dialog" + aria-modal="true" + aria-labelledby
 *   - 開いた瞬間 dialog 本体 (tabIndex=-1) に自動 focus。
 *     data-autofocus 属性付きの要素があればそちらを優先 (Issue #69)。
 *   - Tab/Shift+Tab を内部にトラップ (外の DOM へ遷移しない)
 *   - backdrop クリックで onClose
 * を一律に提供する。
 *
 * 各モーダルは見た目を司る className (modal-backdrop / modal-overlay 等) と
 * 中身を渡すだけで A11y が成立する。
 */

export interface ModalProps {
  /** ダイアログを閉じる要求 (Esc / backdrop クリック / ✕ ボタンから呼ぶ) */
  onClose: () => void;
  /** aria-labelledby に紐づくタイトル要素の表示テキスト。aria 用と視覚 header 兼用するケースで使う */
  titleId?: string;
  /** aria-label として直接渡したい場合 (タイトル要素を別管理する場合) */
  ariaLabel?: string;
  /** backdrop に当てる className (例: "modal-backdrop", "save-dialog-backdrop") */
  backdropClassName: string;
  /** 中央のダイアログ本体に当てる className (例: "modal", "save-dialog") */
  dialogClassName: string;
  /** ダイアログ本体に追加で渡したい style (BackupRestoreDialog 等は inline style に依存) */
  dialogStyle?: React.CSSProperties;
  /** backdrop に追加で渡したい style */
  backdropStyle?: React.CSSProperties;
  /**
   * true の場合、Esc / backdrop クリックでの close を抑止する。
   * Issue #42: バックアップ復元処理中は ✕ も Esc も無視するために使う。
   * onClose 自体は親で disable しても良いが、ここで一段ガードしておく。
   */
  disableClose?: boolean;
  /** disableClose で close 要求が握り潰された時に呼ばれる (Toast 表示などに使う) */
  onCloseSuppressed?: () => void;
  children: ReactNode;
}

/** focusable な要素を列挙するためのセレクタ。Tab トラップで使う。 */
const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  onClose,
  titleId,
  ariaLabel,
  backdropClassName,
  dialogClassName,
  dialogStyle,
  backdropStyle,
  disableClose = false,
  onCloseSuppressed,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // 最新の onClose / disableClose を ref で参照することで、effect の再登録を避ける。
  const onCloseRef = useRef(onClose);
  const onCloseSuppressedRef = useRef(onCloseSuppressed);
  const disableCloseRef = useRef(disableClose);
  useEffect(() => {
    onCloseRef.current = onClose;
    onCloseSuppressedRef.current = onCloseSuppressed;
    disableCloseRef.current = disableClose;
  }, [onClose, onCloseSuppressed, disableClose]);

  // Esc リスナー + Tab トラップ
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Issue #65: IME 変換中の Esc は変換キャンセル用なのでモーダル close へ奪わない。
        // Chromium/WebKit は composing 中に keydown を 229 (e.keyCode) で配送する。
        if (e.isComposing || e.keyCode === 229) return;
        if (disableCloseRef.current) {
          // Issue #42: 処理中の Esc は無視 + 通知だけ通す
          e.preventDefault();
          e.stopPropagation();
          onCloseSuppressedRef.current?.();
          return;
        }
        // Issue #47 互換: 保存中の global ブロッカは Escape を素通りさせるので、
        // ここで preventDefault してから onClose を呼ぶ。
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        // フォーカストラップ: モーダル内 focusable をリストアップして循環させる
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute('inert'));
        if (focusables.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        // dialog 外に focus がある or focus が無い → 先頭/末尾に当てる
        if (!active || !dialog.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // capture: true にして、他の global keydown (例: useKeyboardShortcuts) より先に Esc を捕まえる。
    // Esc を渡してしまうと PDF 編集モード解除等の副作用が走ってしまう。
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // 初期フォーカス (Issue #69) + close 時の focus 復元 (Issue #77):
  //   - mount 時点の document.activeElement を保存 (モーダルを開く直前にユーザが触っていた要素)
  //   - 初期 focus は dialog 本体 (data-autofocus があればそれ)
  //   - unmount 時に保存しておいた要素へ focus を戻す
  // ※ 旧実装は「最初の focusable」を当てていたため、ヘッダ先頭の ✕ 閉じるボタンに
  //   focus が落ちて Enter で即閉じる事故が起きていた。閉じる/キャンセル系は
  //   default focus の対象から外し、明示指定 (data-autofocus) を必要とする。
  useEffect(() => {
    const dialog = dialogRef.current;
    // Issue #77: モーダルを開く直前に focus を持っていた要素を保存し、close 時に戻す。
    //   - document.activeElement が body の場合は復元しない (アンカーが無い)
    //   - 保存後にその要素が DOM から外されているケースもあるので focus() 前に isConnected をチェック
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (dialog) {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog.contains(active)) {
        const explicit = dialog.querySelector<HTMLElement>('[data-autofocus]');
        if (explicit) {
          explicit.focus();
        } else {
          dialog.focus();
        }
      }
    }
    return () => {
      if (
        previouslyFocused &&
        previouslyFocused !== document.body &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === 'function'
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // backdrop 自身がクリックされた場合のみ close (内側クリックは無視)
    if (e.target !== e.currentTarget) return;
    if (disableClose) {
      onCloseSuppressed?.();
      return;
    }
    onClose();
  };

  return (
    <div
      className={backdropClassName}
      style={backdropStyle}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className={dialogClassName}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        // dialog 自身を focusable にしておき、focusable 子要素ゼロのケースで focus 先を担保する
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * モーダル内で一意な title id を払い出す。
 * 各モーダルで `const titleId = useModalTitleId();` のように使い、
 * <h3 id={titleId}> と <Modal titleId={titleId}> を結びつける。
 */
export function useModalTitleId(): string {
  const id = useId();
  return `modal-title-${id}`;
}
