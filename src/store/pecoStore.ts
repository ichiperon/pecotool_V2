import { create } from 'zustand';
import { PecoDocument, PageData, Action } from '../types';

interface PecoState {
  document: PecoDocument | null;
  originalBytes: Uint8Array | null;
  thumbnails: Map<number, string>; // Blob URL
  pageAccessOrder: number[]; // For LRU
  currentPageIndex: number;
  zoom: number;
  isDirty: boolean;
  showOcr: boolean;
  ocrOpacity: number;
  showTextPreview: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  selectedIds: Set<string>;
  clipboard: TextBlock[];
  undoStack: Action[];
  redoStack: Action[];

  // Actions
  setDocument: (doc: PecoDocument | null, bytes?: Uint8Array) => void;
  setThumbnail: (pageIndex: number, blobUrl: string) => void;
  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  toggleShowOcr: () => void;
  setOcrOpacity: (opacity: number) => void;
  toggleTextPreview: () => void;
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
  updatePageData: (pageIndex: number, data: Partial<PageData>, undoable?: boolean) => void;
  resetDirty: () => void;

  toggleSelection: (id: string, multi: boolean) => void;
  clearSelection: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  pushAction: (action: Action) => void;
  undo: () => void;
  redo: () => void;
}

const MAX_CACHED_PAGES = 30;

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
  originalBytes: null,
  thumbnails: new Map(),
  pageAccessOrder: [],
  currentPageIndex: 0,
  zoom: 100,
  isDirty: false,
  showOcr: true,
  ocrOpacity: 0.4,
  showTextPreview: false,
  isDrawingMode: false,
  isSplitMode: false,
  selectedIds: new Set(),
  clipboard: [],
  undoStack: [],
  redoStack: [],

  setDocument: (doc, bytes) => set((state) => {
    // Revoke all existing thumbnail URLs to free memory
    state.thumbnails.forEach(url => URL.revokeObjectURL(url));

    return {
      document: doc,
      originalBytes: bytes || null, // No slice to avoid duplication in memory
      thumbnails: new Map(),
      pageAccessOrder: [],
      currentPageIndex: 0,
      isDirty: false,
      showOcr: true,
      showTextPreview: false,
      isDrawingMode: false,
      isSplitMode: false,
      selectedIds: new Set(),
      clipboard: [],
      undoStack: [],
      redoStack: []
    };
  }),

  setThumbnail: (pageIndex, blobUrl) => set((state) => {
    const newThumbnails = new Map(state.thumbnails);
    // If we already have a thumbnail for this page, revoke the old one
    const oldUrl = newThumbnails.get(pageIndex);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    
    newThumbnails.set(pageIndex, blobUrl);
    return { thumbnails: newThumbnails };
  }),

  setCurrentPage: (index) => set((state) => {
    const newOrder = [index, ...state.pageAccessOrder.filter(i => i !== index)];
    return { currentPageIndex: index, selectedIds: new Set(), pageAccessOrder: newOrder };
  }),

  setZoom: (zoom) => set({ zoom }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  setOcrOpacity: (opacity) => set({ ocrOpacity: opacity }),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({ isDrawingMode: !state.isDrawingMode, isSplitMode: false })),
  
  toggleSplitMode: () => set((state) => ({ isSplitMode: !state.isSplitMode, isDrawingMode: false })),

  updatePageData: (pageIndex, data, undoable = true) => set((state) => {
    if (!state.document) return state;
    const oldPage = state.document.pages.get(pageIndex);
    const newPage = oldPage ? { ...oldPage, ...data } : (data as PageData);
    const newPages = new Map(state.document.pages);
    newPages.set(pageIndex, newPage);

    // Update access order
    const newOrder = [pageIndex, ...state.pageAccessOrder.filter(i => i !== pageIndex)];

    // LRU Purge: If we exceed MAX_CACHED_PAGES, remove the oldest non-dirty page
    if (newPages.size > MAX_CACHED_PAGES) {
      for (let i = newOrder.length - 1; i >= 0; i--) {
        const idxToRemove = newOrder[i];
        const pageToRemove = newPages.get(idxToRemove);
        // Never purge the current page, and never purge dirty pages (unsaved changes)
        if (idxToRemove !== state.currentPageIndex && pageToRemove && !pageToRemove.isDirty) {
          newPages.delete(idxToRemove);
          newOrder.splice(i, 1);
          if (newPages.size <= MAX_CACHED_PAGES) break;
        }
      }
    }

    const newState: any = {
      document: { ...state.document, pages: newPages },
      pageAccessOrder: newOrder,
    };

    if (data.isDirty !== false) {
      newState.isDirty = true;
    }

    if (undoable && oldPage) {
      const action: Action = {
        type: 'update_page',
        pageIndex,
        before: oldPage,
        after: newPage
      };
      const newUndo = [...state.undoStack, action];
      if (newUndo.length > 100) newUndo.shift();
      newState.undoStack = newUndo;
      newState.redoStack = [];
    }

    return newState;
  }),

  resetDirty: () => set((state) => {
    if (!state.document) return state;
    const newPages = new Map(state.document.pages);
    for (const [idx, page] of newPages.entries()) {
      if (page.isDirty) {
        newPages.set(idx, { ...page, isDirty: false });
      }
    }
    return {
      document: { ...state.document, pages: newPages },
      isDirty: false
    };
  }),

  toggleSelection: (id, multi) => set((state) => {
    const newSelection = new Set(multi ? state.selectedIds : []);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    return { selectedIds: newSelection };
  }),

  clearSelection: () => set({ selectedIds: new Set() }),

  copySelected: () => {
    const { document, currentPageIndex, selectedIds } = get();
    if (!document || selectedIds.size === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    const selected = page.textBlocks.filter(b => selectedIds.has(b.id));
    set({ clipboard: selected.map(b => ({ ...b })) });
  },

  pasteClipboard: () => {
    const { document, currentPageIndex, clipboard, updatePageData } = get();
    if (!document || clipboard.length === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;

    const newBlocks = [...page.textBlocks];
    const pastedIds = new Set<string>();

    clipboard.forEach((b, i) => {
      const newId = crypto.randomUUID();
      const newBlock: TextBlock = {
        ...b,
        id: newId,
        // Slightly offset pasted blocks
        bbox: { ...b.bbox, x: b.bbox.x + 10, y: b.bbox.y + 10 },
        order: newBlocks.length,
        isNew: true,
        isDirty: true
      };
      newBlocks.push(newBlock);
      pastedIds.add(newId);
    });

    updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    set({ selectedIds: pastedIds });
  },

  pushAction: (action) => set((state) => {
    const newUndo = [...state.undoStack, action];
    if (newUndo.length > 100) newUndo.shift();
    return {
      undoStack: newUndo,
      redoStack: []
    };
  }),

  undo: () => {
    const { undoStack, redoStack, document } = get();
    if (undoStack.length === 0 || !document) return;

    const action = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    const newRedo = [action, ...redoStack];

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      newPages.set(action.pageIndex, action.before);
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
    }
  },

  redo: () => {
    const { undoStack, redoStack, document } = get();
    if (redoStack.length === 0 || !document) return;

    const action = redoStack[0];
    const newRedo = redoStack.slice(1);
    const newUndo = [...undoStack, action];

    if (action.type === 'update_page') {
      const newPages = new Map(document.pages);
      newPages.set(action.pageIndex, action.after);
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
    }
  }
}));
