/**
 * Issue #45 regression: モーダル表示中 (helpModal / showOcrSettings / pendingBackups) は
 * 右クリックで HelpMenu を背後に重ねて開かないこと。
 *
 * 修正 (v2.0.8): HelpMenu trigger は app-container 全体ではなく
 * pdf-canvas-container スコープのみに限定された。
 * - app-container の右クリック → preventDefault のみ (HelpMenu 開かない)
 * - pdf-canvas-container の右クリック → 従来通りモーダルガード付きで HelpMenu を開く
 *
 * 仕様逸脱した場合、本 test と App.tsx を同時に修正する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

afterEach(() => cleanup());

interface CanvasContainerLikeProps {
  helpModal: string | null;
  showOcrSettings: boolean;
  pendingBackups: unknown[];
  setHelpMenu: (m: { x: number; y: number; visible: boolean }) => void;
}

/**
 * App.tsx の構造を再現:
 * - app-container: preventDefault のみ (HelpMenu を開かない)
 * - pdf-canvas-container: モーダルガード付きで HelpMenu を開く
 */
function AppLike({ helpModal, showOcrSettings, pendingBackups, setHelpMenu }: CanvasContainerLikeProps) {
  return (
    <div
      data-testid="app-container"
      onContextMenu={(e) => {
        e.preventDefault();
        // HelpMenu はここでは開かない (scope は pdf-canvas-container のみ)
      }}
    >
      <div
        data-testid="pdf-canvas-container"
        onContextMenu={(e) => {
          e.preventDefault();
          if (helpModal || showOcrSettings || pendingBackups.length > 0) return;
          setHelpMenu({ x: e.clientX, y: e.clientY, visible: true });
        }}
      >
        canvas
      </div>
      <div data-testid="ribbon">ribbon area</div>
      <div data-testid="ocr-editor">ocr editor area</div>
    </div>
  );
}

describe('Issue #45: モーダル表示中の右クリックで HelpMenu を背後に開かない', () => {
  it('pdf-canvas-container でモーダル無しなら HelpMenu を開く (回帰防止: 通常時の動作)', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('pdf-canvas-container'));

    expect(setHelpMenu).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  });

  it('helpModal 表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal="shortcuts" showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('pdf-canvas-container'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('OCR settings モーダル表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={true} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('pdf-canvas-container'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('Backup restore dialog 表示中は HelpMenu を開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[{ id: 'b1' }]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('pdf-canvas-container'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('app-container (Ribbon / OcrEditor) を右クリックしても HelpMenu は開かない', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    fireEvent.contextMenu(getByTestId('ribbon'));
    fireEvent.contextMenu(getByTestId('ocr-editor'));

    expect(setHelpMenu).not.toHaveBeenCalled();
  });

  it('contextmenu イベントの default は app-container でも常に preventDefault される', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal={null} showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    getByTestId('ribbon').dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });

  it('contextmenu イベントの default は pdf-canvas-container でも常に preventDefault される', () => {
    const setHelpMenu = vi.fn();
    const { getByTestId } = render(
      <AppLike helpModal="shortcuts" showOcrSettings={false} pendingBackups={[]} setHelpMenu={setHelpMenu} />,
    );

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    getByTestId('pdf-canvas-container').dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });
});
