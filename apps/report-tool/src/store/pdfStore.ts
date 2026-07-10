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
  /**
   * ユーザー回転（全ページ一括・90°刻み）。ページ固有の /Rotate に加算合成して
   * 表示・サムネイル・OCR クロップの全 viewport 生成経路に同値で渡す（単一ソース）。
   * 経路間で値がズレると欄座標が全ずれするため、コンポーネントはローカルに持たない。
   */
  rotation: 0 | 90 | 180 | 270;
  /**
   * 読み込んだ PDF バイト列の SHA-256 フィンガープリント。未計算・未読込時は null。
   * pdfPath だけでは「同じパスだが中身が違う PDF」を区別できないため、セッション
   * 復元の同一性判定（#446 / PCT-210）に使う。setPdf と同一の set() で更新し、
   * filePath との整合が崩れる瞬間（片方だけ更新された状態）を作らない。
   */
  pdfFingerprint: string | null;
  /**
   * setPdf/reset のたびに進む世代番号。同じpath・fingerprintの再読込も区別し、
   * 非同期処理の古い結果を後から適用しないために使う。
   */
  loadGeneration: number;

  // actions
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setPdf: (filePath: string, numPages: number, fingerprint?: string | null) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setFitMode: (mode: FitMode) => void;
  goToPrevPage: () => void;
  goToNextPage: () => void;
  /** ユーザー回転を ±90° 進める（欄座標のリマップは reportStore 側で先に行うこと）。 */
  rotateBy: (delta: 90 | -90) => void;
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
  rotation: 0,
  pdfFingerprint: null,
  loadGeneration: 0,

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error, isLoading: false }),

  setPdf: (filePath, numPages, fingerprint = null) =>
    set((state) => ({
      filePath,
      numPages,
      currentPage: 1,
      isLoading: false,
      error: null,
      // 回転はその PDF 個体（スキャンロット）の性質なので、別 PDF では 0 に戻す
      rotation: 0,
      pdfFingerprint: fingerprint,
      loadGeneration: state.loadGeneration + 1,
    })),

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

  rotateBy: (delta) => {
    const { rotation } = get();
    const next = (((rotation + delta) % 360) + 360) % 360;
    set({ rotation: next as 0 | 90 | 180 | 270 });
  },

  reset: () =>
    set((state) => ({
      filePath: null,
      numPages: 0,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
      fitMode: "width",
      rotation: 0,
      pdfFingerprint: null,
      loadGeneration: state.loadGeneration + 1,
    })),
}));
