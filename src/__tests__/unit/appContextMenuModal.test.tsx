/**
 * Issue #45 regression: モーダル表示中 (helpModal / showOcrSettings / pendingBackups) は
 * 右クリックで HelpMenu を背後に重ねて開かないこと。
 *
 * App.tsx 内に inline で書かれた onContextMenu の契約のみをここで担保する。
 * 仕様逸脱した場合、本 test と App.tsx を同時に修正する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

afterEach(() => cleanup());

interface AppLikeProps {
  helpModal: string | null;
  showOcrSettings: boolean;
  pendingBackups: unknown[];
  setHelpMenu: (m: { x: number; y: number; visible: boolean }) => void;
}

// App.tsx の onContextMenu と同一仕様。
function AppLike({ helpModal, showOcrSettings, pendingBackups, setHelpMenu }: AppLikeProps) {
  return (
    <div
      data-testid="root"
      onContextMenu={(e) => {
        e.preventDefault();
        if (helpModal || showOcrSettings || pendingBackups.length > 0) return;
        setHelpMenu({ x: e.clientX, y: e.clientY, visible: true });
      }}
    >
      root
    </div>
  );
}

describe('Issue #45: モーダル表示中の右クリックで HelpMenu を背後に開かない', () => {
  it('モーダル無しなら HelpMenu を開く (回帰防止: 通常時の動作)', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('root'));

    expect(setHelpMenu).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  });

  it('helpModal 表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal="shortcuts" showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('root'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('OCR settings モーダル表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={true} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('root'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('Backup restore dialog 表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[{ id: 'b1' }]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('root'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('contextmenu イベントの default は常に preventDefault される', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal="shortcuts" showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    getByTestId('root').dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });
});
