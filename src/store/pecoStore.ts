import { create } from 'zustand';
import { PecoDocument, PageData, Action } from '../types';

interface PecoState {
  document: PecoDocument | null;
  originalBytes: Uint8Array | null;
  thumbnails: Map<number, string>;
  currentPageIndex: number;
  zoom: number;
  isDirty: boolean;
  showOcr: boolean;
  showTextPreview: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  selectedIds: Set<string>;
  undoStack: Action[];
  redoStack: Action[];

  // Actions
  setDocument: (doc: PecoDocument | null, bytes?: Uint8Array) => void;
  setThumbnail: (pageIndex: number, dataUrl: string) => void;
  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  toggleShowOcr: () => void;
  toggleTextPreview: () => void;
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
  updatePageData: (pageIndex: number, data: Partial<PageData>, undoable?: boolean) => void;

  toggleSelection: (id: string, multi: boolean) => void;
  clearSelection: () => void;
  pushAction: (action: Action) => void;
  undo: () => void;
  redo: () => void;
}

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
  originalBytes: null,
  thumbnails: new Map(),
  currentPageIndex: 0,
  zoom: 100,
  isDirty: false,
  showOcr: true,
  showTextPreview: false,
  isDrawingMode: false,
  isSplitMode: false,
  selectedIds: new Set(),
  undoStack: [],
  redoStack: [],

  setDocument: (doc, bytes) => set({
    document: doc,
    originalBytes: bytes || null,
    thumbnails: new Map(),
    currentPageIndex: 0,
    isDirty: false,
    showOcr: true,
    showTextPreview: false,
    isDrawingMode: false,
    isSplitMode: false,
    selectedIds: new Set(),
    undoStack: [],
    redoStack: []
  }),

  setThumbnail: (pageIndex, dataUrl) => set((state) => {
    const newThumbnails = new Map(state.thumbnails);
    newThumbnails.set(pageIndex, dataUrl);
    return { thumbnails: newThumbnails };
  }),

  setCurrentPage: (index) => set({ currentPageIndex: index, selectedIds: new Set() }),

  setZoom: (zoom) => set({ zoom }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({ isDrawingMode: !state.isDrawingMode, isSplitMode: false })),
  
  toggleSplitMode: () => set((state) => ({ isSplitMode: !state.isSplitMode, isDrawingMode: false })),

  updatePageData: (pageIndex, data, undoable = true) => set((state) => {
    if (!state.document) return state;
    const oldPage = state.document.pages.get(pageIndex);
    const newPage = oldPage ? { ...oldPage, ...data } : (data as PageData);
    const newPages = new Map(state.document.pages);
    newPages.set(pageIndex, newPage);

    const newState: any = {
      document: { ...state.document, pages: newPages },
      isDirty: true
    };

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
