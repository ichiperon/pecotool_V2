import { create } from "zustand";
import type { CellMatrix, ReportField, ReportRow, ReportTemplate, PageOffset } from "../types/report";
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

/**
 * ページ別・段別・欄別の信頼度マップ。
 * page → 段インデックス配列 → fieldId → confidence (0.0〜1.0)
 *
 * cells と同じ構造で並走する。セルが手編集されたら該当エントリを削除して
 * 古い信頼度が残らないようにする（変更時クリア方針）。
 */
export type ConfidenceMatrix = Map<number, Array<Map<string, number>>>;

interface ReportState {
  template: ReportTemplate;
  cells: CellMatrix;
  /**
   * OCR 信頼度の並走マップ。cells と同じ page→段index→fieldId 構造。
   * 手編集・段操作で該当エントリをクリアし同期ズレを防ぐ。
   */
  confidences: ConfidenceMatrix;
  mode: EditorMode;
  selectedFieldId: string | null;
  /**
   * ページごとの座標補正オフセット。
   * 既定 (0,0) のページはキーを持たない疎保持（Map に不在 = ZERO_OFFSET）。
   */
  pageOffsets: Map<number, PageOffset>;

  // actions
  /**
   * 全ページの信頼度マップを一括設定する（全ページ OCR 完了後に使用）。
   * setCells 後に呼ぶこと。既存 confidences は完全置換される。
   */
  setConfidences: (matrix: ConfidenceMatrix) => void;
  /**
   * 単一ページの信頼度マップを部分更新する（単一ページ再 OCR 後に使用）。
   * setConfidencesForPage は setCellsForPage と対で呼ぶこと。
   */
  setConfidencesForPage: (pageNum: number, rows: Array<Map<string, number>>) => void;
  addField: (rect: ReportField["rect"], name?: string) => void;
  removeField: (id: string) => void;
  renameField: (id: string, name: string) => void;
  setFieldColor: (id: string, color: string) => void;
  /**
   * 指定 id の欄の isLineItem フラグを設定する。
   * value=true で明細欄（段ごとに繰り返す）、false で固定欄（従来挙動）。
   */
  setFieldLineItem: (id: string, value: boolean) => void;
  clearTemplate: () => void;
  /**
   * PDF差し替え時に PDF固有の抽出データのみ初期化する。
   * cells / confidences / pageOffsets を空にする。
   * template（欄定義）は差し替え後の新PDFでも再利用するため保持する。
   */
  resetExtractedData: () => void;
  setCells: (matrix: CellMatrix) => void;
  setMode: (mode: EditorMode) => void;
  selectField: (id: string | null) => void;
  /**
   * インライン編集確定: 指定ページ・欄・段のセル値を更新する。
   * rowIndex 省略時は 0（先頭段）。段が存在しない場合は新規生成する。
   */
  setCellValue: (pageNum: number, fieldId: string, value: string, rowIndex?: number) => void;
  /**
   * Delete: 指定ページ・欄・段のセル値を空文字にする（キーは残す）。
   * rowIndex 省略時は 0（先頭段）。
   */
  clearCellValue: (pageNum: number, fieldId: string, rowIndex?: number) => void;
  /**
   * ドラッグ値移動: 指定ページ・段内で from の値を to へ移動（既定 swap）。
   * rowIndex 省略時は 0（先頭段）。
   */
  moveCellValue: (pageNum: number, fromFieldId: string, toFieldId: string, mode?: CellMoveMode, rowIndex?: number) => void;
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
   * 指定ページの cells 行を新しい ReportRow[] で全置換する。
   * 他ページの cells は保持される。
   * 単一ページ再 OCR 後の部分更新に使用する。
   */
  setCellsForPage: (pageNum: number, rows: ReportRow | ReportRow[]) => void;
  /**
   * 指定ページの afterRowIndex の直後に空段を挿入する。
   * afterRowIndex = -1 なら先頭に挿入する。
   */
  insertRowAt: (pageNum: number, afterRowIndex: number) => void;
  /**
   * 指定ページの rowIndex の段を削除する。
   * 最後の 1 段は削除しない（no-op）。
   */
  removeRowAt: (pageNum: number, rowIndex: number) => void;
  /**
   * 指定ページ・段・欄の値を splitAt で分割する。
   * 現段の fieldId に slice(0, splitAt) を設定し、
   * rowIndex+1 に新段を挿入して fieldId = slice(splitAt) を設定する。
   * 新段の他欄は空（固定欄も新段にはコピーしない）。
   */
  splitCellToNextRow: (pageNum: number, rowIndex: number, fieldId: string, splitAt: number) => void;
  /**
   * 指定ページ・段・欄の値を改行（\n）で分割する。
   * 先頭セグメントは現段、2 つ目以降は順に新段を挿入して配置する。
   * 空配列・1 要素の場合は何もしない。
   */
  splitCellByNewlines: (pageNum: number, rowIndex: number, fieldId: string) => void;
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

/**
 * ページの段配列を取得する。存在しない場合は空 Map を 1 段持つ配列を返す。
 */
function getPageRows(cells: CellMatrix, pageNum: number): ReportRow[] {
  return cells.get(pageNum) ?? [new Map<string, string>()];
}

/**
 * 指定インデックスの段を取得する。存在しない場合は空 Map を返す。
 */
function getRow(rows: ReportRow[], rowIndex: number): ReportRow {
  return rows[rowIndex] ?? new Map<string, string>();
}

export const useReportStore = create<ReportState>((set) => ({
  template: { fields: [] },
  cells: new Map(),
  confidences: new Map(),
  mode: "idle",
  selectedFieldId: null,
  pageOffsets: new Map(),

  setConfidences: (matrix) => {
    set({ confidences: matrix });
  },

  setConfidencesForPage: (pageNum, rows) => {
    set((state) => {
      const next = new Map(state.confidences);
      next.set(pageNum, rows);
      return { confidences: next };
    });
  },

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

  setFieldLineItem: (id, value) => {
    set((state) => ({
      template: {
        fields: state.template.fields.map((f) =>
          f.id === id ? { ...f, isLineItem: value } : f
        ),
      },
    }));
  },

  clearTemplate: () => {
    set({ template: { fields: [] }, pageOffsets: new Map(), confidences: new Map() });
  },

  resetExtractedData: () => {
    set({ cells: new Map(), confidences: new Map(), pageOffsets: new Map() });
  },

  setCells: (matrix) => {
    // confidence なしの汎用呼び出し: 古い信頼度が残らないよう confidences もクリアする。
    // setConfidences を後から呼ぶことで信頼度を再設定できる。
    set({ cells: matrix, confidences: new Map() });
  },

  setMode: (mode) => {
    set({ mode });
  },

  selectField: (id) => {
    set({ selectedFieldId: id });
  },

  setCellValue: (pageNum, fieldId, value, rowIndex = 0) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      // 段が存在する場合のみ no-op チェック
      if (rowIndex < prevRows.length && prevRows[rowIndex].get(fieldId) === value) return {};
      const nextCells = new Map(state.cells);
      const nextRows = [...prevRows];
      // 段が足りない場合は空段で埋める
      while (nextRows.length <= rowIndex) {
        nextRows.push(new Map<string, string>());
      }
      const nextRow = new Map(nextRows[rowIndex]);
      nextRow.set(fieldId, value);
      nextRows[rowIndex] = nextRow;
      nextCells.set(pageNum, nextRows);

      // 手編集でセルが変わったら該当 (page, rowIndex, fieldId) の信頼度をクリアする
      const prevConfRows = state.confidences.get(pageNum);
      let nextConfidences = state.confidences;
      if (prevConfRows && rowIndex < prevConfRows.length && prevConfRows[rowIndex].has(fieldId)) {
        const nextConfRows = prevConfRows.map((r, i) => {
          if (i !== rowIndex) return r;
          const updated = new Map(r);
          updated.delete(fieldId);
          return updated;
        });
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, nextConfRows);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  clearCellValue: (pageNum, fieldId, rowIndex = 0) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      if (!state.cells.has(pageNum)) return {};
      const prevRow = getRow(prevRows, rowIndex);
      if (prevRow.get(fieldId) === "") return {};
      const nextCells = new Map(state.cells);
      const nextRows = [...prevRows];
      while (nextRows.length <= rowIndex) {
        nextRows.push(new Map<string, string>());
      }
      const nextRow = new Map(nextRows[rowIndex]);
      nextRow.set(fieldId, "");
      nextRows[rowIndex] = nextRow;
      nextCells.set(pageNum, nextRows);

      // 削除でセルが変わったら該当 (page, rowIndex, fieldId) の信頼度をクリアする
      const prevConfRows = state.confidences.get(pageNum);
      let nextConfidences = state.confidences;
      if (prevConfRows && rowIndex < prevConfRows.length && prevConfRows[rowIndex].has(fieldId)) {
        const nextConfRows = prevConfRows.map((r, i) => {
          if (i !== rowIndex) return r;
          const updated = new Map(r);
          updated.delete(fieldId);
          return updated;
        });
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, nextConfRows);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  moveCellValue: (pageNum, fromFieldId, toFieldId, mode = "swap", rowIndex = 0) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const prevRow = getRow(prevRows, rowIndex);
      const nextRow = applyCellMove(prevRow, fromFieldId, toFieldId, mode);
      // applyCellMove が same ref を返した場合は no-op（再描画させない）
      if (nextRow === prevRow) return {};
      const nextCells = new Map(state.cells);
      const nextRows = [...prevRows];
      while (nextRows.length <= rowIndex) {
        nextRows.push(new Map<string, string>());
      }
      nextRows[rowIndex] = nextRow;
      nextCells.set(pageNum, nextRows);

      // ドラッグ移動で from/to 両方の信頼度をクリアする
      const prevConfRows = state.confidences.get(pageNum);
      let nextConfidences = state.confidences;
      if (prevConfRows && rowIndex < prevConfRows.length) {
        const prevConfRow = prevConfRows[rowIndex];
        if (prevConfRow.has(fromFieldId) || prevConfRow.has(toFieldId)) {
          const nextConfRow = new Map(prevConfRow);
          nextConfRow.delete(fromFieldId);
          nextConfRow.delete(toFieldId);
          const nextConfRows = prevConfRows.map((r, i) => (i === rowIndex ? nextConfRow : r));
          nextConfidences = new Map(state.confidences);
          nextConfidences.set(pageNum, nextConfRows);
        }
      }

      return { cells: nextCells, confidences: nextConfidences };
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

  setCellsForPage: (pageNum, rows) => {
    set((state) => {
      const nextCells = new Map(state.cells);
      // ReportRow (Map) 単体が渡された場合は [row] 形に正規化する（後方互換）
      const nextRows: ReportRow[] = Array.isArray(rows)
        ? rows.map((r) => new Map(r))
        : [new Map(rows as ReportRow)];
      nextCells.set(pageNum, nextRows);

      // confidence 無しの汎用呼び出し: 対象ページの古い信頼度をクリアする。
      // setConfidencesForPage を後から呼ぶことで再設定できる。
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  insertRowAt: (pageNum, afterRowIndex) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const nextRows = [...prevRows];
      const insertIdx = afterRowIndex + 1;
      nextRows.splice(insertIdx, 0, new Map<string, string>());
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // 段構造が変わるのでそのページの confidences を丸ごと削除する（アライン保証のため）
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  removeRowAt: (pageNum, rowIndex) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      // 最後の 1 段は削除しない
      if (prevRows.length <= 1) return {};
      const nextRows = prevRows.filter((_, i) => i !== rowIndex);
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // 段構造が変わるのでそのページの confidences を丸ごと削除する（アライン保証のため）
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  splitCellToNextRow: (pageNum, rowIndex, fieldId, splitAt) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const prevRow = getRow(prevRows, rowIndex);
      const value = prevRow.get(fieldId) ?? "";
      const before = value.slice(0, splitAt);
      const after = value.slice(splitAt);

      const nextRows = [...prevRows];
      while (nextRows.length <= rowIndex) {
        nextRows.push(new Map<string, string>());
      }

      // 現段を更新（before を設定）
      const updatedCurrentRow = new Map(nextRows[rowIndex]);
      updatedCurrentRow.set(fieldId, before);
      nextRows[rowIndex] = updatedCurrentRow;

      // rowIndex+1 に新段を挿入（after を設定。他欄は空）
      const newRow = new Map<string, string>();
      newRow.set(fieldId, after);
      nextRows.splice(rowIndex + 1, 0, newRow);

      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // 段構造が変わるのでそのページの confidences を丸ごと削除する（アライン保証のため）
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },

  splitCellByNewlines: (pageNum, rowIndex, fieldId) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const prevRow = getRow(prevRows, rowIndex);
      const value = prevRow.get(fieldId) ?? "";
      const segments = value.split("\n");

      // 空配列・1 要素は何もしない
      if (segments.length <= 1) return {};

      const nextRows = [...prevRows];
      while (nextRows.length <= rowIndex) {
        nextRows.push(new Map<string, string>());
      }

      // 先頭セグメントは現段に設定
      const updatedCurrentRow = new Map(nextRows[rowIndex]);
      updatedCurrentRow.set(fieldId, segments[0]);
      nextRows[rowIndex] = updatedCurrentRow;

      // 2 つ目以降は新段を順に挿入
      for (let i = 1; i < segments.length; i++) {
        const newRow = new Map<string, string>();
        newRow.set(fieldId, segments[i]);
        nextRows.splice(rowIndex + i, 0, newRow);
      }

      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // 段構造が変わるのでそのページの confidences を丸ごと削除する（アライン保証のため）
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }

      return { cells: nextCells, confidences: nextConfidences };
    });
  },
}));
