import { create } from "zustand";
import type { FitMode } from "../lib/fitZoom";

export type { FitMode };

export interface PdfState {
  /** ロード済み PDF のファイルパス。未ロードなら null */
  filePath: string | null;
  /** 総ページ数。未ロードなら 0 */
  numPages: number;
  /** 現在表示ページ（1始まり） */
  currentPage: number;
  /** ズーム率（%単位、例: 100 = 100%） */
  zoom: number;
  /** ローディング中フラグ */
  isLoading: boolean;
  /** エラーメッセージ。正常時は null */
  error: string | null;
  /** フィットモード。"width"=幅フィット / "page"=全体フィット / "custom"=手動 */
  fitMode: FitMode;

  // actions
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setPdf: (filePath: string, numPages: number) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setFitMode: (mode: FitMode) => void;
  goToPrevPage: () => void;
  goToNextPage: () => void;
  reset: () => void;
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;

export const usePdfStore = create<PdfState>((set, get) => ({
  filePath: null,
  numPages: 0,
  currentPage: 1,
  zoom: 100,
  isLoading: false,
  error: null,
  fitMode: "width",

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error, isLoading: false }),

  setPdf: (filePath, numPages) =>
    set({
      filePath,
      numPages,
      currentPage: 1,
      isLoading: false,
      error: null,
    }),

  setCurrentPage: (page) => {
    const { numPages } = get();
    if (numPages === 0) return;
    const clamped = Math.max(1, Math.min(numPages, page));
    set({ currentPage: clamped });
  },

  setZoom: (zoom) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    set({ zoom: clamped });
  },

  setFitMode: (mode) => set({ fitMode: mode }),

  goToPrevPage: () => {
    const { currentPage, setCurrentPage } = get();
    setCurrentPage(currentPage - 1);
  },

  goToNextPage: () => {
    const { currentPage, setCurrentPage } = get();
    setCurrentPage(currentPage + 1);
  },

  reset: () =>
    set({
      filePath: null,
      numPages: 0,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
      fitMode: "width",
    }),
}));
