import { useEffect } from 'react';

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
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) actions.redo();
        else actions.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        actions.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        actions.fitToScreen(false);
      }
    };
    const handleWheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) {
        e.preventDefault();
        actions.setIsAutoFit(false);
        const zoomStep = 10;
        const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
        const newZoom = Math.max(25, Math.min(500, actions.zoom + delta));
        actions.setZoom(newZoom);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [actions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key === 'o' && !isEditing) {
        e.preventDefault();
        actions.handleOpen();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (e.shiftKey) actions.handleSaveAs();
        else actions.handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing) {
        actions.copySelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditing) {
        actions.pasteClipboard();
      } else if (e.key === 'Delete' && !isEditing) {
        actions.handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space' && !isEditing) {
        e.preventDefault();
        actions.handleRemoveSpaces();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        window.document.querySelector<HTMLInputElement>('.search-box')?.focus();
      } else if (e.key === 'F10' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.toggleDrawingMode();
      } else if (e.key === 'F11' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.toggleSplitMode();
      } else if (e.key === 'F12' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.handleGroup();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [actions]);
}
