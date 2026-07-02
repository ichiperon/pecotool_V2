import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

function makeActions(
  overrides: Partial<{
    isOcrRunning: boolean;
    openReplace: () => void;
    isCurveMode: boolean;
    isSplitMode: boolean;
  }> = {},
) {
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
    openReplace: vi.fn(),
    isOcrRunning: false,
    isCurveMode: false,
    isSplitMode: false,
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

describe('useKeyboardShortcuts: fit 表示ショートカット', () => {
  it("Ctrl+0 key='0' で fitToScreen(false) を実行する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, '0');

    expect(event.defaultPrevented).toBe(true);
    expect(actions.fitToScreen).toHaveBeenCalledWith(false);
    expect(actions.fitToScreen).toHaveBeenCalledTimes(1);
  });

  it.each(['Dead', ')'])("Ctrl+0 key='%s' でも code='Digit0' なら fitToScreen(false) を実行する", (key) => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, key, { code: 'Digit0' });

    expect(event.defaultPrevented).toBe(true);
    expect(actions.fitToScreen).toHaveBeenCalledWith(false);
    expect(actions.fitToScreen).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Numpad0 code='Numpad0' で fitToScreen(false) を実行する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, 'Insert', { code: 'Numpad0' });

    expect(event.defaultPrevented).toBe(true);
    expect(actions.fitToScreen).toHaveBeenCalledWith(false);
    expect(actions.fitToScreen).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: Ctrl+0 isEditing ガード (PCT-095)', () => {
  it('contentEditable フォーカス中の Ctrl+0 は fitToScreen を呼ばない', () => {
    const actions = makeActions();
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();

    // contentEditable フォーカス中は isEditing=true → Ctrl+0 がスルーされる
    press(content, '0');
    expect(actions.fitToScreen).not.toHaveBeenCalled();
  });

  it('OCR カード (contenteditable=true) フォーカス中の Ctrl+0 は fitToScreen を呼ばない', () => {
    const actions = makeActions();
    const card = document.createElement('div');
    card.className = 'ocr-card-content';
    card.setAttribute('contenteditable', 'true');
    document.body.appendChild(card);
    renderHook(() => useKeyboardShortcuts(actions));

    card.focus();

    press(card, '0');
    expect(actions.fitToScreen).not.toHaveBeenCalled();
  });

  it('INPUT フォーカス中の Ctrl+0 は fitToScreen を呼ばない', () => {
    const actions = makeActions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardShortcuts(actions));

    press(input, '0');
    expect(actions.fitToScreen).not.toHaveBeenCalled();
  });

  it('編集中でない場合の Ctrl+0 は fitToScreen(false) を呼ぶ（既存動作の維持確認）', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, '0');
    expect(event.defaultPrevented).toBe(true);
    expect(actions.fitToScreen).toHaveBeenCalledWith(false);
    expect(actions.fitToScreen).toHaveBeenCalledTimes(1);
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

describe('useKeyboardShortcuts: 大文字 key 正規化 (PCT-170)', () => {
  // CapsLock ON や Shift 併用時、e.key は 'Z' 等の大文字になる。
  // 生比較 (e.key === 'z') だとショートカット全滅するため toLowerCase() 統一の回帰を縛る。

  it("CapsLock 相当: key='Z' + Ctrl で undo が発火する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'Z');

    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.redo).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Z (key='Z', shiftKey=true) で redo が発火する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'Z', { shiftKey: true });

    expect(actions.redo).toHaveBeenCalledTimes(1);
    expect(actions.undo).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+S (key='S', shiftKey=true) で handleSaveAs が発火する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    const event = press(window, 'S', { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(actions.handleSaveAs).toHaveBeenCalledTimes(1);
    expect(actions.handleSave).not.toHaveBeenCalled();
  });

  it("CapsLock 相当: 大文字 key で他のショートカット (Y/O/B/X/G) も発火する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'Y');
    press(window, 'O');
    press(window, 'B');
    press(window, 'X');
    press(window, 'G');

    expect(actions.redo).toHaveBeenCalledTimes(1);
    expect(actions.handleOpen).toHaveBeenCalledTimes(1);
    expect(actions.toggleDrawingMode).toHaveBeenCalledTimes(1);
    expect(actions.toggleSplitMode).toHaveBeenCalledTimes(1);
    expect(actions.handleGroup).toHaveBeenCalledTimes(1);
  });

  it("非退行: 小文字 key='z' + Ctrl で undo が発火する", () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'z');

    expect(actions.undo).toHaveBeenCalledTimes(1);
  });

  it("非退行: INPUT フォーカス中は大文字 key='Z' でも undo が呼ばれない (isEditing ガード維持)", () => {
    const actions = makeActions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardShortcuts(actions));

    press(input, 'Z');

    expect(actions.undo).not.toHaveBeenCalled();
  });

  // レビュー対応 (PCT-170): Shift 併用を意図しない分岐は !e.shiftKey でガードし、
  // Ctrl+Shift+C (WebView2 DevTools 要素選択) 等との二重発火・意図せぬ alias 化を防ぐ。
  it('Shift ガード: Ctrl+Shift+C / Ctrl+Shift+V は copy/paste を発火しない', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'C', { shiftKey: true });
    press(window, 'V', { shiftKey: true });

    expect(actions.copySelected).not.toHaveBeenCalled();
    expect(actions.pasteClipboard).not.toHaveBeenCalled();
  });

  it('Shift ガード: Ctrl+Shift+{Y,O,B,X,G} も発火しない (意図せぬ alias 防止)', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'Y', { shiftKey: true });
    press(window, 'O', { shiftKey: true });
    press(window, 'B', { shiftKey: true });
    press(window, 'X', { shiftKey: true });
    press(window, 'G', { shiftKey: true });

    expect(actions.redo).not.toHaveBeenCalled();
    expect(actions.handleOpen).not.toHaveBeenCalled();
    expect(actions.toggleDrawingMode).not.toHaveBeenCalled();
    expect(actions.toggleSplitMode).not.toHaveBeenCalled();
    expect(actions.handleGroup).not.toHaveBeenCalled();
  });

  it('非退行: Shift なしの Ctrl+C は copySelected を発火する', () => {
    const actions = makeActions();
    renderHook(() => useKeyboardShortcuts(actions));

    press(window, 'c');

    expect(actions.copySelected).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: Esc split mode 解除 (issue #292)', () => {
  function pressEsc(target: EventTarget = window) {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('#292: isSplitMode=true のとき Esc で toggleSplitMode が呼ばれる', () => {
    const actions = makeActions({ isSplitMode: true });
    renderHook(() => useKeyboardShortcuts(actions));

    const event = pressEsc();

    expect(event.defaultPrevented).toBe(true);
    expect(actions.toggleSplitMode).toHaveBeenCalledTimes(1);
  });

  it('#292: isSplitMode=false のとき Esc で toggleSplitMode は呼ばれない', () => {
    const actions = makeActions({ isSplitMode: false });
    renderHook(() => useKeyboardShortcuts(actions));

    pressEsc();

    expect(actions.toggleSplitMode).not.toHaveBeenCalled();
  });

  it('#292: isEditing 中 (contentEditable focus) は Esc が split mode に効かない', () => {
    const actions = makeActions({ isSplitMode: true });
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'true');
    document.body.appendChild(content);
    renderHook(() => useKeyboardShortcuts(actions));

    content.focus();
    pressEsc(content);

    expect(actions.toggleSplitMode).not.toHaveBeenCalled();
  });
});
