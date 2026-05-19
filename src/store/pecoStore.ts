import { create } from 'zustand';
import type * as pdfjsLib from 'pdfjs-dist';
import { PecoDocument, PageData, Action, TextBlock, BoundingBox } from '../types';
import { saveTemporaryPageDataBatch, clearTemporaryChanges } from '../utils/pdfLoader';
import { perf } from '../utils/perfLogger';

// 進行中のLRU退避IDB書き込みPromiseを追跡する。
// 保存処理はこれらが完了してからIDBを読み込む必要がある。
const pendingIdbSaves: Set<Promise<void>> = new Set();

/** 全てのLRU退避IDB書き込みが完了するまで待機する */
export function waitForPendingIdbSaves(): Promise<void> {
  if (pendingIdbSaves.size === 0) return Promise.resolve();
  return Promise.all(Array.from(pendingIdbSaves)).then(() => {});
}

/**
 * IDB 一時データへの書き込みを pendingIdbSaves に登録した上で発火する。
 * undo/redo など、メモリ Map を変更したあと LRU 退避済み IDB エントリと
 * 同期する用途で使う共通ヘルパ。
 */
function schedulePendingIdbWrite(
  entries: Array<{ filePath: string; pageIndex: number; data: Partial<PageData> }>,
  set: (partial: Partial<PecoState>) => void,
  get: () => PecoState,
): void {
  if (entries.length === 0) return;
  const work = saveTemporaryPageDataBatch(entries)
    .then(() => {
      if (get().lastIdbError) set({ lastIdbError: null });
    })
    .catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[Store] schedulePendingIdbWrite 失敗:', err);
      set({ lastIdbError: err });
    });
  const tracked: Promise<void> = work.finally(() => {
    pendingIdbSaves.delete(tracked);
  });
  pendingIdbSaves.add(tracked);
}

interface PecoState {
  document: PecoDocument | null;
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
  /** 復元待ちのバックアップページデータ。setDocument 内で IDB への書き込みに使われる。 */
  pendingRestoration: Record<string, Partial<PageData>> | null;
  /** 直近の IDB 保存失敗エラー。UI から subscribe してユーザーに通知できる。 */
  lastIdbError: Error | null;

  /**
   * 現在表示中 (もしくは表示開始中) ページの PDFPageProxy。
   * usePageNavigation が viewport 取得時に set し、usePdfRendering が subscribe して
   * 二重 getCachedPageProxy を避けるための共有チャネル。
   * ファイル/ページ切替時の race 防止のため expectedKey (filePath:pageIndex) も持つ。
   */
  currentPageProxy: pdfjsLib.PDFPageProxy | null;
  currentPageProxyKey: string | null;

  /**
   * ドラッグ中のみ非 null。ドラッグ対象 BB の id -> 現在の bbox の Map。
   * issue #91: textBlocks 配列を毎フレーム map() で複製すると BB 1000+ ページで
   * GC 圧 / オブジェクト割り当てが増えてカクつく。ドラッグ中は textBlocks を
   * 一切触らずこのフィールドのみ更新し、overlay 描画でこの bbox を優先表示する。
   * finishDragResize で 1 度だけ textBlocks に確定書き込み + dragPreviewBboxes=null。
   */
  dragPreviewBboxes: Map<string, BoundingBox> | null;

  // Actions
  setPendingRestoration: (pages: Record<string, Partial<PageData>> | null) => void;
  setCurrentPageProxy: (filePath: string, pageIndex: number, proxy: pdfjsLib.PDFPageProxy | null) => void;
  clearCurrentPageProxy: () => void;
  setDocument: (doc: PecoDocument | null) => void;
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
  // issue #15: lastSelectedId を明示できるようにする (省略時は末尾 id を anchor とする)。
  setSelectedIds: (ids: string[], lastSelectedId?: string | null) => void;
  clearSelection: () => void;
  copySelected: () => void;
  pasteClipboard: (targetCenter?: { x: number; y: number }) => void;
  pushAction: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  clearOcrCurrentPage: () => void;
  clearOcrAllPages: () => void;
  clearLastIdbError: () => void;
  /** ドラッグ中の bbox プレビュー Map をセットする。null でクリア。issue #91 */
  setDragPreviewBboxes: (bboxes: Map<string, BoundingBox> | null) => void;
}

const MAX_CACHED_PAGES = 50;

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
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
  pendingRestoration: null,
  lastIdbError: null,
  currentPageProxy: null,
  currentPageProxyKey: null,
  dragPreviewBboxes: null,

  setPendingRestoration: (pages) => set({ pendingRestoration: pages }),
  setCurrentPageProxy: (filePath, pageIndex, proxy) => {
    const key = `${filePath}:${pageIndex}`;
    set({ currentPageProxy: proxy, currentPageProxyKey: proxy ? key : null });
  },
  clearCurrentPageProxy: () => set({ currentPageProxy: null, currentPageProxyKey: null }),
  setDocumentFilePath: (filePath) => set((state) => {
    if (!state.document) return state;
    const fileName = filePath.split(/[\\/]/).pop() || state.document.fileName;
    return { document: { ...state.document, filePath, fileName } };
  }),

  setDocument: (doc) => {
    // pendingRestoration を取り出してから state をリセットする
    const restoration = get().pendingRestoration;

    set({
      document: doc,
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
      // ファイル切替時は古い PDFPageProxy を保持しない (transport が破棄されるため)
      currentPageProxy: null,
      currentPageProxyKey: null,
      // ファイル切替時にドラッグ状態を持ち越さない
      dragPreviewBboxes: null,
    });

    // IDB一時データのクリアをset()外でawaitして確実に完了させる。
    // 復元データがある場合はクリア完了後に IDB へ書き込む（順序保証）。
    if (doc) {
      const work = clearTemporaryChanges(doc.filePath)
        .then(async () => {
          if (!restoration || Object.keys(restoration).length === 0) return;
          const entries = Object.entries(restoration).map(([idx, data]) => ({
            filePath: doc.filePath,
            pageIndex: parseInt(idx, 10),
            data,
          }));
          await saveTemporaryPageDataBatch(entries);
        })
        .then(() => {
          // 成功時のみ過去のエラーをクリア（他タスクのエラーを潰さないため既存がある時だけtouchしない方針も検討したが、保存成功=回復とみなす）
          if (get().lastIdbError) set({ lastIdbError: null });
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] clearTemporaryChanges/復元書き込み失敗:', err);
          set({ lastIdbError: err });
        });

      // finally で自身を Set から除去するため、tracked 変数を先に宣言してから add する
      const tracked: Promise<void> = work.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
  },

  setCurrentPage: (index) => {
    perf.mark('nav.click', { to: index });
    set((state) => {
      const newOrder = [index, ...state.pageAccessOrder.filter(i => i !== index)];
      return { currentPageIndex: index, selectedIds: new Set(), lastSelectedId: null, pageAccessOrder: newOrder };
    });
  },

  setZoom: (zoom) => set({ zoom }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  setOcrOpacity: (opacity) => set({ ocrOpacity: opacity }),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({ isDrawingMode: !state.isDrawingMode, isSplitMode: false })),
  
  toggleSplitMode: () => set((state) => ({ isSplitMode: !state.isSplitMode, isDrawingMode: false })),

  updatePageData: (pageIndex, data, undoable = true) => {
    if (perf.enabled) perf.mark('edit.storeEnter', { page: pageIndex, undoable, keys: Object.keys(data).join('|') });
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
      const work = saveTemporaryPageDataBatch(
        pendingSaves.map(({ filePath, idx, page }) => ({ filePath, pageIndex: idx, data: page }))
      )
        .then(() => {
          if (get().lastIdbError) set({ lastIdbError: null });
        })
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[Store] IndexedDB バッチ保存失敗:', err);
          // 保存失敗時は退避していたページをメモリに戻してデータロストを防ぐ（ロールバック）
          set((state) => {
            if (!state.document) return { lastIdbError: err };
            const restored = new Map(state.document.pages);
            for (const { idx, page } of pendingSaves) {
              if (!restored.has(idx)) restored.set(idx, page);
            }
            return {
              document: { ...state.document, pages: restored },
              lastIdbError: err,
            };
          });
        });

      // finally で自身を Set から除去するため、tracked 変数を先に宣言してから add する
      const tracked: Promise<void> = work.finally(() => {
        pendingIdbSaves.delete(tracked);
      });
      pendingIdbSaves.add(tracked);
    }
    if (perf.enabled) perf.mark('edit.storeExit', { page: pageIndex, pendingSaves: pendingSaves.length });
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

  setSelectedIds: (ids, lastSelectedId) =>
    set({
      selectedIds: new Set(ids),
      // 明示 anchor が来ればそれを採用 (issue #15 の Shift+↑↓ 拡張で必要)。
      // 省略 / undefined のときは従来通り末尾 id を anchor にする (後方互換)。
      lastSelectedId: lastSelectedId !== undefined ? lastSelectedId : (ids[ids.length - 1] || null),
    }),

  clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),

  copySelected: () => {
    const { document, currentPageIndex, selectedIds } = get();
    if (!document || selectedIds.size === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    const selected = page.textBlocks.filter(b => selectedIds.has(b.id));
    set({ clipboard: selected.map(b => ({ ...b })) });
  },

  pasteClipboard: (targetCenter) => {
    const { document, currentPageIndex, clipboard, updatePageData } = get();
    if (!document || clipboard.length === 0) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;

    const newBlocks = [...page.textBlocks];
    const pastedIds = new Set<string>();
    let offsetX = 10;
    let offsetY = 10;

    if (targetCenter) {
      const minX = Math.min(...clipboard.map(b => b.bbox.x));
      const minY = Math.min(...clipboard.map(b => b.bbox.y));
      const maxX = Math.max(...clipboard.map(b => b.bbox.x + b.bbox.width));
      const maxY = Math.max(...clipboard.map(b => b.bbox.y + b.bbox.height));
      offsetX = targetCenter.x - (minX + maxX) / 2;
      offsetY = targetCenter.y - (minY + maxY) / 2;
    }

    clipboard.forEach((b) => {
      const newId = crypto.randomUUID();
      const newBlock: TextBlock = {
        ...b,
        id: newId,
        bbox: { ...b.bbox, x: b.bbox.x + offsetX, y: b.bbox.y + offsetY },
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
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
      // LRU 退避済みページが IDB に残っている可能性があるため、
      // 巻き戻し後の状態を IDB へも書き込んでメモリと完全同期させる。
      // (issue #3: undo が LRU 退避ページの IDB と非整合になる)
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: action.before }], set, get);
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
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true
      });
      // undo と対称: redo 後の状態を IDB へも書き込んで整合性を担保
      schedulePendingIdbWrite([{ filePath, pageIndex: action.pageIndex, data: action.after }], set, get);
    }
  },

  clearOcrCurrentPage: () => {
    const { document, currentPageIndex, updatePageData } = get();
    if (!document) return;
    const page = document.pages.get(currentPageIndex);
    if (!page) return;
    updatePageData(currentPageIndex, { textBlocks: [], isDirty: true, isTextExtracted: true, ocrCleared: true });
  },

  clearLastIdbError: () => set({ lastIdbError: null }),

  setDragPreviewBboxes: (bboxes) => set({ dragPreviewBboxes: bboxes }),

  clearOcrAllPages: () => {
    const { document } = get();
    if (!document) return;
    set((state) => {
      if (!state.document) return state;
      const newPages = new Map<number, PageData>();
      for (let idx = 0; idx < state.document.totalPages; idx++) {
        const page = state.document.pages.get(idx);
        newPages.set(idx, {
          pageIndex: idx,
          width: page?.width ?? 0,
          height: page?.height ?? 0,
          textBlocks: [],
          isDirty: true,
          thumbnail: page?.thumbnail ?? null,
          isTextExtracted: true,
          ocrCleared: true,
        });
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

// ─── Selectors ─── (細粒度購読でApp全体の再レンダリング波及を防ぐ)
export const selectDocument = (s: PecoState) => s.document;
export const selectCurrentPageIndex = (s: PecoState) => s.currentPageIndex;
export const selectZoom = (s: PecoState) => s.zoom;
export const selectShowOcr = (s: PecoState) => s.showOcr;
export const selectOcrOpacity = (s: PecoState) => s.ocrOpacity;
export const selectSelectedIds = (s: PecoState) => s.selectedIds;
export const selectIsDrawingMode = (s: PecoState) => s.isDrawingMode;
export const selectIsSplitMode = (s: PecoState) => s.isSplitMode;
export const selectIsDirty = (s: PecoState) => s.isDirty;
export const selectUndoStack = (s: PecoState) => s.undoStack;
export const selectRedoStack = (s: PecoState) => s.redoStack;
export const selectCurrentPage = (s: PecoState) =>
  s.document?.pages.get(s.currentPageIndex) ?? null;
// 現在ページの textBlocks のみを購読するためのセレクタ。
// PageData 自体は updatePageData のたびに別参照になるが、textBlocks 配列は
// 更新したフィールドが textBlocks 以外（thumbnail / isTextExtracted など）の
// 場合は前回と同じ参照のままなので、購読側の再レンダリング/effect 再実行が抑えられる。
// (issue #22)
export const selectCurrentPageTextBlocks = (s: PecoState) =>
  s.document?.pages.get(s.currentPageIndex)?.textBlocks ?? null;
export const selectLastIdbError = (s: PecoState) => s.lastIdbError;
export const selectCurrentPageProxy = (s: PecoState) => s.currentPageProxy;
export const selectCurrentPageProxyKey = (s: PecoState) => s.currentPageProxyKey;
export const selectHasDocument = (s: PecoState) => s.document !== null;
// issue #91: ドラッグ中の bbox プレビュー。overlay 描画でドラッグ中 BB の bbox を
// 上書きするための入口。ドラッグ非実行中は null。
export const selectDragPreviewBboxes = (s: PecoState) => s.dragPreviewBboxes;
