import { create } from 'zustand';
import type { BoundingBox } from '../types';

interface ViewerState {
  zoom: number;
  showOcr: boolean;
  ocrOpacity: number;
  showTextPreview: boolean;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  isCurveMode: boolean;
  /**
   * issue #191: PDF ビュー上で矩形ドラッグして部分領域を OCR するモード。
   * isDrawingMode / isSplitMode / isCurveMode と排他。
   */
  isRangeOcrMode: boolean;
  /**
   * ドラッグ中のみ非 null。ドラッグ対象 BB の id -> 現在の bbox の Map。
   * issue #91: textBlocks 配列を毎フレーム map() で複製すると BB 1000+ ページで
   * GC 圧 / オブジェクト割り当てが増えてカクつく。ドラッグ中は textBlocks を
   * 一切触らずこのフィールドのみ更新し、overlay 描画でこの bbox を優先表示する。
   * finishDragResize で 1 度だけ textBlocks に確定書き込み + dragPreviewBboxes=null。
   */
  dragPreviewBboxes: Map<string, BoundingBox> | null;

  // Actions
  /** issue #138: 25%-500% にクランプ */
  setZoom: (zoom: number) => void;
  toggleShowOcr: () => void;
  setOcrOpacity: (opacity: number) => void;
  toggleTextPreview: () => void;
  /** drawing/split/curve/rangeOcr と排他 */
  toggleDrawingMode: () => void;
  toggleSplitMode: () => void;
  toggleCurveMode: () => void;
  /** issue #191: 範囲指定 OCR モードをトグルする。他モードは OFF になる。 */
  toggleRangeOcrMode: () => void;
  /** ドラッグ中の bbox プレビュー Map をセットする。null でクリア。issue #91 */
  setDragPreviewBboxes: (bboxes: Map<string, BoundingBox> | null) => void;
  /**
   * ドキュメント切替時に viewer UI state をリセットする。
   * pecoStore.setDocument から呼ばれる。
   */
  resetViewerState: () => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  zoom: 100,
  showOcr: true,
  ocrOpacity: 0.4,
  showTextPreview: false,
  isDrawingMode: false,
  isSplitMode: false,
  isCurveMode: false,
  isRangeOcrMode: false,
  dragPreviewBboxes: null,

  // issue #138: ツールバーボタン連打で zoom が暴走しないよう 10%-500% にクランプ
  // PCT-095: フィット計算が 25% 未満になる狭いウィンドウでも正しくフィット表示できるよう下限を 10 に変更。
  // 手動ズームの 25% 下限はホイール (useKeyboardShortcuts.ts) とボタン (App.tsx の
  // onZoomIn/onZoomOut) の 2 箇所で維持している。片方だけ見て変更しないこと。
  setZoom: (zoom) => set({ zoom: Math.min(500, Math.max(10, zoom)) }),

  toggleShowOcr: () => set((state) => ({ showOcr: !state.showOcr })),

  setOcrOpacity: (opacity) => set({ ocrOpacity: opacity }),

  toggleTextPreview: () => set((state) => ({ showTextPreview: !state.showTextPreview })),

  toggleDrawingMode: () => set((state) => ({
    isDrawingMode: !state.isDrawingMode,
    isSplitMode: false,
    isCurveMode: false,
    isRangeOcrMode: false,
  })),

  toggleSplitMode: () => set((state) => ({
    isSplitMode: !state.isSplitMode,
    isDrawingMode: false,
    isCurveMode: false,
    isRangeOcrMode: false,
  })),

  toggleCurveMode: () => set((state) => ({
    isCurveMode: !state.isCurveMode,
    isDrawingMode: false,
    isSplitMode: false,
    isRangeOcrMode: false,
  })),

  // #191: 範囲指定 OCR モード toggle (drawing/split/curve と排他)
  toggleRangeOcrMode: () => set((state) => ({
    isRangeOcrMode: !state.isRangeOcrMode,
    isDrawingMode: false,
    isSplitMode: false,
    isCurveMode: false,
  })),

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

  resetViewerState: () => set({
    showOcr: true,
    showTextPreview: false,
    isDrawingMode: false,
    isSplitMode: false,
    isCurveMode: false,
    isRangeOcrMode: false,
    dragPreviewBboxes: null,
  }),
}));

// ─── Selectors ─── (細粒度購読でApp全体の再レンダリング波及を防ぐ)
export const selectZoom = (s: ViewerState) => s.zoom;
export const selectShowOcr = (s: ViewerState) => s.showOcr;
export const selectOcrOpacity = (s: ViewerState) => s.ocrOpacity;
export const selectShowTextPreview = (s: ViewerState) => s.showTextPreview;
export const selectIsDrawingMode = (s: ViewerState) => s.isDrawingMode;
export const selectIsSplitMode = (s: ViewerState) => s.isSplitMode;
export const selectIsCurveMode = (s: ViewerState) => s.isCurveMode;
// issue #191: 範囲指定 OCR モード
export const selectIsRangeOcrMode = (s: ViewerState) => s.isRangeOcrMode;
// issue #91: ドラッグ中の bbox プレビュー。overlay 描画でドラッグ中 BB の bbox を
// 上書きするための入口。ドラッグ非実行中は null。
export const selectDragPreviewBboxes = (s: ViewerState) => s.dragPreviewBboxes;
