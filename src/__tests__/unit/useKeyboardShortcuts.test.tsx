import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

function makeActions() {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    handleOpen: vi.fn(),
    fitToScreen: vi.fn(),
    handleSave: vi.fn(),
    handleSaveAs: vi.fn(),
    copySelected: vi.fn(),
    pasteClipboard: vi.fn(),
    handleDelete: vi.fn(),
    toggleDrawingMode: vi.fn(),
    toggleSplitMode: vi.fn(),
    toggleShowOcr: vi.fn(),
    handleGroup: vi.fn(),
    handleRemoveSpaces: vi.fn(),
    setZoom: vi.fn(),
    zoom: 100,
    setIsAutoFit: vi.fn(),
    searchInputRef: { current: null },
  };
}

function press(target: EventTarget, key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => cleanup());

describe('useKeyboardShortcuts: BB操作ショートカット', () => {
  it('Ctrl+B/Ctrl+X/Ctrl+G で追加・分割・グループ化を実行する', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    expect(press(window, 'b').defaultPrevented).toBe(true);
    expect(press(window, 'x').defaultPrevented).toBe(true);
    expect(press(window, 'g').defaultPrevented).toBe(true);

    expect(actions.toggleDrawingMode).toHaveBeenCalledTimes(1);
    expect(actions.toggleSplitMode).toHaveBeenCalledTimes(1);
    expect(actions.handleGroup).toHaveBeenCalledTimes(1);
  });

  it('カード本文へフォーカス移動後も window Ctrl+G でグループ化を実行する', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.className = 'ocr-card-content';
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    expect(press(content, 'g').defaultPrevented).toBe(true);
    expect(actions.handleGroup).toHaveBeenCalledTimes(1);
  });

  it('OCRカード本文以外の contentEditable では Ctrl+G を編集側に渡す', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    expect(press(content, 'g').defaultPrevented).toBe(false);
    expect(actions.handleGroup).not.toHaveBeenCalled();
  });

  it('編集中の Ctrl+X はテキスト編集側に渡す', () => {
    const actions = makeActions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardShortcuts(actions));

    expect(press(input, 'x').defaultPrevented).toBe(false);
    expect(actions.toggleSplitMode).not.toHaveBeenCalled();
  });

  it('OCRカード本文編集中の Ctrl+S は保存を実行する', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.className = 'ocr-card-content';
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    expect(press(content, 's').defaultPrevented).toBe(true);
    expect(actions.handleSave).toHaveBeenCalledTimes(1);
    expect(actions.handleSaveAs).not.toHaveBeenCalled();
  });

  it('Ctrl+F10/Ctrl+F11/Ctrl+F12 では BB 操作を実行しない', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    expect(press(window, 'F10').defaultPrevented).toBe(false);
    expect(press(window, 'F11').defaultPrevented).toBe(false);
    expect(press(window, 'F12').defaultPrevented).toBe(false);

    expect(actions.toggleDrawingMode).not.toHaveBeenCalled();
    expect(actions.toggleSplitMode).not.toHaveBeenCalled();
    expect(actions.handleGroup).not.toHaveBeenCalled();
  });

  it('Ctrl+Q で OCR 表示を切り替える', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    expect(press(window, 'q').defaultPrevented).toBe(true);
    expect(actions.toggleShowOcr).toHaveBeenCalledTimes(1);
  });
});
