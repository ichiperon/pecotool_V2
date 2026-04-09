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
  setHorizontalRowOrder: (order: RowOrder) => void;
  setHorizontalColumnOrder: (order: ColumnOrder) => void;
  setVerticalColumnOrder: (order: ColumnOrder) => void;
  setVerticalRowOrder: (order: RowOrder) => void;
  setGroupTolerance: (val: number) => void;
  setMixedOrder: (order: MixedOrder) => void;
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
    }),
    { name: 'peco-ocr-settings' }
  )
);
