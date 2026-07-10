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
 *
 * v2 (#446 / #447): pdfFingerprint（PDF バイト列の SHA-256）と diagnostics
 * （OCR 失敗ページ等の警告状態）を追加した。v1 セッションは ok:false で拒否する
 * （壊れたセッションより復元なしに倒す既存方針どおり。v1 セッションは一度だけ
 * 復元不可になるが、誤復元＝データ汚染より安全）。
 */

export const SESSION_SCHEMA_VERSION = 2;

/** OCR 診断状態（失敗ページ・レイアウト混在）。reportStore の undo 対象外スライスと対応。 */
export interface SessionDiagnostics {
  failedPages: number[];
  layoutMismatchPages: number[];
  layoutBasePage: number | null;
}

/** 保存側入力: 現在の store 状態のうち復元に必要な一式 */
export interface SessionInput {
  pdfPath: string;
  /** PDF バイト列の SHA-256（16進文字列）。パスだけでは区別できない「中身が違う同名PDF」の判定に使う。 */
  pdfFingerprint: string;
  savedAt: string; // ISO 8601
  rotation: number;
  fields: ReportField[];
  cells: CellMatrix;
  confidences: ConfidenceMatrix;
  edited: EditedMatrix;
  pageOffsets: Map<number, PageOffset>;
  excludedPages: Set<number>;
  diagnostics: SessionDiagnostics;
}

/** 復元側出力: store へ流し込める形（Map/Set 再構築済み） */
export interface DecodedSession {
  pdfPath: string;
  pdfFingerprint: string;
  savedAt: string;
  rotation: number;
  fields: ReportField[];
  cells: CellMatrix;
  confidences: ConfidenceMatrix;
  edited: EditedMatrix;
  pageOffsets: Map<number, PageOffset>;
  excludedPages: Set<number>;
  diagnostics: SessionDiagnostics;
}

export type DecodeResult =
  | { ok: true; session: DecodedSession }
  | { ok: false; reason: string };

export function serializeSession(input: SessionInput): string {
  return JSON.stringify({
    version: SESSION_SCHEMA_VERSION,
    savedAt: input.savedAt,
    pdfPath: input.pdfPath,
    pdfFingerprint: input.pdfFingerprint,
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
    diagnostics: {
      failedPages: input.diagnostics.failedPages,
      layoutMismatchPages: input.diagnostics.layoutMismatchPages,
      layoutBasePage: input.diagnostics.layoutBasePage,
    },
  });
}

/** ページ番号として妥当な値か（1始まりの整数）。レビューLOW: number 型だけでなく値域も締める。 */
function isValidPageNumber(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1;
}

/** diagnostics フィールドの値レベル検証。number[] / number[] / number|null の形を確認する。 */
function isValidDiagnostics(value: unknown): value is SessionDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (!Array.isArray(d.failedPages) || !d.failedPages.every(isValidPageNumber)) {
    return false;
  }
  if (!Array.isArray(d.layoutMismatchPages) || !d.layoutMismatchPages.every(isValidPageNumber)) {
    return false;
  }
  if (d.layoutBasePage !== null && !isValidPageNumber(d.layoutBasePage)) {
    return false;
  }
  return true;
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
  if (typeof obj.pdfFingerprint !== "string" || obj.pdfFingerprint === "") {
    return { ok: false, reason: "pdfFingerprint がありません" };
  }
  if (typeof obj.savedAt !== "string") {
    return { ok: false, reason: "savedAt がありません" };
  }
  // rotation は 90°刻みのみ許容。任意角が store に入ると PdfViewer の回転幾何
  //（W/H スワップ前提）が壊れる（レビューMEDIUM: 値レベル検証）
  if (
    typeof obj.rotation !== "number" ||
    ![0, 90, 180, 270].includes(obj.rotation)
  ) {
    return { ok: false, reason: "rotation が不正です" };
  }
  if (!Array.isArray(obj.fields)) {
    return { ok: false, reason: "fields がありません" };
  }
  // fields の最低限の形（id/name が string・rect がオブジェクト）を検証する。
  // as キャスト素通しだと null 要素等が store に入り描画で落ちる
  for (const f of obj.fields as unknown[]) {
    if (
      typeof f !== "object" ||
      f === null ||
      typeof (f as { id?: unknown }).id !== "string" ||
      typeof (f as { name?: unknown }).name !== "string" ||
      typeof (f as { rect?: unknown }).rect !== "object" ||
      (f as { rect?: unknown }).rect === null
    ) {
      return { ok: false, reason: "fields の要素が不正です" };
    }
  }
  if (!isValidDiagnostics(obj.diagnostics)) {
    return { ok: false, reason: "diagnostics が不正です" };
  }

  try {
    const cells: CellMatrix = new Map(
      (obj.cells as Array<[number, Array<Array<[string, string]>>]>).map(([page, rows]) => [
        page,
        rows.map(
          (row) =>
            new Map(
              row.map(([k, v]) => {
                // セル値は string のみ。数値等が混入すると CSV/編集の string 前提で落ちる
                if (typeof k !== "string" || typeof v !== "string") {
                  throw new Error("cell value must be string");
                }
                return [k, v] as [string, string];
              })
            )
        ),
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
    const diagnostics = obj.diagnostics as SessionDiagnostics;

    return {
      ok: true,
      session: {
        pdfPath: obj.pdfPath,
        pdfFingerprint: obj.pdfFingerprint,
        savedAt: obj.savedAt,
        rotation: obj.rotation,
        fields: obj.fields as ReportField[],
        cells,
        confidences,
        edited,
        pageOffsets,
        excludedPages,
        diagnostics,
      },
    };
  } catch {
    return { ok: false, reason: "セッションのデータ部が復元できません" };
  }
}
