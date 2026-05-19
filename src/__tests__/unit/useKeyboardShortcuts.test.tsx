import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

function makeActions(overrides: Partial<{ isOcrRunning: boolean; openReplace: () => void }> = {}) {
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
    handleGroup: vi.fn(),
    handleRemoveSpaces: vi.fn(),
    setZoom: vi.fn(),
    zoom: 100,
    setIsAutoFit: vi.fn(),
    searchInputRef: { current: null },
    openReplace: vi.fn(),
    isOcrRunning: false,
    ...overrides,
  };
}

function press(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
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
});

describe('useKeyboardShortcuts: Undo/Redo の編集中ガード', () => {
  it('contentEditable 内で Ctrl+Z 押下時にアプリ undo が呼ばれない', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    press(content, 'z');
    expect(actions.undo).not.toHaveBeenCalled();
  });

  it('contentEditable 内で Ctrl+Y / Ctrl+Shift+Z 押下時にアプリ redo が呼ばれない', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    press(content, 'y');
    press(content, 'z', { shiftKey: true });
    expect(actions.redo).not.toHaveBeenCalled();
  });

  it('INPUT/TEXTAREA 内で Ctrl+Z/Ctrl+Y 押下時にアプリ undo/redo が呼ばれない', () => {
    const actions = makeActions();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    document.body.appendChild(input);
    document.body.appendChild(textarea);
    renderHook(() => useKeyboardShortcuts(actions));

    press(input, 'z');
    press(textarea, 'y');
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.redo).not.toHaveBeenCalled();
  });

  it('編集中でない場合は Ctrl+Z/Ctrl+Y でアプリ undo/redo が呼ばれる', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'z');
    press(window, 'y');
    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.redo).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: OCR 実行中ガード (issue #102 / #103)', () => {
  it('#102: isOcrRunning=true なら Ctrl+O で handleOpen が呼ばれない', () => {
    const actions = makeActions({ isOcrRunning: true });
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, 'o');

    // preventDefault は通っているが handleOpen は呼ばれない
    expect(event.defaultPrevented).toBe(true);
    expect(actions.handleOpen).not.toHaveBeenCalled();
  });

  it('#102: isOcrRunning=false なら Ctrl+O で handleOpen が通常通り呼ばれる', () => {
    const actions = makeActions({ isOcrRunning: false });
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'o');

    expect(actions.handleOpen).toHaveBeenCalledTimes(1);
  });

  it('#103: isOcrRunning=true なら Ctrl+H で openReplace が呼ばれない', () => {
    const openReplace = vi.fn();
    const actions = makeActions({ isOcrRunning: true, openReplace });
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, 'h');

    expect(event.defaultPrevented).toBe(true);
    expect(openReplace).not.toHaveBeenCalled();
  });

  it('#103: isOcrRunning=false なら Ctrl+H で openReplace が呼ばれる', () => {
    const openReplace = vi.fn();
    const actions = makeActions({ isOcrRunning: false, openReplace });
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'h');

    expect(openReplace).toHaveBeenCalledTimes(1);
  });
});
