import type { CellMatrix, PageOffset, ReportField } from "../types/report";
import type { ConfidenceMatrix, EditedMatrix } from "../store/reportStore";

/**
 * 作業セッションのシリアライズ/デシリアライズ（純関数）。
 *
 * 「アプリを閉じたら OCR 結果・手修正が全部消える」対策として、作業状態一式を
 * JSON 化して %APPDATA%/session/current.json（Rust 側 save_session）へ保存する。
 * Map/Set は JSON にできないためエントリ配列へ相互変換する。
 * スキーマは version を持ち、未知バージョン・構造不正は ok:false で拒否する
 * （壊れたセッションで起動が死ぬより「復元なし」に倒す）。
 */

export const SESSION_SCHEMA_VERSION = 1;

/** 保存側入力: 現在の store 状態のうち復元に必要な一式 */
export interface SessionInput {
  pdfPath: string;
  savedAt: string; // ISO 8601
  rotation: number;
  fields: ReportField[];
  cells: CellMatrix;
  confidences: ConfidenceMatrix;
  edited: EditedMatrix;
  pageOffsets: Map<number, PageOffset>;
  excludedPages: Set<number>;
}

/** 復元側出力: store へ流し込める形（Map/Set 再構築済み） */
export interface DecodedSession {
  pdfPath: string;
  savedAt: string;
  rotation: number;
  fields: ReportField[];
  cells: CellMatrix;
  confidences: ConfidenceMatrix;
  edited: EditedMatrix;
  pageOffsets: Map<number, PageOffset>;
  excludedPages: Set<number>;
}

export type DecodeResult =
  | { ok: true; session: DecodedSession }
  | { ok: false; reason: string };

export function serializeSession(input: SessionInput): string {
  return JSON.stringify({
    version: SESSION_SCHEMA_VERSION,
    savedAt: input.savedAt,
    pdfPath: input.pdfPath,
    rotation: input.rotation,
    fields: input.fields,
    cells: Array.from(input.cells.entries()).map(([page, rows]) => [
      page,
      rows.map((row) => Array.from(row.entries())),
    ]),
    confidences: Array.from(input.confidences.entries()).map(([page, rows]) => [
      page,
      rows.map((row) => Array.from(row.entries())),
    ]),
    edited: Array.from(input.edited.entries()).map(([page, rows]) => [
      page,
      rows.map((set) => Array.from(set.values())),
    ]),
    pageOffsets: Array.from(input.pageOffsets.entries()),
    excludedPages: Array.from(input.excludedPages.values()),
  });
}

export function deserializeSession(json: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "セッションファイルが JSON として読めません" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "セッションの構造が不正です" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== SESSION_SCHEMA_VERSION) {
    return { ok: false, reason: `未対応のセッションバージョンです: ${String(obj.version)}` };
  }
  if (typeof obj.pdfPath !== "string" || obj.pdfPath === "") {
    return { ok: false, reason: "pdfPath がありません" };
  }
  if (typeof obj.savedAt !== "string") {
    return { ok: false, reason: "savedAt がありません" };
  }
  if (typeof obj.rotation !== "number") {
    return { ok: false, reason: "rotation がありません" };
  }
  if (!Array.isArray(obj.fields)) {
    return { ok: false, reason: "fields がありません" };
  }

  try {
    const cells: CellMatrix = new Map(
      (obj.cells as Array<[number, Array<Array<[string, string]>>]>).map(([page, rows]) => [
        page,
        rows.map((row) => new Map(row)),
      ])
    );
    const confidences: ConfidenceMatrix = new Map(
      (obj.confidences as Array<[number, Array<Array<[string, number]>>]>).map(
        ([page, rows]) => [page, rows.map((row) => new Map(row))]
      )
    );
    const edited: EditedMatrix = new Map(
      (obj.edited as Array<[number, string[][]]>).map(([page, rows]) => [
        page,
        rows.map((ids) => new Set(ids)),
      ])
    );
    const pageOffsets = new Map(obj.pageOffsets as Array<[number, PageOffset]>);
    const excludedPages = new Set(obj.excludedPages as number[]);

    return {
      ok: true,
      session: {
        pdfPath: obj.pdfPath,
        savedAt: obj.savedAt,
        rotation: obj.rotation,
        fields: obj.fields as ReportField[],
        cells,
        confidences,
        edited,
        pageOffsets,
        excludedPages,
      },
    };
  } catch {
    return { ok: false, reason: "セッションのデータ部が復元できません" };
  }
}
