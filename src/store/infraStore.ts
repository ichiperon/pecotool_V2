import { create } from 'zustand';
import type * as pdfjsLib from 'pdfjs-dist';
import type { PageData } from '../types';

interface InfraState {
  /**
   * #102: ドキュメント差し替え (setDocument) のたびに +1 される単調増加カウンタ。
   * updatePageData による document 再生成では変化しない。
   * OCR ループのような長時間 async 処理が「処理開始時点と同じドキュメントか」を
   * 安全に判定するのに使う (reference identity は updatePageData で壊れるため不可)。
   */
  documentEpoch: number;
  /** For page data LRU (1000ページ対応) */
  pageAccessOrder: number[];
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

  // Actions
  bumpDocumentEpoch: () => void;
  bumpDocumentEpochAndClearProxy: () => void;
  resetPageAccessOrder: () => void;
  updatePageAccessOrder: (pageIndex: number) => number[];
  setPendingRestoration: (pages: Record<string, Partial<PageData>> | null) => void;
  clearPendingRestoration: () => void;
  setLastIdbError: (err: Error) => void;
  clearLastIdbError: () => void;
  clearLastIdbErrorIfSet: () => void;
  setCurrentPageProxy: (filePath: string, pageIndex: number, proxy: pdfjsLib.PDFPageProxy | null) => void;
  clearCurrentPageProxy: () => void;
}

export const useInfraStore = create<InfraState>((set, get) => ({
  documentEpoch: 0,
  pageAccessOrder: [],
  pendingRestoration: null,
  lastIdbError: null,
  currentPageProxy: null,
  currentPageProxyKey: null,

  // issue #102: documentEpoch を +1 する (pecoStore.setDocument から呼ばれる)
  bumpDocumentEpoch: () => set((state) => ({ documentEpoch: state.documentEpoch + 1 })),

  // issue #118: bumpDocumentEpoch + currentPageProxy クリア (pecoStore.bumpDocumentEpoch から呼ばれる)
  bumpDocumentEpochAndClearProxy: () => set((state) => ({
    documentEpoch: state.documentEpoch + 1,
    currentPageProxy: null,
    currentPageProxyKey: null,
  })),

  resetPageAccessOrder: () => set({ pageAccessOrder: [] }),

  updatePageAccessOrder: (pageIndex) => {
    const current = get().pageAccessOrder;
    const newOrder = [pageIndex, ...current.filter(i => i !== pageIndex)];
    set({ pageAccessOrder: newOrder });
    return newOrder;
  },

  setPendingRestoration: (pages) => set({ pendingRestoration: pages }),

  clearPendingRestoration: () => set({ pendingRestoration: null }),

  setLastIdbError: (err) => set({ lastIdbError: err }),

  clearLastIdbError: () => set({ lastIdbError: null }),

  // エラーが設定されている場合のみクリアする (IDB 成功時の通知リセット用)
  clearLastIdbErrorIfSet: () => {
    if (get().lastIdbError) set({ lastIdbError: null });
  },

  setCurrentPageProxy: (filePath, pageIndex, proxy) => {
    const key = `${filePath}:${pageIndex}`;
    set({ currentPageProxy: proxy, currentPageProxyKey: proxy ? key : null });
  },

  clearCurrentPageProxy: () => set({ currentPageProxy: null, currentPageProxyKey: null }),
}));

// ─── Selectors ───
export const selectDocumentEpoch = (s: InfraState) => s.documentEpoch;
export const selectPageAccessOrder = (s: InfraState) => s.pageAccessOrder;
export const selectPendingRestoration = (s: InfraState) => s.pendingRestoration;
export const selectLastIdbError = (s: InfraState) => s.lastIdbError;
export const selectCurrentPageProxy = (s: InfraState) => s.currentPageProxy;
export const selectCurrentPageProxyKey = (s: InfraState) => s.currentPageProxyKey;
