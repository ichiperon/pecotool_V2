import { create } from "zustand";
import type { CellMatrix, ReportField, ReportTemplate, PageOffset } from "../types/report";
import { ZERO_OFFSET } from "../types/report";
import { applyCellMove } from "../logic/cellEdit";
import type { CellMoveMode } from "../logic/cellEdit";

export type { CellMoveMode };

/** 欄の表示色パレット（彩度抑えめ 8 色） */
export const FIELD_COLOR_PALETTE: readonly string[] = [
  "#7cb9e8", // ブルー
  "#90c8a0", // グリーン
  "#f5b8a0", // サーモン
  "#c8a8e0", // ラベンダー
  "#f5d898", // ライトイエロー
  "#a0c8c8", // ティール
  "#e8b0b8", // ローズ
  "#b8c8a0", // オリーブグリーン
] as const;

export type EditorMode = "idle" | "defineField" | "adjustOffset";

interface ReportState {
  template: ReportTemplate;
  cells: CellMatrix;
  mode: EditorMode;
  selectedFieldId: string | null;
  /**
   * ページごとの座標補正オフセット。
   * 既定 (0,0) のページはキーを持たない疎保持（Map に不在 = ZERO_OFFSET）。
   */
  pageOffsets: Map<number, PageOffset>;

  // actions
  addField: (rect: ReportField["rect"], name?: string) => void;
  removeField: (id: string) => void;
  renameField: (id: string, name: string) => void;
  setFieldColor: (id: string, color: string) => void;
  clearTemplate: () => void;
  setCells: (matrix: CellMatrix) => void;
  setMode: (mode: EditorMode) => void;
  selectField: (id: string | null) => void;
  /** インライン編集確定: 指定ページ・欄のセル値を更新する */
  setCellValue: (pageNum: number, fieldId: string, value: string) => void;
  /** Delete: 指定ページ・欄のセル値を空文字にする（キーは残す） */
  clearCellValue: (pageNum: number, fieldId: string) => void;
  /** ドラッグ値移動: 指定ページ内で from の値を to へ移動（既定 swap） */
  moveCellValue: (pageNum: number, fromFieldId: string, toFieldId: string, mode?: CellMoveMode) => void;
  /**
   * 指定ページのオフセットを設定する。
   * (dx, dy) が両方 0 のときはキーを削除して疎保持を維持する。
   * 前回と同値の場合は no-op（再描画なし）。
   */
  setPageOffset: (pageNum: number, dx: number, dy: number) => void;
  /**
   * 指定ページのオフセットを (ddx, ddy) だけ加算する。
   * 結果が (0, 0) になる場合はキーを削除する。
   */
  nudgePageOffset: (pageNum: number, ddx: number, ddy: number) => void;
  /** 指定ページのオフセットを削除して既定 (0, 0) に戻す。 */
  clearPageOffset: (pageNum: number) => void;
  /**
   * 指定ページの cells 行を新しい Map で全置換する。
   * 他ページの cells は保持される。
   * 単一ページ再 OCR 後の部分更新に使用する。
   */
  setCellsForPage: (pageNum: number, row: Map<string, string>) => void;
}

/**
 * フィールド一覧の中でまだ使われていない色をパレットから選ぶ。
 * 全色使用中の場合は循環する。
 */
function pickNextColor(fields: ReportField[]): string {
  const usedColors = new Set(fields.map((f) => f.color));
  for (const color of FIELD_COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  // 全色使用中 → 循環（フィールド数でインデックスを決める）
  return FIELD_COLOR_PALETTE[fields.length % FIELD_COLOR_PALETTE.length];
}

export const useReportStore = create<ReportState>((set) => ({
  template: { fields: [] },
  cells: new Map(),
  mode: "idle",
  selectedFieldId: null,
  pageOffsets: new Map(),

  addField: (rect, name) => {
    set((state) => {
      // crypto.randomUUID() を使ってグローバル可変カウンタを排除する。
      // Node 22 / jsdom の vitest 環境では globalThis.crypto.randomUUID() が利用可能。
      const id = `field-${globalThis.crypto.randomUUID()}`;
      const color = pickNextColor(state.template.fields);
      // 表示名の既定は現在のフィールド数ベース（clearTemplate 後は「欄 1」に戻る）
      const resolvedName = name ?? `欄 ${state.template.fields.length + 1}`;
      const newField: ReportField = { id, name: resolvedName, color, rect };
      return {
        template: {
          fields: [...state.template.fields, newField],
        },
      };
    });
  },

  removeField: (id) => {
    set((state) => ({
      template: {
        fields: state.template.fields.filter((f) => f.id !== id),
      },
      selectedFieldId:
        state.selectedFieldId === id ? null : state.selectedFieldId,
    }));
  },

  renameField: (id, name) => {
    set((state) => ({
      template: {
        fields: state.template.fields.map((f) =>
          f.id === id ? { ...f, name } : f
        ),
      },
    }));
  },

  setFieldColor: (id, color) => {
    set((state) => ({
      template: {
        fields: state.template.fields.map((f) =>
          f.id === id ? { ...f, color } : f
        ),
      },
    }));
  },

  clearTemplate: () => {
    set({ template: { fields: [] }, pageOffsets: new Map() });
  },

  setCells: (matrix) => {
    set({ cells: matrix });
  },

  setMode: (mode) => {
    set({ mode });
  },

  selectField: (id) => {
    set({ selectedFieldId: id });
  },

  setCellValue: (pageNum, fieldId, value) => {
    set((state) => {
      const prevRow = state.cells.get(pageNum);
      if (prevRow?.get(fieldId) === value) return {};
      const nextCells = new Map(state.cells);
      const nextRow = new Map(prevRow ?? []);
      nextRow.set(fieldId, value);
      nextCells.set(pageNum, nextRow);
      return { cells: nextCells };
    });
  },

  clearCellValue: (pageNum, fieldId) => {
    set((state) => {
      const prevRow = state.cells.get(pageNum);
      if (!prevRow) return {};
      if (prevRow.get(fieldId) === "") return {};
      const nextCells = new Map(state.cells);
      const nextRow = new Map(prevRow);
      nextRow.set(fieldId, "");
      nextCells.set(pageNum, nextRow);
      return { cells: nextCells };
    });
  },

  moveCellValue: (pageNum, fromFieldId, toFieldId, mode = "swap") => {
    set((state) => {
      const prevRow = state.cells.get(pageNum) ?? new Map<string, string>();
      const nextRow = applyCellMove(prevRow, fromFieldId, toFieldId, mode);
      // applyCellMove が same ref を返した場合は no-op（再描画させない）
      if (nextRow === prevRow) return {};
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRow);
      return { cells: nextCells };
    });
  },

  setPageOffset: (pageNum, dx, dy) => {
    set((state) => {
      const prev = state.pageOffsets.get(pageNum);
      // no-op: 前回と同値
      if (prev && prev.dx === dx && prev.dy === dy) return {};
      // no-op: 既にキーなし かつ (0,0) を設定しようとしている
      if (!prev && dx === 0 && dy === 0) return {};
      const next = new Map(state.pageOffsets);
      if (dx === 0 && dy === 0) {
        next.delete(pageNum);
      } else {
        next.set(pageNum, { dx, dy });
      }
      return { pageOffsets: next };
    });
  },

  nudgePageOffset: (pageNum, ddx, ddy) => {
    set((state) => {
      const prev = state.pageOffsets.get(pageNum) ?? ZERO_OFFSET;
      const nextDx = prev.dx + ddx;
      const nextDy = prev.dy + ddy;
      const next = new Map(state.pageOffsets);
      if (nextDx === 0 && nextDy === 0) {
        next.delete(pageNum);
      } else {
        next.set(pageNum, { dx: nextDx, dy: nextDy });
      }
      return { pageOffsets: next };
    });
  },

  clearPageOffset: (pageNum) => {
    set((state) => {
      if (!state.pageOffsets.has(pageNum)) return {};
      const next = new Map(state.pageOffsets);
      next.delete(pageNum);
      return { pageOffsets: next };
    });
  },

  setCellsForPage: (pageNum, row) => {
    set((state) => {
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, new Map(row));
      return { cells: nextCells };
    });
  },
}));
