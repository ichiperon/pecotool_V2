import { useEffect, useRef } from 'react';

interface ShortcutActions {
  undo: () => void;
  redo: () => void;
  handleOpen: () => void;
  fitToScreen: (keep?: boolean) => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  handleDelete: () => void;
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
  handleGroup: () => void;
  handleRemoveSpaces: () => void;
  setZoom: (zoom: number) => void;
  zoom: number;
  setIsAutoFit: (val: boolean) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** issue #93: Ctrl+H で Find & Replace ダイアログを開く。配線されない環境では undefined */
  openReplace?: () => void;
  /**
   * #102/#103: OCR 実行中フラグ。Ctrl+O / Ctrl+H 発火前にチェックし、
   * 走っている場合はアクションを no-op にする (handleOpen / openReplace は
   * 内部でもガードしているが、ここで preventDefault も含めて止める方が
   * 編集領域へのキー伝播を確実に防げる)。
   */
  isOcrRunning?: boolean;
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  // actions プロパティ object は App.tsx 側で毎レンダー新規生成されるため、
  // 依存配列に actions を入れると毎レンダー remove/addEventListener が走り
  // GC 圧の温床になる。ref に最新参照を保持して依存配列を空にする。
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ac = actionsRef.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      const isFormEditing = tag === 'INPUT' || tag === 'TEXTAREA';
      const isContentEditing = !!target?.isContentEditable || !!target?.closest('[contenteditable="true"]');
      const isEditing = isFormEditing || isContentEditing;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !isEditing) {
        if (e.shiftKey) ac.redo();
        else ac.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y' && !isEditing) {
        ac.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        ac.fitToScreen(false);
      }
    };
    const handleWheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) {
        // issue #51: IME 変換候補スクロール中の Ctrl 押下や検索ボックスでのホイール操作で
        // ページがズームしないよう、編集対象 / 検索ボックスは preventDefault も発火させない。
        const target = e.target instanceof HTMLElement ? e.target : null;
        const tag = target?.tagName;
        const isFormEditing = tag === 'INPUT' || tag === 'TEXTAREA';
        const isContentEditing = !!target?.isContentEditable || !!target?.closest('[contenteditable="true"]');
        const isSearchBox = !!target?.closest('.search-box');
        if (isFormEditing || isContentEditing || isSearchBox) return;
        e.preventDefault();
        const ac = actionsRef.current;
        ac.setIsAutoFit(false);
        const zoomStep = 10;
        const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
        const newZoom = Math.max(25, Math.min(500, ac.zoom + delta));
        ac.setZoom(newZoom);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ac = actionsRef.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      const isFormEditing = tag === 'INPUT' || tag === 'TEXTAREA';
      const isContentEditing = !!target?.isContentEditable || !!target?.closest('[contenteditable="true"]');
      const isOcrCardContent = !!target?.closest('.ocr-card-content');
      const isEditing = isFormEditing || isContentEditing;
      if ((e.ctrlKey || e.metaKey) && e.key === 'o' && !isEditing) {
        e.preventDefault();
        // #102: OCR 実行中の Ctrl+O は no-op (handleOpen 内のガード trustが Toast を出す経路は
        // useFileOperations 側だが、ここで preventDefault しておくことで編集領域への伝播を防ぐ)
        if (ac.isOcrRunning) return;
        ac.handleOpen();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (e.shiftKey) ac.handleSaveAs();
        else ac.handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing) {
        ac.copySelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditing) {
        ac.pasteClipboard();
      } else if (e.key === 'Delete' && !isEditing) {
        ac.handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space' && !isEditing) {
        e.preventDefault();
        ac.handleRemoveSpaces();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        window.document.querySelector<HTMLInputElement>('.search-box')?.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'h' && !isEditing) {
        // issue #93: Ctrl+H で Find & Replace ダイアログ。編集中は素通り (ブラウザ既定の履歴等は出ないが contentEditable では IME 等の衝突を避ける)。
        // #103: OCR 実行中はそもそも Replace を開かない (置換結果が OCR で後追い上書きされる)。
        e.preventDefault();
        if (ac.isOcrRunning) return;
        ac.openReplace?.();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'b' && !isEditing) {
        e.preventDefault();
        ac.toggleDrawingMode();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'x' && !isEditing) {
        e.preventDefault();
        ac.toggleSplitMode();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'g' && !isFormEditing && (!isContentEditing || isOcrCardContent)) {
        e.preventDefault();
        ac.handleGroup();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
