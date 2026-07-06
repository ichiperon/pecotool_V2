import type { CellMatrix, CsvOptions, ReportTemplate } from "../types/report";
import { normalizeNumeric } from "./normalize";

/**
 * CSV Formula Injection の起点となる先頭文字。
 * Excel / 会計ソフトがこれらで始まるセルを数式と解釈する。
 *
 * 半角トリガ: = + - @ タブ CR LF
 * 全角トリガ: ＝(U+FF1D) ＋(U+FF0B) －(U+FF0D) ＠(U+FF20)
 * （OWASP の危険文字リストに全角も明記されている）
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r\n＝＋－＠]/;

/**
 * 正当な数値パターン。経理の負数（-50000）や正数（+12.5）、負のパーセント（-8%）を
 * 中和しないために使う。マイナス/プラス符号は1文字まで、残りは数字と小数点、末尾の
 * パーセント記号は1個まで。
 *
 * ※ normalizeNumeric の isNumericLike（/^-?\d+(\.\d+)?%?$/）と整合させる（#395 / PCT-164）。
 *   normalizeNumeric は △8% → -8% を返すため、% を許容しないと -8% が '-8% に中和され
 *   CSV 値が破壊される。"=" "@" 等の真の数式トリガは依然 SAFE_NUMERIC に一致しないので
 *   formula injection 防御は維持される。
 */
const SAFE_NUMERIC = /^[-+]?\d+(\.\d+)?%?$/;

/**
 * 判定用の先頭文字 strip パターン。
 * 攻撃者が FORMULA_TRIGGERS を回避するために先頭に挿入しうる文字を除去する。
 *
 * 対象（明示リスト）:
 *   U+0020（半角スペース）
 *   U+3000（全角スペース）
 *   U+00A0（NBSP: ノーブレークスペース）
 *   U+200B〜U+200F（ゼロ幅スペース等）
 *   U+202A〜U+202E（BiDi 埋め込み制御）
 *   U+2060（ワードジョイナー）
 *   U+FEFF（BOM / ゼロ幅ノーブレークスペース）
 *
 * ※ タブ(U+0009)・LF(U+000A)・CR(U+000D) はそれ自体が FORMULA_TRIGGERS に含まれるため
 *   strip 対象から除外する。\s で一括 strip すると「タブで始まる値」が見えなくなる。
 * ※ 出力値は変更しない。strip は危険判定にのみ使う（既存設計を踏襲）。
 */
const LEADING_STRIP = /^[ 　 ​-‏‪-‮⁠﻿]+/;

/**
 * RFC4180 準拠の CSV セル引用。Formula Injection 対策付き。
 *
 * 処理順:
 * 1. 先頭の空白類・不可視文字（ゼロ幅・BiDi 制御・NBSP 等）を strip した
 *    判定用文字列を作成する。※ 出力値は元のまま。strip は危険判定のためにのみ使う。
 * 2. 判定用文字列が FORMULA_TRIGGERS に該当し、かつ SAFE_NUMERIC でない場合は
 *    元の値の先頭に ' を前置して数式解釈を防ぐ。
 * 3. カンマ・改行・ダブルクオートを含む値は RFC4180 の "" で囲む。
 */
export function csvQuote(s: string): string {
  // 判定用: 先頭の空白類・不可視文字を strip した文字列（出力には使わない）
  const stripped = s.replace(LEADING_STRIP, "");

  let v = s;
  // Formula Injection 中和: 不可視文字除去後の先頭がトリガ文字で、かつ正当な数値でない場合のみ ' を前置
  if (FORMULA_TRIGGERS.test(stripped) && !SAFE_NUMERIC.test(stripped)) {
    v = "'" + v;
  }

  if (/[,"\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * 横持ち CSV 文字列を生成する。明細欄ありの場合は縦持ち展開する。
 *
 * 列順（固定・変更不可）:
 *   [元ファイル名 (includeFileName=true 時)] ,
 *   [ページ番号 (includePageNumber=true 時)] ,
 *   各 field（template.fields の定義順）
 *
 * 固定列を先頭にすることで、欄の追加時に会計ソフト側の列位置がずれない。
 *
 * 縦持ち展開ルール（明細欄が 1 個以上の場合）:
 *   - 固定欄の列値は常に rows[0] から取る（各行に複製）。
 *   - 明細欄の列値はその段（row）から取る。
 *   - 全明細欄が空の段はスキップする。
 *   - スキップ後に 0 段になった場合は rows[0] から 1 行だけ出力（固定欄のみ・ページを落とさない）。
 *
 * 明細欄が 0 個の場合:
 *   rows[0]（無ければ空 Map）から 1 行だけ生成する。現行と完全一致（バイト等価）。
 *
 * @param template    帳票テンプレート（fields の順序が列順を決める）
 * @param cells       抽出結果マトリクス（ページ番号 → ReportRow[] ）
 * @param opts        CSV 出力オプション
 * @param meta        メタ情報（ファイル名・出力対象ページ番号の配列）
 */
export function buildTemplateCsv(
  template: ReportTemplate,
  cells: CellMatrix,
  opts: CsvOptions,
  meta: { fileName?: string; pageNumbers: number[] }
): string {
  const { includeFileName, includePageNumber, emptyValue, normalizeNumbers } =
    opts;

  // ヘッダ行の構築
  const headerCols: string[] = [];
  if (includeFileName) headerCols.push("ファイル名");
  if (includePageNumber) headerCols.push("ページ");

  // 欄名（空名は "範囲{n}" でフォールバック）
  const fieldHeaders = template.fields.map((f, i) =>
    f.name.trim() !== "" ? f.name : `範囲${i + 1}`
  );
  headerCols.push(...fieldHeaders);

  const headerRow = headerCols.map(csvQuote).join(",");

  // 明細欄の有無を判定
  const lineItemFields = template.fields.filter((f) => f.isLineItem === true);
  const hasLineItems = lineItemFields.length > 0;

  /**
   * 1 段（row）から CSV 列配列を生成するヘルパー。
   * fixedRow: 固定欄の値を取得するための段（rows[0]）
   * itemRow:  明細欄の値を取得するための段（現在の段）
   */
  function buildRowCols(
    pageNum: number,
    fixedRow: Map<string, string>,
    itemRow: Map<string, string>
  ): string[] {
    const cols: string[] = [];

    // 固定列（正規化しない）
    if (includeFileName) {
      cols.push(csvQuote(meta.fileName ?? ""));
    }
    if (includePageNumber) {
      cols.push(csvQuote(String(pageNum)));
    }

    // 各フィールドのセル値
    for (const field of template.fields) {
      // 固定欄は fixedRow から、明細欄は itemRow から取得
      const sourceRow = (hasLineItems && field.isLineItem) ? itemRow : fixedRow;
      const raw = sourceRow.get(field.id) ?? emptyValue;
      const value = normalizeNumbers ? normalizeNumeric(raw) : raw;
      cols.push(csvQuote(value));
    }

    return cols;
  }

  // データ行の構築
  const dataRows: string[] = [];

  for (const pageNum of meta.pageNumbers) {
    const pageRows = cells.get(pageNum);

    if (!hasLineItems) {
      // 明細欄なし: 従来どおり rows[0]（無ければ空 Map）から 1 行
      const row = pageRows?.[0] ?? new Map<string, string>();
      dataRows.push(buildRowCols(pageNum, row, row).join(","));
    } else {
      // 明細欄あり: 縦持ち展開
      const rows = pageRows ?? [new Map<string, string>()];
      const fixedRow = rows[0] ?? new Map<string, string>();

      // 全明細欄が空の段をスキップ
      const effectiveRows = rows.filter((row) =>
        lineItemFields.some((f) => (row.get(f.id) ?? "") !== "")
      );

      if (effectiveRows.length === 0) {
        // スキップ後 0 段 → rows[0] から 1 行（固定欄のみ・ページを落とさない）
        dataRows.push(buildRowCols(pageNum, fixedRow, new Map<string, string>()).join(","));
      } else {
        // 有効な段ごとに 1 行出力
        for (const itemRow of effectiveRows) {
          dataRows.push(buildRowCols(pageNum, fixedRow, itemRow).join(","));
        }
      }
    }
  }

  // RFC4180: 改行コードは \r\n
  const lines = [headerRow, ...dataRows];
  return lines.join("\r\n");
}
