/**
 * Issue #40 / #42 regression: 共通 Modal の A11y / Esc / フォーカス / 処理中ガード。
 *
 * Modal 抽象自体の契約を担保する。各実モーダル (HelpModal, OcrSettingsModal,
 * SaveDialog, BackupRestoreDialog) は別ファイルで一行 smoke を持つ。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { Modal, useModalTitleId } from '../../components/ui/Modal';

afterEach(() => cleanup());

function Harness({
  onClose,
  disableClose = false,
  onCloseSuppressed,
  withButtons = true,
}: {
  onClose: () => void;
  disableClose?: boolean;
  onCloseSuppressed?: () => void;
  withButtons?: boolean;
}) {
  const titleId = useModalTitleId();
  return (
    <Modal
      onClose={onClose}
      titleId={titleId}
      disableClose={disableClose}
      onCloseSuppressed={onCloseSuppressed}
      backdropClassName="test-backdrop"
      dialogClassName="test-dialog"
    >
      <h2 id={titleId}>テストタイトル</h2>
      {withButtons && (
        <>
          <button data-testid="first">first</button>
          <button data-testid="middle">middle</button>
          <button data-testid="last">last</button>
        </>
      )}
    </Modal>
  );
}

describe('Modal (Issue #40): A11y 属性とフォーカス', () => {
  it('role="dialog" + aria-modal="true" が付く', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('aria-labelledby が title 要素を指し、id 一致でアクセス可能名が取れる', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.textContent).toBe('テストタイトル');
    // role 名前計算経由でも取得できる
    expect(screen.getByRole('dialog', { name: 'テストタイトル' })).toBeTruthy();
  });

  // Issue #69 regression: 旧実装は「最初の focusable (=多くの場合 ✕ 閉じるボタン)」に
  // 自動 focus していたため、モーダルを開いた直後の Enter で即閉じる事故があった。
  // 新しい契約は「default focus は dialog 本体に当てる。明示が必要なら data-autofocus」。
  it('初期 focus は dialog 本体に当たる (data-autofocus 指定が無い場合)', () => {
    render(<Harness onClose={() => {}} />);
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  });

  it('focusable 要素が無くても dialog 自体に focus する', () => {
    render(<Harness onClose={() => {}} withButtons={false} />);
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  });

  it('data-autofocus が付いた要素があれば、そこに focus する (Issue #69)', () => {
    function HarnessWithAutoFocus() {
      const titleId = useModalTitleId();
      return (
        <Modal
          onClose={() => {}}
          titleId={titleId}
          backdropClassName="test-backdrop"
          dialogClassName="test-dialog"
        >
          <h2 id={titleId}>タイトル</h2>
          <button data-testid="close" className="modal-close">✕</button>
          <button data-testid="primary" data-autofocus>OK</button>
          <button data-testid="other">other</button>
        </Modal>
      );
    }
    render(<HarnessWithAutoFocus />);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('primary');
  });

  it('閉じるボタン (modal-close) には default focus が当たらない (Issue #69)', () => {
    // 実モーダル (HelpModal, OcrSettingsModal) と同じ構造: ヘッダー先頭に閉じるボタン。
    function HarnessWithCloseFirst() {
      const titleId = useModalTitleId();
      return (
        <Modal
          onClose={() => {}}
          titleId={titleId}
          backdropClassName="test-backdrop"
          dialogClassName="test-dialog"
        >
          <h2 id={titleId}>タイトル</h2>
          <button data-testid="close" className="modal-close" aria-label="閉じる">✕</button>
          <button data-testid="body">body</button>
        </Modal>
      );
    }
    render(<HarnessWithCloseFirst />);
    // 旧実装ではここで data-testid="close" になっており、
    // Enter で即 onClose() が呼ばれていた。
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('close');
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  });
});

describe('Modal (Issue #40): Esc / backdrop で onClose', () => {
  it('Esc 押下で onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc は preventDefault される (downstream listener には届かない方が安全)', () => {
    render(<Harness onClose={() => {}} />);
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('Esc 以外のキーは onClose を呼ばない', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('backdrop クリックで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    const { container } = render(<Harness onClose={onClose} />);
    const backdrop = container.querySelector('.test-backdrop') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dialog 内クリックは backdrop に伝播せず onClose を呼ばない', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('unmount で keydown リスナーが解除される', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Modal (Issue #40): フォーカストラップ', () => {
  it('Tab で最後の要素 → 先頭にラップする', () => {
    render(<Harness onClose={() => {}} />);
    const last = screen.getByTestId('last');
    last.focus();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('last');
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');
  });

  it('Shift+Tab で先頭 → 最後にラップする', () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByTestId('first');
    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('last');
  });

  it('focus がモーダル外にある場合、Tab で内側に引き戻す', () => {
    // モーダル外のボタンを作って focus を奪う
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    render(<Harness onClose={() => {}} />);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');
    document.body.removeChild(outside);
  });
});

describe('Modal (Issue #42): disableClose=true で close を抑止する', () => {
  it('Esc で onClose を呼ばず、onCloseSuppressed を呼ぶ', () => {
    const onClose = vi.fn();
    const onCloseSuppressed = vi.fn();
    render(
      <Harness onClose={onClose} disableClose onCloseSuppressed={onCloseSuppressed} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('backdrop クリックで onClose を呼ばず、onCloseSuppressed を呼ぶ', () => {
    const onClose = vi.fn();
    const onCloseSuppressed = vi.fn();
    const { container } = render(
      <Harness onClose={onClose} disableClose onCloseSuppressed={onCloseSuppressed} />,
    );
    const backdrop = container.querySelector('.test-backdrop') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('disableClose を後から有効化すると、それ以降の Esc は無視される', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} />);
    // 最初は close できる
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Harness onClose={onClose} disableClose />);
    fireEvent.keyDown(window, { key: 'Escape' });
    // 増えない
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
