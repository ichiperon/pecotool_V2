import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RowOrder = 'top-to-bottom' | 'bottom-to-top';
export type ColumnOrder = 'left-to-right' | 'right-to-left';

export const ROW_ORDER_LABELS: Record<RowOrder, string> = {
  'top-to-bottom': '上 → 下',
  'bottom-to-top': '下 → 上',
};

export const COLUMN_ORDER_LABELS: Record<ColumnOrder, string> = {
  'left-to-right': '左 → 右',
  'right-to-left': '右 → 左',
};

export type MixedOrder = 'vertical-first' | 'horizontal-first';

export const MIXED_ORDER_LABELS: Record<MixedOrder, string> = {
  'vertical-first': '縦書き → 横書き',
  'horizontal-first': '横書き → 縦書き',
};

export interface OcrLanguageInfo {
  tag: string;
  display_name: string;
}

export interface OcrSortSettings {
  horizontal: {
    rowOrder: RowOrder;       // 行の読み順（主軸）
    columnOrder: ColumnOrder; // 行内の列順（副軸）
  };
  vertical: {
    columnOrder: ColumnOrder; // 列の読み順（主軸）
    rowOrder: RowOrder;       // 列内の行順（副軸）
  };
  groupTolerance: number;
  mixedOrder: MixedOrder;
}

interface OcrSettingsState extends OcrSortSettings {
  ocrLanguage: string;
  availableLanguages: OcrLanguageInfo[];
  /** OCR 低信頼ハイライト: 閾値以下のブロックを赤系色で表示する (#192) */
  ocrConfidenceThreshold: number;
  /** OCR 低信頼ハイライトの表示 ON/OFF (#192) */
  showLowConfidenceHighlight: boolean;
  /**
   * 保存 PDF の OCR テキスト層（Acrobat の Ctrl+A 選択範囲）を表示上どれだけ右へずらすか (mm)。
   * 正値で右、負値で左。既定 4mm。アプリ内のキャンバス表示や BB 枠には影響しない（保存出力のみ）。
   */
  pdfTextOffsetRightMm: number;
  /**
   * 保存 PDF の OCR テキスト層を表示上どれだけ下へずらすか (mm)。
   * 正値で下、負値で上。既定 2mm。
   */
  pdfTextOffsetDownMm: number;
  setHorizontalRowOrder: (order: RowOrder) => void;
  setHorizontalColumnOrder: (order: ColumnOrder) => void;
  setVerticalColumnOrder: (order: ColumnOrder) => void;
  setVerticalRowOrder: (order: RowOrder) => void;
  setGroupTolerance: (val: number) => void;
  setMixedOrder: (order: MixedOrder) => void;
  setOcrLanguage: (tag: string) => void;
  setAvailableLanguages: (langs: OcrLanguageInfo[]) => void;
  setOcrConfidenceThreshold: (val: number) => void;
  setShowLowConfidenceHighlight: (val: boolean) => void;
  setPdfTextOffsetRightMm: (val: number) => void;
  setPdfTextOffsetDownMm: (val: number) => void;
}

export const useOcrSettingsStore = create<OcrSettingsState>()(
  persist(
    (set) => ({
      horizontal: {
        rowOrder: 'top-to-bottom',
        columnOrder: 'left-to-right',
      },
      vertical: {
        columnOrder: 'right-to-left',
        rowOrder: 'top-to-bottom',
      },
      groupTolerance: 20,
      mixedOrder: 'vertical-first',
      ocrLanguage: 'ja',
      availableLanguages: [],
      ocrConfidenceThreshold: 0.7,
      showLowConfidenceHighlight: true,
      pdfTextOffsetRightMm: 4,
      pdfTextOffsetDownMm: 2,
      setHorizontalRowOrder: (order) =>
        set((s) => ({ horizontal: { ...s.horizontal, rowOrder: order } })),
      setHorizontalColumnOrder: (order) =>
        set((s) => ({ horizontal: { ...s.horizontal, columnOrder: order } })),
      setVerticalColumnOrder: (order) =>
        set((s) => ({ vertical: { ...s.vertical, columnOrder: order } })),
      setVerticalRowOrder: (order) =>
        set((s) => ({ vertical: { ...s.vertical, rowOrder: order } })),
      setGroupTolerance: (val) => set({ groupTolerance: val }),
      setMixedOrder: (order) => set({ mixedOrder: order }),
      setOcrLanguage: (tag) => set({ ocrLanguage: tag }),
      setAvailableLanguages: (langs) => set({ availableLanguages: langs }),
      setOcrConfidenceThreshold: (val) => set({ ocrConfidenceThreshold: val }),
      setShowLowConfidenceHighlight: (val) => set({ showLowConfidenceHighlight: val }),
      setPdfTextOffsetRightMm: (val) => set({ pdfTextOffsetRightMm: val }),
      setPdfTextOffsetDownMm: (val) => set({ pdfTextOffsetDownMm: val }),
    }),
    {
      name: 'peco-ocr-settings',
      // availableLanguages はランタイム取得値なので persist しない
      partialize: (s) => ({
        horizontal: s.horizontal,
        vertical: s.vertical,
        groupTolerance: s.groupTolerance,
        mixedOrder: s.mixedOrder,
        ocrLanguage: s.ocrLanguage,
        ocrConfidenceThreshold: s.ocrConfidenceThreshold,
        showLowConfidenceHighlight: s.showLowConfidenceHighlight,
        pdfTextOffsetRightMm: s.pdfTextOffsetRightMm,
        pdfTextOffsetDownMm: s.pdfTextOffsetDownMm,
      }),
    }
  )
);
