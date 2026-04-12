import { create } from 'zustand';
import { PecoDocument, PageData, Action, TextBlock } from '../types';
import { saveTemporaryPageDataBatch, clearTemporaryChanges } from '../utils/pdfLoader';

// 進行中のLRU退避IDB書き込みPromiseを追跡する。
// 保存処理はこれらが完了してからIDBを読み込む必要がある。
const pendingIdbSaves: Set<Promise<void>> = new Set();

/** 全てのLRU退避IDB書き込みが完了するまで待機する */
export function waitForPendingIdbSaves(): Promise<void> {
  if (pendingIdbSaves.size === 0) return Promise.resolve();
  return Promise.all(Array.from(pendingIdbSaves)).then(() => {});
}

interface PecoState {
  document: PecoDocument | null;
  originalBytes: Uint8Array | null;
  pageAccessOrder: number[]; // For page data LRU (1000ページ対応)
  currentPageIndex: number;
  zoom: number;
  isDirty: boolean;
  showOcr: boolean;
  ocrOpacity: number;
  showTextPreview: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  clipboard: TextBlock[];
  undoStack: Action[];
  redoStack: Action[];
  fontBytes: ArrayBuffer | null;
  isFontLoaded: boolean;
  /** 復元待ちのバックアップページデータ。setDocument 内で IDB への書き込みに使われる。 */
  pendingRestoration: Record<string, Partial<PageData>> | null;

  // Actions
  setFontBytes: (bytes: ArrayBuffer) => void;
  setFontLoaded: (loaded: boolean) => void;
  setPendingRestoration: (pages: Record<string, Partial<PageData>> | null) => void;
  setDocument: (doc: PecoDocument | null, bytes?: Uint8Array) => void;
  setOriginalBytes: (bytes: Uint8Array) => void;
  setDocumentFilePath: (filePath: string) => void;
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
  setSelectedIds: (ids: string[]) => void;
  clearSelection: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  pushAction: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  clearOcrCurrentPage: () => void;
  clearOcrAllPages: () => void;
}

const MAX_CACHED_PAGES = 50;

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
  originalBytes: null,
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
  lastSelectedId: null,
  clipboard: [],
  undoStack: [],
  redoStack: [],
  fontBytes: null,
  isFontLoaded: false,
  pendingRestoration: null,

  setFontBytes: (bytes) => set({ fontBytes: bytes, isFontLoaded: true }),
  setFontLoaded: (loaded) => set({ isFontLoaded: loaded }),
  setPendingRestoration: (pages) => set({ pendingRestoration: pages }),
  setOriginalBytes: (bytes) => set({ originalBytes: bytes }),
  setDocumentFilePath: (filePath) => set((state) => {
    if (!state.document) return state;
    const fileName = filePath.split(/[\\/]/).pop() || state.document.fileName;
    return { document: { ...state.document, filePath, fileName } };
  }),

  setDocument: (doc, bytes) => {
    // pendingRestoration を取り出してから state をリセットする
    const restoration = get().pendingRestoration;

    set({
      document: doc,
      originalBytes: bytes || null,
      pageAccessOrder: [],
      currentPageIndex: 0,
      // バックアップ復元時は即座に isDirty=true にしておく
      isDirty: restoration !== null && doc !== null,
      showOcr: true,
      showTextPreview: false,
      isDrawingMode: false,
      isSplitMode: false,
      selectedIds: new Set(),
      lastSelectedId: null,
      clipboard: [],
      undoStack: [],
      redoStack: [],
      pendingRestoration: null,
    });

    // IDB一時データのクリアをset()外でawaitして確実に完了させる。
    // 復元データがある場合はクリア完了後に IDB へ書き込む（順序保証）。
    if (doc) {
      const restorationPromise = clearTemporaryChanges(doc.filePath)
        .then(async () => {
          if (!restoration || Object.keys(restoration).length === 0) return;
          const entries = Object.entries(restoration).map(([idx, data]) => ({
            filePath: doc.filePath,
            pageIndex: parseInt(idx, 10),
            data,
          }));
          await saveTemporaryPageDataBatch(entries);
        })
        .catch((e) => {
          console.warn('[Store] clearTemporaryChanges失敗:', e);
        });

      // 復元書き込みも pendingIdbSaves で追跡し、呼び出し元が完了を待機できるようにする
      if (restoration && Object.keys(restoration).length > 0) {
        pendingIdbSaves.add(restorationPromise);
        restorationPromise.finally(() => pendingIdbSaves.delete(restorationPromise));
      }
    }
  },

  setCurrentPage: (index) => set((state) => {
    const newOrder = [index, ...state.pageAccessOrder.filter(i => i !== index)];
    return { currentPageIndex: index, selectedIds: new Set(), lastSelectedId: null, pageAccessOrder: newOrder };
  }),

  setZoom: (zoom) => set({ zoom }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  setOcrOpacity: (opacity) => set({ ocrOpacity: opacity }),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({ isDrawingMode: !state.isDrawingMode, isSplitMode: false })),
  
  toggleSplitMode: () => set((state) => ({ isSplitMode: !state.isSplitMode, isDrawingMode: false })),

  updatePageData: (pageIndex, data, undoable = true) => {
    // LRU退避時のIndexedDB保存をset()の外で非同期実行するためペンディングリストを収集
    const pendingSaves: Array<{ filePath: string; idx: number; page: PageData }> = [];

    set((state) => {
      if (!state.document) return state;
      const oldPage = state.document.pages.get(pageIndex);
      const newPage = oldPage ? { ...oldPage, ...data } : (data as PageData);
      const newPages = new Map(state.document.pages);
      newPages.set(pageIndex, newPage);

      // Update access order
      const newOrder = [pageIndex, ...state.pageAccessOrder.filter(i => i !== pageIndex)];

      // LRU Purge: If we exceed MAX_CACHED_PAGES, remove the oldest non-dirty page
      // OR save dirty page to IDB and then remove from memory.
      if (newPages.size > MAX_CACHED_PAGES) {
        for (let i = newOrder.length - 1; i >= 0; i--) {
          const idxToRemove = newOrder[i];
          const pageToRemove = newPages.get(idxToRemove);
          // Never purge the current page
          if (idxToRemove !== state.currentPageIndex && pageToRemove) {
            if (pageToRemove.isDirty) {
              // set()コールバックは同期のため、保存対象を収集してset()外で非同期実行する
              pendingSaves.push({ filePath: state.document!.filePath, idx: idxToRemove, page: pageToRemove });
            }
            newPages.delete(idxToRemove);
            newOrder.splice(i, 1);
            if (newPages.size <= MAX_CACHED_PAGES) break;
          }
        }
      }

      const newState: Partial<PecoState> = {
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
    });

    // set()外でIndexedDB保存をバッチ実行（1トランザクションでまとめて書き込み）
    // pendingIdbSaves に登録して保存処理が完了を待機できるようにする
    if (pendingSaves.length > 0) {
      const savePromise = saveTemporaryPageDataBatch(
        pendingSaves.map(({ filePath, idx, page }) => ({ filePath, pageIndex: idx, data: page }))
      ).catch((e) => {
        console.warn('[Store] IndexedDB バッチ保存失敗:', e);
      });
      pendingIdbSaves.add(savePromise);
      savePromise.finally(() => pendingIdbSaves.delete(savePromise));
    }
  },

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
    let newLastId = state.lastSelectedId;
    if (newSelection.has(id)) {
      newSelection.delete(id);
      if (newLastId === id) newLastId = null;
    } else {
      newSelection.add(id);
      newLastId = id;
    }
    return { selectedIds: newSelection, lastSelectedId: newLastId };
  }),

  setSelectedIds: (ids) => set({ selectedIds: new Set(ids), lastSelectedId: ids[ids.length - 1] || null }),

  clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),

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

    clipboard.forEach((b) => {
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
  },

  clearOcrCurrentPage: () => {
    const { document, currentPageIndex, updatePageData } = get();
    if (!document) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    updatePageData(currentPageIndex, { textBlocks: [], isDirty: true });
  },

  clearOcrAllPages: () => {
    const { document } = get();
    if (!document) return;
    set((state) => {
      if (!state.document) return state;
      const newPages = new Map(state.document.pages);
      // ロード済みページのtextBlocksを空にする
      for (const [idx, page] of newPages.entries()) {
        newPages.set(idx, { ...page, textBlocks: [], isDirty: true });
      }
      // 未ロードページ用にdocumentのtotalPagesを参照してダミーPageDataを作成
      for (let i = 0; i < state.document.totalPages; i++) {
        if (!newPages.has(i)) {
          newPages.set(i, {
            pageIndex: i,
            width: 0,
            height: 0,
            textBlocks: [],
            isDirty: true,
            thumbnail: null,
          });
        }
      }
      return {
        document: { ...state.document, pages: newPages },
        isDirty: true,
        undoStack: [],
        redoStack: [],
      };
    });
  },
}));
