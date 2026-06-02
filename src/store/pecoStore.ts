import { create } from 'zustand';
import type * as pdfjsLib from 'pdfjs-dist';
import { PecoDocument, PageData, Action, TextBlock, BoundingBox } from '../types';
import {
  saveTemporaryPageDataBatch,
  clearTemporaryChanges,
  getAllTemporaryPageData,
} from '../utils/pdfLoader';
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
  /**
   * #102: ドキュメント差し替え (setDocument) のたびに +1 される単調増加カウンタ。
   * updatePageData による document 再生成では変化しない。
   * OCR ループのような長時間 async 処理が「処理開始時点と同じドキュメントか」を
   * 安全に判定するのに使う (reference identity は updatePageData で壊れるため不可)。
   */
  documentEpoch: number;
  pageAccessOrder: number[]; // For page data LRU (1000ページ対応)
  currentPageIndex: number;
  zoom: number;
  isDirty: boolean;
  showOcr: boolean;
  ocrOpacity: number;
  showTextPreview: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  isCurveMode: boolean;
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
  /**
   * issue #118: documentEpoch だけを +1 する。document / pages / currentPageIndex /
   * zoom / undo・redo / isDirty には一切触れない。
   * 保存 (replace_pdf_file) でディスク上の PDF バイト列が差し替わったあと、
   * usePageNavigation / usePdfRendering に「同じ filePath/currentPageIndex でも
   * pdfjs proxy を取り直してページ画像を再 render せよ」と通知するための入口。
   * setDocument と違い編集状態 (textBlocks / BB / dirty / 履歴) を保持する。
   */
  bumpDocumentEpoch: () => void;
  setDocumentFilePath: (filePath: string) => void;
  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  toggleShowOcr: () => void;
  setOcrOpacity: (opacity: number) => void;
  toggleTextPreview: () => void;
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
  toggleCurveMode: () => void;
  updatePageData: (pageIndex: number, data: Partial<PageData>, undoable?: boolean) => void;
  resetDirty: (savedPageSnapshots?: Map<number, PageData>) => void;

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

  /**
   * issue #93 (Find & Replace): 一括置換を実行する。
   * @returns 影響を受けた件数 (置換ヒット数), ブロック数, ページ数
   * - scope:
   *   - 'selection': 選択中の BB のみ
   *   - 'current': 現在ページの全 BB
   *   - 'all': document.totalPages 全範囲。issue #104: LRU 退避ページも IDB から読み戻して走査する
   * - useRegex=true のときの構文エラーは throw する (UI 側でハンドルする)
   *   useRegex=false のとき、replacement 内の $&, $0, $1, $$ などの特殊扱いを避けるため
   *   String.prototype.replace に渡す前に '$' → '$$' エスケープを行う (issue #105)
   * - skipBlockIds: 編集中などで保護したいブロック ID。スキップしたページに対する skip 数も返す
   * - undo: 影響を受けた全ページを 1 つの update_pages Action にまとめる
   *
   * issue #104: scope='all' で IDB 退避ページも対象になるため async に変更。
   */
  replaceText: (params: {
    scope: 'selection' | 'current' | 'all';
    pattern: string;
    replacement: string;
    caseSensitive: boolean;
    useRegex: boolean;
    skipBlockIds?: ReadonlySet<string>;
  }) => Promise<{ hits: number; blocks: number; pages: number; skippedBlocks: number }>;
}

const MAX_CACHED_PAGES = 50;

export const usePecoStore = create<PecoState>((set, get) => ({
  document: null,
  documentEpoch: 0,
  pageAccessOrder: [],
  currentPageIndex: 0,
  zoom: 100,
  isDirty: false,
  showOcr: true,
  ocrOpacity: 0.4,
  showTextPreview: false,
  isDrawingMode: false,
  isSplitMode: false,
  isCurveMode: false,
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
      // #102: ドキュメント差し替えを epoch で示す。OCR ループは開始時点の epoch を
      // 保持し、ループ内で getState().documentEpoch と比較する。
      documentEpoch: get().documentEpoch + 1,
      pageAccessOrder: [],
      currentPageIndex: 0,
      // バックアップ復元時は即座に isDirty=true にしておく
      isDirty: restoration !== null && doc !== null,
      showOcr: true,
      showTextPreview: false,
      isDrawingMode: false,
      isSplitMode: false,
      isCurveMode: false,
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

  // issue #118: 保存後にディスク上の PDF が差し替わった際、pdfjs proxy の再取得と
  // ページ画像の再 render をトリガーするためだけに documentEpoch を進める。
  // document 本体・pages・currentPageIndex・zoom・undo/redo・isDirty は不変。
  //
  // issue #149: bumpDocumentEpoch 自体は非同期 IDB save (pendingIdbSaves) と
  // 同期しない。呼び出し側 (useFileOperations など) は本関数を呼ぶ前に必ず
  //   await waitForPendingIdbSaves();
  // を実行し、ディスク上の PDF が IDB の最新 state と一致してから epoch を
  // bump する責務を持つ。さもなくば pdfjs が古い IDB blob を再読込して
  // 直前の編集が消えて見える race が発生する。
  bumpDocumentEpoch: () => set((state) => ({
    documentEpoch: state.documentEpoch + 1,
    currentPageProxy: null,
    currentPageProxyKey: null,
  })),

  setCurrentPage: (index) => {
    perf.mark('nav.click', { to: index });
    set((state) => {
      const newOrder = [index, ...state.pageAccessOrder.filter(i => i !== index)];
      return { currentPageIndex: index, selectedIds: new Set(), lastSelectedId: null, pageAccessOrder: newOrder };
    });
  },

  // issue #138: ツールバーボタン連打で zoom が暴走しないよう 25%-500% にクランプ
  setZoom: (zoom) => set({ zoom: Math.min(500, Math.max(25, zoom)) }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  setOcrOpacity: (opacity) => set({ ocrOpacity: opacity }),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({ isDrawingMode: !state.isDrawingMode, isSplitMode: false, isCurveMode: false })),

  toggleSplitMode: () => set((state) => ({ isSplitMode: !state.isSplitMode, isDrawingMode: false, isCurveMode: false })),

  toggleCurveMode: () => set((state) => ({ isCurveMode: !state.isCurveMode, isDrawingMode: false, isSplitMode: false })),

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
            const currentFilePath = state.document.filePath;
            const pendingSavesForCurrentDocument = pendingSaves.filter(({ filePath }) => filePath === currentFilePath);
            if (pendingSavesForCurrentDocument.length === 0) return { lastIdbError: err };
            const restored = new Map(state.document.pages);
            for (const { idx, page } of pendingSavesForCurrentDocument) {
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

  resetDirty: (savedPageSnapshots) => set((state) => {
    if (!state.document) return state;
    // savedPageSnapshots 指定時は「保存スナップショットと同一オブジェクト参照のページ」
    // だけ isDirty を下ろす。保存中に編集されたページは新しいオブジェクト参照になるため
    // 一致せず、その新編集の dirty フラグを巻き込まない (issue #115 / #119)。
    // 省略時は従来通り全ページの isDirty を一律クリアする (後方互換)。
    const newPages = new Map(state.document.pages);
    let anyDirty = false;
    if (savedPageSnapshots) {
      for (const [idx, savedPage] of savedPageSnapshots.entries()) {
        const livePage = newPages.get(idx);
        if (livePage === savedPage && livePage.isDirty) {
          newPages.set(idx, { ...livePage, isDirty: false });
        }
      }
      for (const page of newPages.values()) {
        if (page.isDirty) {
          anyDirty = true;
          break;
        }
      }
    } else {
      for (const [idx, page] of newPages.entries()) {
        if (page.isDirty) {
          newPages.set(idx, { ...page, isDirty: false });
        }
      }
    }
    return {
      document: { ...state.document, pages: newPages },
      isDirty: anyDirty
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
    // issue #146: copy 対象は currentPage に存在する選択 BB のみ。
    // 仕様上、選択 (selectedIds) はページ切替時に clearSelection されるため
    // cross-page 選択は発生しないという前提を採っている。将来サムネイル側で
    // 跨ぎ選択を許容する場合は document.pages 全体を走査して BB を集める
    // 実装に拡張する必要がある (現状は意図的に未対応)。
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
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic に巻き戻す。
      const newPages = new Map(document.pages);
      for (const e of action.entries) {
        newPages.set(e.pageIndex, e.before);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      // 全 entry を IDB へまとめて同期 (LRU 退避ページがあっても整合性を担保)
      schedulePendingIdbWrite(
        action.entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.before })),
        set,
        get,
      );
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
    } else if (action.type === 'update_pages') {
      // issue #93: 全ページスコープの置換等で複数ページを atomic にやり直す。
      const newPages = new Map(document.pages);
      for (const e of action.entries) {
        newPages.set(e.pageIndex, e.after);
      }
      const filePath = document.filePath;
      set({
        document: { ...document, pages: newPages },
        undoStack: newUndo,
        redoStack: newRedo,
        isDirty: true,
      });
      schedulePendingIdbWrite(
        action.entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
        set,
        get,
      );
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

  setDragPreviewBboxes: (bboxes) => {
    // issue #174: 同内容 (= bbox 値が全て一致) なら set をスキップして購読者の再 render を抑える。
    // computeDragPreviewBboxes は毎フレーム new Map を返すため、参照比較だけでは
    // 「移動量 dx/dy が変わっていない (mousemove 静止)」状態でも常に変更扱いになる。
    const prev = get().dragPreviewBboxes;
    if (prev === bboxes) return;
    if (prev && bboxes && prev.size === bboxes.size) {
      let identical = true;
      for (const [id, b] of bboxes) {
        const p = prev.get(id);
        if (!p || p.x !== b.x || p.y !== b.y || p.width !== b.width || p.height !== b.height) {
          identical = false;
          break;
        }
      }
      if (identical) return;
    }
    set({ dragPreviewBboxes: bboxes });
  },

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

  /**
   * scope について:
   *  - 'current'  : 現在ページの全 BB
   *  - 'all'      : 全ページ。LRU で in-memory から退避されたページも IDB から読み戻して対象に含める
   *  - 'selection': **現在ページの選択 BB のみ**。LRU 退避された他ページに対する選択は対象外。
   *                 (実装上 selectedIds は currentPage と紐づくため、退避ページに選択が残っていても
   *                  basePages に他ページが入らないので対象に上がらない。issue #139)
   */
  replaceText: async ({ scope, pattern, replacement, caseSensitive, useRegex, skipBlockIds }) => {
    const state = get();
    const document = state.document;
    if (!document) return { hits: 0, blocks: 0, pages: 0, skippedBlocks: 0 };
    if (pattern.length === 0) return { hits: 0, blocks: 0, pages: 0, skippedBlocks: 0 };

    // 検索用の RegExp を組み立てる。useRegex=false は escape して flag 'g' を必ず付ける。
    // useRegex=true の場合は構文エラーが上に伝播する (UI で catch する想定)。
    const flags = `g${caseSensitive ? '' : 'i'}`;
    const re = useRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

    // issue #105: String.prototype.replace は replacement 内の $&, $0, $1, $$ を
    // 特殊解釈する。useRegex=false では replacement を literal として扱うため '$' を
    // '$$' にエスケープする。useRegex=true ではユーザ意図で後方参照を使う想定なのでそのまま。
    const safeReplacement = useRegex
      ? replacement
      : replacement.replace(/\$/g, '$$$$');

    const filePath = document.filePath;

    // issue #104: scope='all' で LRU 退避ページ (in-memory pages Map から外れたもの) も
    // IDB から読み戻して走査対象に含める。
    // 各 idx について「走査ベース PageData」を構築する。in-memory 優先、無ければ IDB の
    // textBlocks を完全 PageData に詰め直す (width/height/thumbnail は欠落しても 0/null で補完)。
    const basePages = new Map<number, PageData>();
    if (scope === 'selection' || scope === 'current') {
      const page = document.pages.get(state.currentPageIndex);
      if (page) basePages.set(state.currentPageIndex, page);
    } else {
      // in-memory に存在するページを先に積む
      for (const [idx, page] of document.pages.entries()) {
        basePages.set(idx, page);
      }
      // IDB から退避ページを読み戻し、in-memory に無い idx だけ追加
      const idbAll = await getAllTemporaryPageData(filePath);
      for (const [idx, partial] of idbAll.entries()) {
        if (basePages.has(idx)) continue;
        if (!partial.textBlocks) continue;
        const restored: PageData = {
          pageIndex: idx,
          width: partial.width ?? 0,
          height: partial.height ?? 0,
          textBlocks: partial.textBlocks,
          isDirty: partial.isDirty ?? false,
          thumbnail: partial.thumbnail ?? null,
          isTextExtracted: partial.isTextExtracted,
          ocrCleared: partial.ocrCleared,
        };
        basePages.set(idx, restored);
      }
    }

    const selectedIds = state.selectedIds;
    const skip = skipBlockIds ?? new Set<string>();

    let totalHits = 0;
    let totalBlocks = 0;
    let skippedBlocks = 0;
    const entries: Array<{ pageIndex: number; before: PageData; after: PageData }> = [];

    // 安定した順序で走査 (in-memory + IDB 復元の順序差を吸収)
    const targetIndices = Array.from(basePages.keys()).sort((a, b) => a - b);

    for (const pageIdx of targetIndices) {
      const page = basePages.get(pageIdx);
      if (!page) continue;

      let pageChanged = false;
      const newTextBlocks: TextBlock[] = [];
      for (const b of page.textBlocks) {
        // selection スコープでは選択 ID のみ対象
        if (scope === 'selection' && !selectedIds.has(b.id)) {
          newTextBlocks.push(b);
          continue;
        }
        // 編集中などで保護されたブロックは skip
        if (skip.has(b.id)) {
          // それでも本来 hit 候補だったかを数える (UI 警告用)
          re.lastIndex = 0;
          if (re.test(b.text)) skippedBlocks++;
          newTextBlocks.push(b);
          continue;
        }

        re.lastIndex = 0;
        // issue #177: replace と count を 1 回の regex 走査で済ませる。
        // 旧実装は `b.text.replace(re, safeReplacement)` と `b.text.match(re)` を
        // 2 回走らせており、scope='all' の長大テキスト × 全ページでメインスレッド
        // をブロックしていた。replacer に関数を渡せば match ごとに hit++ できる。
        // safeReplacement (useRegex=false) の '$$' エスケープは replacer の戻り値では
        // 不要 (文字列が返り値としてそのまま使われる) のため、生の replacement を返す。
        let hits = 0;
        const literalReplacement = replacement;
        const replaced = b.text.replace(re, useRegex
          ? (...args) => {
              hits++;
              // useRegex=true: 後方参照を反映させるため $-string で再 replace する。
              // ただし replacer 内で動的に行うので、match 全体を素材に同じ正規表現
              // ではなく安全に safeReplacement を適用する手段が必要。ここでは
              // String.prototype.replace の "1回限り" 呼び出しで $-参照を解決する。
              const matchStr = args[0] as string;
              // groups + offset + full string の余剰引数を捨てて再構築する必要は無く、
              // matchStr に対して同じ re で 1 回 replace すれば $1...$n が解決される。
              const oneShot = new RegExp(re.source, re.flags.replace('g', ''));
              return matchStr.replace(oneShot, safeReplacement);
            }
          : () => {
              hits++;
              return literalReplacement;
            });
        if (hits === 0) {
          newTextBlocks.push(b);
          continue;
        }
        totalHits += hits;
        totalBlocks++;
        pageChanged = true;
        newTextBlocks.push({
          ...b,
          text: replaced,
          isDirty: true,
        });
      }

      if (pageChanged) {
        const newPage: PageData = { ...page, textBlocks: newTextBlocks, isDirty: true };
        entries.push({ pageIndex: pageIdx, before: page, after: newPage });
      }
    }

    if (entries.length === 0) {
      return { hits: 0, blocks: 0, pages: 0, skippedBlocks };
    }

    // store に反映
    set((s) => {
      if (!s.document) return s;
      const newPages = new Map(s.document.pages);
      for (const e of entries) {
        // 退避済みページの after も in-memory に積む (LRU で再度退避され得る)
        newPages.set(e.pageIndex, e.after);
      }
      const newAction: Action = { type: 'update_pages', entries };
      const newUndo = [...s.undoStack, newAction];
      if (newUndo.length > 100) newUndo.shift();
      return {
        document: { ...s.document, pages: newPages },
        undoStack: newUndo,
        redoStack: [],
        isDirty: true,
      };
    });

    // LRU 退避済みページの IDB と整合させるため、変更ページ全部を IDB にも書き込む
    schedulePendingIdbWrite(
      entries.map(e => ({ filePath, pageIndex: e.pageIndex, data: e.after })),
      set,
      get,
    );

    return { hits: totalHits, blocks: totalBlocks, pages: entries.length, skippedBlocks };
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
export const selectIsCurveMode = (s: PecoState) => s.isCurveMode;
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
// issue #134: document 全体を購読すると updatePageData (別ページ含む) 毎に
// 再レンダされてしまうため、PdfCanvas/OcrEditor では filePath / totalPages の
// primitive のみを購読する。
export const selectDocumentFilePath = (s: PecoState) => s.document?.filePath;
export const selectDocumentTotalPages = (s: PecoState) => s.document?.totalPages;
// issue #91: ドラッグ中の bbox プレビュー。overlay 描画でドラッグ中 BB の bbox を
// 上書きするための入口。ドラッグ非実行中は null。
export const selectDragPreviewBboxes = (s: PecoState) => s.dragPreviewBboxes;
