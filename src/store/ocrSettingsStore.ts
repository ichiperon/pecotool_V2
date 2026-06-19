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

/** PCT-110: 位置補正 offset の許容範囲（mm）。これを超える値はページ外へテキスト層が飛ぶ。 */
export const OFFSET_LIMIT_MM = 20;

/** offset(mm) を ±OFFSET_LIMIT_MM へ clamp する。呼び出し側で有限性は確認済み前提。 */
function clampOffsetMm(val: number): number {
  return Math.max(-OFFSET_LIMIT_MM, Math.min(OFFSET_LIMIT_MM, val));
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
   * 正値で右、負値で左。既定 0mm（補正なし＝ツール表示の BB 枠と一致）。
   * アプリ内のキャンバス表示や BB 枠には影響しない（保存出力のみ）。
   */
  pdfTextOffsetRightMm: number;
  /**
   * 保存 PDF の OCR テキスト層を表示上どれだけ下へずらすか (mm)。
   * 正値で下、負値で上。既定 0mm（補正なし）。
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
      pdfTextOffsetRightMm: 0,
      pdfTextOffsetDownMm: 0,
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
      // PCT-110: 位置補正は素の座標平行移動のため、極端値だとテキスト層がページ外へ
      // 飛んで実質テキスト消失に見える。物理的に妥当な ±OFFSET_LIMIT_MM へ clamp する。
      // 非有限値（NaN 等の無効入力）は現値を維持する（既存のフォールバック挙動）。
      setPdfTextOffsetRightMm: (val) =>
        set((s) => ({
          pdfTextOffsetRightMm: Number.isFinite(val) ? clampOffsetMm(val) : s.pdfTextOffsetRightMm,
        })),
      setPdfTextOffsetDownMm: (val) =>
        set((s) => ({
          pdfTextOffsetDownMm: Number.isFinite(val) ? clampOffsetMm(val) : s.pdfTextOffsetDownMm,
        })),
    }),
    {
      name: 'peco-ocr-settings',
      // version 1: 旧既定（右 4mm・下 2mm）から既定 0/0 への移行（PCT-117）。
      // 旧既定はユーザーの明示設定ではなく開発時のデフォルト値だったため、
      // 移行時に位置補正を 0/0 にリセットする。その他の永続値は保持する。
      version: 1,
      migrate: (persistedState, version) => {
        const s = (persistedState ?? {}) as Partial<OcrSettingsState>;
        // 返り値は rehydrate 時に既定値（initializer）とマージされるため、
        // 永続化されていたフィールドのみを返せばよい（Partial で実体上問題ない）。
        if (version < 1) {
          return {
            ...s,
            pdfTextOffsetRightMm: 0,
            pdfTextOffsetDownMm: 0,
          } as OcrSettingsState;
        }
        return s as OcrSettingsState;
      },
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
