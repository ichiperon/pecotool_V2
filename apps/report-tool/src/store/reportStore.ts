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

/**
 * ページ別・段別の手修正フラグ。page → 段インデックス配列 → 手修正済み fieldId の集合。
 * confidences と対称の並走構造。配列がセルの段数より短い場合、範囲外の段は「フラグなし」。
 * OCR 再取り込み（setCells / setCellsForPage）で該当範囲をクリアする。
 */
export type EditedMatrix = Map<number, Array<Set<string>>>;

/**
 * Undo/Redo 用スナップショット。対象は PDF 固有の抽出・編集データ 4 スライスのみ
 * （template は対象外 — テンプレ変更は undo できない）。
 * 全ミューテーションが immutable 再構築のため、参照を束ねるだけで安価（構造共有）。
 */
export interface HistorySnapshot {
  cells: CellMatrix;
  confidences: ConfidenceMatrix;
  edited: EditedMatrix;
  pageOffsets: Map<number, PageOffset>;
}

/** Undo 履歴の上限件数（超過時は最古を破棄）。 */
export const HISTORY_LIMIT = 50;

interface ReportState {
  template: ReportTemplate;
  cells: CellMatrix;
  /**
   * OCR 信頼度の並走マップ。cells と同じ page→段index→fieldId 構造。
   * 手編集・段操作で該当エントリをクリアし同期ズレを防ぐ。
   */
  confidences: ConfidenceMatrix;
  /**
   * 手修正フラグの並走マップ。人が編集・削除・移動・分割で触ったセルの印。
   * confidence クリア（OCR の自信を消す）と対称に「人が保証した」を立てる。
   */
  edited: EditedMatrix;
  /**
   * Undo 履歴（古い→新しい）。undoable アクションの実行直前スナップショットを積む。
   * テンプレ置換・OCR 取り込み等のロード境界でクリアされる（stale 復元防止）。
   */
  past: HistorySnapshot[];
  /** Redo 履歴。undo で積まれ、新たな undoable アクションでクリアされる。 */
  future: HistorySnapshot[];
  /**
   * 直前に履歴を積んだ操作の合流タグ（内部用・スナップショット対象外）。
   * nudge 連打（矢印キーリピート）が1押下=1エントリで HISTORY_LIMIT を押し流すのを防ぐため、
   * 同一タグの連続操作は直前エントリに合流させる（1ユーザー意図=1エントリ）。
   * タグなし操作・undo/redo・ロード境界で null に戻り、合流が途切れる。
   */
  lastUndoableTag: string | null;
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
  /**
   * 欄テンプレートライブラリからの読み込み等、template を丸ごと置き換える。
   * 旧 fieldId に紐づく cells / confidences / pageOffsets / selectedFieldId を同一 set() 内で
   * 原子的に破棄する（孤児セル・孤児選択が CSV/プレビューに残るのを防ぐ）。
   */
  replaceTemplateFields: (fields: ReportField[]) => void;
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
  /**
   * 直前の undoable 操作（セル編集・削除・移動・段操作・オフセット調整）を取り消す。
   * cells / confidences / edited / pageOffsets を操作前のスナップショットへ戻す。
   * 履歴が空なら no-op。
   */
  undo: () => void;
  /** undo で戻した操作をやり直す。future が空なら no-op。 */
  redo: () => void;
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

/**
 * PDF固有の抽出データ（cells/confidences/pageOffsets）を空にする差分オブジェクトを生成する。
 * resetExtractedData / replaceTemplateFields が共有する（破棄ロジックの重複回避）。
 * 呼び出しごとに新しい Map インスタンスを返す。
 */
function clearedExtractedDataPatch(): Pick<
  ReportState,
  "cells" | "confidences" | "edited" | "pageOffsets"
> {
  return { cells: new Map(), confidences: new Map(), edited: new Map(), pageOffsets: new Map() };
}

/** 現在 state から undo スナップショットを作る（参照束・ディープコピーなし）。 */
function snapshotOf(state: ReportState): HistorySnapshot {
  return {
    cells: state.cells,
    confidences: state.confidences,
    edited: state.edited,
    pageOffsets: state.pageOffsets,
  };
}

/**
 * undoable アクションのコミット: patch に「実行直前スナップショットの past 積み＋
 * future クリア」を合成して返す。no-op 経路（return {}）では呼ばないこと —
 * state が変わらないのに履歴だけ積まれ、Ctrl+Z が「何も起きない」空振りになる。
 */
function withHistory(
  state: ReportState,
  patch: Partial<ReportState>,
  tag: string | null = null
): Partial<ReportState> {
  // 同一タグの連続操作（nudge 連打等）は直前エントリに合流: past を積み直さず
  // 既存の先頭エントリ（連続操作の開始前 state）を undo 先として共有する。
  if (tag !== null && tag === state.lastUndoableTag && state.past.length > 0) {
    return { ...patch, future: [], lastUndoableTag: tag };
  }
  const past = [...state.past, snapshotOf(state)];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { ...patch, past, future: [], lastUndoableTag: tag };
}

/**
 * 履歴を全消去する差分。テンプレ置換・OCR 取り込み等の「ロード境界」で使う。
 * 境界を跨いだスナップショットを復元すると、孤児 fieldId や取り込み前の古い値が
 * 無警告で復活するため、境界では履歴ごと捨てるのが安全。
 */
function historyClearPatch(): Pick<ReportState, "past" | "future" | "lastUndoableTag"> {
  return { past: [], future: [], lastUndoableTag: null };
}

/** edited のページ行配列を minLength 段まで空 Set で埋めたコピーを返す。 */
function paddedEditedRows(
  edited: EditedMatrix,
  pageNum: number,
  minLength: number
): Array<Set<string>> {
  const rows = [...(edited.get(pageNum) ?? [])];
  while (rows.length < minLength) rows.push(new Set<string>());
  return rows;
}

/** 指定セル群に手修正フラグを立てた新しい EditedMatrix を返す。 */
function markEdited(
  edited: EditedMatrix,
  pageNum: number,
  rowIndex: number,
  fieldIds: readonly string[]
): EditedMatrix {
  const rows = paddedEditedRows(edited, pageNum, rowIndex + 1);
  const nextSet = new Set(rows[rowIndex]);
  for (const id of fieldIds) nextSet.add(id);
  rows[rowIndex] = nextSet;
  const next = new Map(edited);
  next.set(pageNum, rows);
  return next;
}

export const useReportStore = create<ReportState>((set) => ({
  template: { fields: [] },
  cells: new Map(),
  confidences: new Map(),
  edited: new Map(),
  past: [],
  future: [],
  lastUndoableTag: null,
  mode: "idle",
  selectedFieldId: null,
  pageOffsets: new Map(),

  setConfidences: (matrix) => {
    // OCR 取り込み系＝ロード境界。境界前のスナップショット復元を防ぐため履歴を捨てる。
    set({ confidences: matrix, ...historyClearPatch() });
  },

  setConfidencesForPage: (pageNum, rows) => {
    set((state) => {
      const next = new Map(state.confidences);
      next.set(pageNum, rows);
      return { confidences: next, ...historyClearPatch() };
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
    // cells も含めて全消去する。旧実装は cells だけ残す非対称で、
    // 孤児 fieldId の値が無効なまま残留していた（レビュー指摘の既存問題）。
    // selectedFieldId も replaceTemplateFields と同じ理由（孤児選択防止）でクリアする。
    set({
      template: { fields: [] },
      selectedFieldId: null,
      ...clearedExtractedDataPatch(),
      ...historyClearPatch(),
    });
  },

  resetExtractedData: () => {
    set({ ...clearedExtractedDataPatch(), ...historyClearPatch() });
  },

  replaceTemplateFields: (fields) => {
    set({
      template: { fields },
      // 差し替え前に選択していた欄idは新テンプレートに存在しない可能性が高い。
      // removeField が選択中idの欄を消す際に selectedFieldId をクリアするのと対称に、
      // ここでも孤児選択（存在しないidが選択されたまま）を防ぐ。
      selectedFieldId: null,
      ...clearedExtractedDataPatch(),
      ...historyClearPatch(),
    });
  },

  setCells: (matrix) => {
    // confidence なしの汎用呼び出し: 古い信頼度・手修正フラグが残らないよう両方クリアする。
    // setConfidences を後から呼ぶことで信頼度を再設定できる。
    // OCR 取り込み＝ロード境界なので undo 履歴も捨てる。
    set({ cells: matrix, confidences: new Map(), edited: new Map(), ...historyClearPatch() });
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

      // 信頼度クリアと対称に、手修正フラグを立てる
      const nextEdited = markEdited(state.edited, pageNum, rowIndex, [fieldId]);

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
    });
  },

  clearCellValue: (pageNum, fieldId, rowIndex = 0) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      if (!state.cells.has(pageNum)) return {};
      const prevRow = getRow(prevRows, rowIndex);
      // エントリ未存在（undefined）も表示上は同じ「(空)」なので no-op に含める。
      // undefined→"" の書き込みを許すと、見た目が変わらないのに手修正バッジと
      // 履歴エントリだけが積まれる（Ctrl+Z の空振り段になる）。
      if ((prevRow.get(fieldId) ?? "") === "") return {};
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

      // 人が意図して空にした＝手修正としてフラグを立てる
      const nextEdited = markEdited(state.edited, pageNum, rowIndex, [fieldId]);

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
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

      // 移動で from/to 両セルとも人の判断が入った＝両方に手修正フラグ
      const nextEdited = markEdited(state.edited, pageNum, rowIndex, [fromFieldId, toFieldId]);

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
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
      return withHistory(state, { pageOffsets: next });
    });
  },

  nudgePageOffset: (pageNum, ddx, ddy) => {
    set((state) => {
      // no-op: 変位ゼロ（履歴に空エントリを積まない）
      if (ddx === 0 && ddy === 0) return {};
      const prev = state.pageOffsets.get(pageNum) ?? ZERO_OFFSET;
      const nextDx = prev.dx + ddx;
      const nextDy = prev.dy + ddy;
      const next = new Map(state.pageOffsets);
      if (nextDx === 0 && nextDy === 0) {
        next.delete(pageNum);
      } else {
        next.set(pageNum, { dx: nextDx, dy: nextDy });
      }
      // 同一ページへの nudge 連打（矢印キーリピート）は1エントリに合流:
      // 30px 動かす=30エントリで HISTORY_LIMIT が押し流されるのを防ぎ、
      // Ctrl+Z 1回でひと続きの微調整がまとめて戻る。
      return withHistory(state, { pageOffsets: next }, `nudge:${pageNum}`);
    });
  },

  clearPageOffset: (pageNum) => {
    set((state) => {
      if (!state.pageOffsets.has(pageNum)) return {};
      const next = new Map(state.pageOffsets);
      next.delete(pageNum);
      return withHistory(state, { pageOffsets: next });
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

      // confidence 無しの汎用呼び出し: 対象ページの古い信頼度・手修正フラグをクリアする。
      // setConfidencesForPage を後から呼ぶことで再設定できる。
      let nextConfidences = state.confidences;
      if (state.confidences.has(pageNum)) {
        nextConfidences = new Map(state.confidences);
        nextConfidences.delete(pageNum);
      }
      let nextEdited = state.edited;
      if (state.edited.has(pageNum)) {
        nextEdited = new Map(state.edited);
        nextEdited.delete(pageNum);
      }

      // 再 OCR 取り込み＝ロード境界。undo 履歴も捨てる（境界を跨ぐ復元を防ぐ）。
      return {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
        ...historyClearPatch(),
      };
    });
  },

  insertRowAt: (pageNum, afterRowIndex) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const nextRows = [...prevRows];
      // splice の負 index は配列長基準で解決されるため、cells/confidences/edited の
      // 長さが異なるとリマップがずれる。0 でクランプして3配列の挿入位置を揃える。
      const insertIdx = Math.max(0, afterRowIndex + 1);
      nextRows.splice(insertIdx, 0, new Map<string, string>());
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // confidences は挿入位置に空 Map を差し込んで段 index を揃える（リマップ）。
      // 旧実装のページ丸ごと破棄は、触っていないセルの低信頼ハイライトまで消す
      // 情報損失だった（レビュー指摘）。挿入位置が配列長を超える場合、既存の
      // 信頼度はすべて挿入位置より手前にありシフト不要（範囲外の段は「情報なし」）。
      let nextConfidences = state.confidences;
      const prevConfRows = state.confidences.get(pageNum);
      if (prevConfRows && insertIdx <= prevConfRows.length) {
        const confRows = [...prevConfRows];
        confRows.splice(insertIdx, 0, new Map<string, number>());
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, confRows);
      }

      // edited も同じリマップ（挿入位置に空 Set を差し込む）
      let nextEdited = state.edited;
      const prevEditedRows = state.edited.get(pageNum);
      if (prevEditedRows && insertIdx <= prevEditedRows.length) {
        const editedRows = [...prevEditedRows];
        editedRows.splice(insertIdx, 0, new Set<string>());
        nextEdited = new Map(state.edited);
        nextEdited.set(pageNum, editedRows);
      }

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
    });
  },

  removeRowAt: (pageNum, rowIndex) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      // 最後の 1 段は削除しない
      if (prevRows.length <= 1) return {};
      // 範囲外 index は no-op。素通しすると filter は何も除去しないのに
      // 履歴 push だけが実行され、幻の undo 段が生まれる。
      if (rowIndex < 0 || rowIndex >= prevRows.length) return {};
      const nextRows = prevRows.filter((_, i) => i !== rowIndex);
      const nextCells = new Map(state.cells);
      nextCells.set(pageNum, nextRows);

      // confidences は削除段の index を落としてリマップ（insertRowAt と対称）。
      // 残る段の信頼度ハイライトを保持する。
      let nextConfidences = state.confidences;
      const prevConfRows = state.confidences.get(pageNum);
      if (prevConfRows && rowIndex < prevConfRows.length) {
        const confRows = prevConfRows.filter((_, i) => i !== rowIndex);
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, confRows);
      }

      // edited も同じリマップ
      let nextEdited = state.edited;
      const prevEditedRows = state.edited.get(pageNum);
      if (prevEditedRows && rowIndex < prevEditedRows.length) {
        const editedRows = prevEditedRows.filter((_, i) => i !== rowIndex);
        nextEdited = new Map(state.edited);
        nextEdited.set(pageNum, editedRows);
      }

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
    });
  },

  splitCellToNextRow: (pageNum, rowIndex, fieldId, splitAt) => {
    set((state) => {
      const prevRows = getPageRows(state.cells, pageNum);
      const prevRow = getRow(prevRows, rowIndex);
      const value = prevRow.get(fieldId) ?? "";
      // 空値は分割するものがない: 空段だけが挿入され履歴も積まれるので no-op にする
      if (value === "") return {};
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

      // confidences リマップ: 分割した欄は値が変わるので現段から信頼度を落とし、
      // 同段の他欄は保持。挿入位置に空 Map を差し込んで段 index を揃える。
      let nextConfidences = state.confidences;
      const prevConfRows = state.confidences.get(pageNum);
      if (prevConfRows && rowIndex < prevConfRows.length) {
        const confRows = [...prevConfRows];
        const curConf = new Map(confRows[rowIndex]);
        curConf.delete(fieldId);
        confRows[rowIndex] = curConf;
        confRows.splice(rowIndex + 1, 0, new Map<string, number>());
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, confRows);
      }

      // 分割は人の再構成操作: 現段・新段の両断片に手修正フラグを立て、
      // 挿入位置に Set を差し込んで段 index を揃える
      const editedRows = paddedEditedRows(state.edited, pageNum, rowIndex + 1);
      const curSet = new Set(editedRows[rowIndex]);
      curSet.add(fieldId);
      editedRows[rowIndex] = curSet;
      editedRows.splice(rowIndex + 1, 0, new Set([fieldId]));
      const nextEdited = new Map(state.edited);
      nextEdited.set(pageNum, editedRows);

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
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

      // confidences リマップ: splitCellToNextRow と同方針（分割欄の信頼度は落とし
      // 他欄は保持・新段分の空 Map をブロック挿入）
      let nextConfidences = state.confidences;
      const prevConfRows = state.confidences.get(pageNum);
      if (prevConfRows && rowIndex < prevConfRows.length) {
        const confRows = [...prevConfRows];
        const curConf = new Map(confRows[rowIndex]);
        curConf.delete(fieldId);
        confRows[rowIndex] = curConf;
        const newConfMaps = segments.slice(1).map(() => new Map<string, number>());
        confRows.splice(rowIndex + 1, 0, ...newConfMaps);
        nextConfidences = new Map(state.confidences);
        nextConfidences.set(pageNum, confRows);
      }

      // 一括分割も人の再構成操作: 全断片（現段＋新段すべて）に手修正フラグ
      const editedRows = paddedEditedRows(state.edited, pageNum, rowIndex + 1);
      const curSet = new Set(editedRows[rowIndex]);
      curSet.add(fieldId);
      editedRows[rowIndex] = curSet;
      const newSets = segments.slice(1).map(() => new Set([fieldId]));
      editedRows.splice(rowIndex + 1, 0, ...newSets);
      const nextEdited = new Map(state.edited);
      nextEdited.set(pageNum, editedRows);

      return withHistory(state, {
        cells: nextCells,
        confidences: nextConfidences,
        edited: nextEdited,
      });
    });
  },

  undo: () => {
    set((state) => {
      const prev = state.past[state.past.length - 1];
      if (!prev) return {};
      return {
        cells: prev.cells,
        confidences: prev.confidences,
        edited: prev.edited,
        pageOffsets: prev.pageOffsets,
        past: state.past.slice(0, -1),
        // 現在 state を future へ積む（redo 用）。future の深さは past 由来なので
        // HISTORY_LIMIT を超えない。
        future: [...state.future, snapshotOf(state)],
        // undo を挟んだら nudge 合流を打ち切る（合流先エントリがもう対応しない）
        lastUndoableTag: null,
      };
    });
  },

  redo: () => {
    set((state) => {
      const next = state.future[state.future.length - 1];
      if (!next) return {};
      return {
        cells: next.cells,
        confidences: next.confidences,
        edited: next.edited,
        pageOffsets: next.pageOffsets,
        past: [...state.past, snapshotOf(state)],
        future: state.future.slice(0, -1),
        lastUndoableTag: null,
      };
    });
  },
}));
