import { describe, it, expect } from "vitest";
import { buildTemplateCsv, csvQuote } from "../../logic/templateCsv";
import type { CellMatrix, CsvOptions, ReportTemplate } from "../../types/report";

// デフォルトオプション
const DEFAULT_OPTS: CsvOptions = {
  includeFileName: false,
  includePageNumber: false,
  emptyValue: "",
  normalizeNumbers: false,
};

function makeTemplate(...names: string[]): ReportTemplate {
  return {
    fields: names.map((name, i) => ({
      id: `f${i + 1}`,
      name,
      color: "#000",
      rect: { x: 0, y: 0, width: 100, height: 100 },
    })),
  };
}

/** 明細欄テンプレート生成ヘルパー */
function makeTemplateWithLineItems(defs: { name: string; isLineItem?: boolean }[]): ReportTemplate {
  return {
    fields: defs.map((d, i) => ({
      id: `f${i + 1}`,
      name: d.name,
      color: "#000",
      rect: { x: 0, y: 0, width: 100, height: 100 },
      isLineItem: d.isLineItem,
    })),
  };
}

/**
 * 新形 CellMatrix（Map<number, ReportRow[]>）を構築するヘルパー。
 * entries: [pageNum, [ [key, val][] ][]] の配列
 */
function makeMatrix(entries: [number, [string, string][][]][]): CellMatrix {
  const m: CellMatrix = new Map();
  for (const [page, rows] of entries) {
    m.set(page, rows.map((pairs) => new Map(pairs)));
  }
  return m;
}

/**
 * 後方互換: 各ページが 1 段（単一 Map）の場合に使うシムヘルパー。
 * [pageNum, [key, val][]] の配列を受け取り、新形に変換する。
 */
function makeMatrix1(entries: [number, [string, string][]][]): CellMatrix {
  return makeMatrix(entries.map(([page, pairs]) => [page, [pairs]] as [number, [string, string][][]]));
}

describe("csvQuote", () => {
  it("カンマを含む値は引用符で囲む", () => {
    expect(csvQuote("a,b")).toBe('"a,b"');
  });

  it("ダブルクオートを含む値は \"\" にエスケープして囲む", () => {
    expect(csvQuote('say "hello"')).toBe('"say ""hello"""');
  });

  it("改行を含む値は引用符で囲む（LF）", () => {
    expect(csvQuote("line1\nline2")).toBe('"line1\nline2"');
  });

  it("改行を含む値は引用符で囲む（CRLF）", () => {
    expect(csvQuote("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("特殊文字がない値はそのまま返す", () => {
    expect(csvQuote("hello")).toBe("hello");
  });

  it("空文字はそのまま返す", () => {
    expect(csvQuote("")).toBe("");
  });

  // --- Formula Injection 対策テスト ---

  describe("Formula Injection 中和", () => {
    it("=cmd で始まる値は ' を前置する", () => {
      expect(csvQuote("=cmd")).toBe("'=cmd");
    });

    it("+1+1 で始まる値は ' を前置する（正当な数値でないため）", () => {
      expect(csvQuote("+1+1")).toBe("'+1+1");
    });

    it("-1+1 で始まる値は ' を前置する（正当な数値でないため）", () => {
      expect(csvQuote("-1+1")).toBe("'-1+1");
    });

    it("@SUM(A1) で始まる値は ' を前置する", () => {
      expect(csvQuote("@SUM(A1)")).toBe("'@SUM(A1)");
    });

    it("タブ文字で始まる値は ' を前置する", () => {
      expect(csvQuote("\tSUM(A1)")).toBe("'\tSUM(A1)");
    });

    it("CR で始まる値は ' を前置してから RFC4180 引用符で囲む", () => {
      // '\r=cmd → CR を含むため "" で囲まれる
      expect(csvQuote("\r=cmd")).toBe('"\'\r=cmd"');
    });

    // --- 全角トリガ文字（OWASP 追加要件）---

    it("＝1+1（全角等号）で始まる値は ' を前置する", () => {
      expect(csvQuote("＝1+1")).toBe("'＝1+1");
    });

    it("＋1+1（全角プラス）で始まる値は ' を前置する", () => {
      expect(csvQuote("＋1+1")).toBe("'＋1+1");
    });

    it("－1+1（全角ハイフン・非数値）で始まる値は ' を前置する", () => {
      // 全角ハイフンは SAFE_NUMERIC の対象外（半角の - ではないため）
      expect(csvQuote("－1+1")).toBe("'－1+1");
    });

    it("＠SUM（全角アット）で始まる値は ' を前置する", () => {
      expect(csvQuote("＠SUM")).toBe("'＠SUM");
    });

    // --- LF 始まり（CR/LF 非対称修正）---

    it("LF で始まる値は ' を前置してから RFC4180 引用符で囲む", () => {
      // '\n=cmd → LF を含むため "" で囲まれる
      expect(csvQuote("\n=cmd")).toBe('"\'\n=cmd"');
    });

    // --- 先頭空白・NBSP 後のトリガ ---

    it("半角スペース + =cmd は中和する", () => {
      expect(csvQuote(" =cmd")).toBe("' =cmd");
    });

    it("全角スペース + =cmd は中和する", () => {
      expect(csvQuote("　=cmd")).toBe("'　=cmd");
    });

    it("NBSP（U+00A0）+ =cmd は中和する", () => {
      // NBSP は \s に含まれない環境もあるため明示対応
      expect(csvQuote(" =cmd")).toBe("' =cmd");
    });

    // --- 既存の正当な数値リグレッション ---

    it("-50000 は中和しない（既存リグレッション）", () => {
      expect(csvQuote("-50000")).toBe("-50000");
    });

    // --- 正当な数値は中和しない ---

    it("-50000 は中和しない（正当な負数）", () => {
      expect(csvQuote("-50000")).toBe("-50000");
    });

    it("+12.5 は中和しない（正当な正数）", () => {
      expect(csvQuote("+12.5")).toBe("+12.5");
    });

    it("1234.56 は中和しない（トリガ文字で始まらない）", () => {
      expect(csvQuote("1234.56")).toBe("1234.56");
    });

    it("-1234.56 は中和しない（正当な負小数）", () => {
      expect(csvQuote("-1234.56")).toBe("-1234.56");
    });

    it("8% は中和しない（トリガ文字で始まらない）", () => {
      expect(csvQuote("8%")).toBe("8%");
    });

    // --- ゼロ幅・BiDi 制御文字による回避を防ぐ ---

    it("ゼロ幅スペース + =1+1 は中和する（先頭不可視文字を見抜く）", () => {
      // U+200B（ゼロ幅スペース）+ "=1+1"
      const input = "​=1+1";
      expect(csvQuote(input)).toBe("'" + input);
    });

    it("BOM (U+FEFF) + =HYPERLINK は中和して RFC4180 引用符で囲む", () => {
      // ダブルクオートを含むため "" で囲まれる（' 前置後に RFC4180 クオート）
      const input = '﻿=HYPERLINK("http://evil.example")';
      // ' + input → ダブルクオートを含むため "" エスケープして囲む
      expect(csvQuote(input)).toBe(`"'﻿=HYPERLINK(""http://evil.example"")"`);
    });
  });
});

describe("buildTemplateCsv - Formula Injection 中和の統合確認", () => {
  it("normalizeNumbers=OFF 時: セル値が数式トリガなら ' 前置される", () => {
    const tmpl = makeTemplate("摘要");
    const cells = makeMatrix1([[1, [["f1", "=1+1"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe("'=1+1");
  });

  it("normalizeNumbers=ON 時: 正規化後の負数 -50000 は中和されない", () => {
    // △50000 → normalizeNumeric → -50000 → csvQuote で中和されないことを確認
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, [["f1", "△50,000"]]]]);
    const opts: CsvOptions = { ...DEFAULT_OPTS, normalizeNumbers: true };
    const csv = buildTemplateCsv(tmpl, cells, opts, { pageNumbers: [1] });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe("-50000");
  });
});

describe("buildTemplateCsv", () => {
  it("列順: 固定列(ファイル名・ページ) → fields 定義順", () => {
    const tmpl = makeTemplate("金額", "摘要");
    const cells = makeMatrix1([[1, [["f1", "1000"], ["f2", "テスト"]]]]);
    const opts: CsvOptions = {
      ...DEFAULT_OPTS,
      includeFileName: true,
      includePageNumber: true,
    };
    const csv = buildTemplateCsv(tmpl, cells, opts, {
      fileName: "test.pdf",
      pageNumbers: [1],
    });
    const [header, dataRow] = csv.split("\r\n");
    expect(header).toBe("ファイル名,ページ,金額,摘要");
    expect(dataRow).toBe("test.pdf,1,1000,テスト");
  });

  it("includeFileName=false のとき → ファイル名列がない", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, [["f1", "500"]]]]);
    const opts: CsvOptions = {
      ...DEFAULT_OPTS,
      includePageNumber: true,
    };
    const csv = buildTemplateCsv(tmpl, cells, opts, {
      fileName: "test.pdf",
      pageNumbers: [1],
    });
    const [header] = csv.split("\r\n");
    expect(header).toBe("ページ,金額");
  });

  it("includePageNumber=false のとき → ページ列がない", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, [["f1", "500"]]]]);
    const opts: CsvOptions = {
      ...DEFAULT_OPTS,
      includeFileName: true,
    };
    const csv = buildTemplateCsv(tmpl, cells, opts, {
      fileName: "test.pdf",
      pageNumbers: [1],
    });
    const [header] = csv.split("\r\n");
    expect(header).toBe("ファイル名,金額");
  });

  it("固定列 ON/OFF どちらもない場合 → フィールド列のみ", () => {
    const tmpl = makeTemplate("金額", "摘要");
    const cells = makeMatrix1([[1, [["f1", "100"], ["f2", "メモ"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [header, dataRow] = csv.split("\r\n");
    expect(header).toBe("金額,摘要");
    expect(dataRow).toBe("100,メモ");
  });

  it("空セル → opts.emptyValue を出力する", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, []]]); // f1 なし
    const opts: CsvOptions = { ...DEFAULT_OPTS, emptyValue: "N/A" };
    const csv = buildTemplateCsv(tmpl, cells, opts, { pageNumbers: [1] });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe("N/A");
  });

  it("カンマを含む値は引用符で囲まれる", () => {
    const tmpl = makeTemplate("摘要");
    const cells = makeMatrix1([[1, [["f1", "A,B,C"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe('"A,B,C"');
  });

  it("セル内改行は引用符で保持される（Excel 行ズレ防止）", () => {
    const tmpl = makeTemplate("摘要");
    const cells = makeMatrix1([[1, [["f1", "行1\n行2"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [, dataRow] = csv.split("\r\n", 2);
    // dataRow は "行1\n行2" が引用符で囲まれているはず
    expect(dataRow).toBe('"行1\n行2"');
  });

  it("ダブルクオートのエスケープ", () => {
    const tmpl = makeTemplate("摘要");
    const cells = makeMatrix1([[1, [["f1", 'say "hi"']]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe('"say ""hi"""');
  });

  it("normalizeNumbers=true のとき → 数値列を正規化する", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, [["f1", "¥1,234"]]]]);
    const opts: CsvOptions = { ...DEFAULT_OPTS, normalizeNumbers: true };
    const csv = buildTemplateCsv(tmpl, cells, opts, { pageNumbers: [1] });
    const [, dataRow] = csv.split("\r\n");
    expect(dataRow).toBe("1234");
  });

  it("normalizeNumbers=true でも固定列（ファイル名）は正規化されない", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([[1, [["f1", "¥1,234"]]]]);
    const opts: CsvOptions = {
      includeFileName: true,
      includePageNumber: false,
      emptyValue: "",
      normalizeNumbers: true,
    };
    const csv = buildTemplateCsv(tmpl, cells, opts, {
      fileName: "¥レポート.pdf",
      pageNumbers: [1],
    });
    const [, dataRow] = csv.split("\r\n");
    // ファイル名はそのまま、金額だけ正規化
    expect(dataRow).toBe("¥レポート.pdf,1234");
  });

  it("空欄名フォールバック → 範囲{n} を使う", () => {
    const tmpl: ReportTemplate = {
      fields: [
        { id: "f1", name: "", color: "#000", rect: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "f2", name: "  ", color: "#000", rect: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    };
    const cells = makeMatrix1([[1, []]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [header] = csv.split("\r\n");
    expect(header).toBe("範囲1,範囲2");
  });

  it("改行コードは \\r\\n（RFC4180 準拠）", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1, 2],
    });
    // \r\n で split すると 3 行になるはず（ヘッダ + 2 行）
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe("100");
    expect(rows[2]).toBe("200");
  });

  it("欄名が重複していても列を保持する", () => {
    const tmpl: ReportTemplate = {
      fields: [
        { id: "f1", name: "金額", color: "#000", rect: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "f2", name: "金額", color: "#000", rect: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    };
    const cells = makeMatrix1([[1, [["f1", "100"], ["f2", "200"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [1],
    });
    const [header, dataRow] = csv.split("\r\n");
    expect(header).toBe("金額,金額");
    expect(dataRow).toBe("100,200");
  });

  it("pageNumbers の表示順で行を出力する", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([
      [1, [["f1", "100"]]],
      [3, [["f1", "300"]]],
    ]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, {
      pageNumbers: [3, 1], // 逆順指定
    });
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe("300"); // pageNumbers[0]=3 が先
    expect(rows[2]).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// 縦持ち展開テスト（明細欄あり）
// ---------------------------------------------------------------------------

describe("buildTemplateCsv - 明細欄なし（段=1 バイト等価確認）", () => {
  it("isLineItem なしのテンプレートでは従来と完全一致（1 段 1 行）", () => {
    const tmpl = makeTemplate("固定欄A", "固定欄B");
    const cells = makeMatrix1([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("AAA,BBB");
  });

  it("複数ページ・明細欄なしで従来と同一の出力", () => {
    const tmpl = makeTemplate("金額");
    const cells = makeMatrix1([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1, 2] });
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe("100");
    expect(rows[2]).toBe("200");
  });
});

describe("buildTemplateCsv - 明細欄あり（縦持ち展開）", () => {
  it("明細欄が 1 個: 各段が 1 行に展開される", () => {
    const tmpl = makeTemplateWithLineItems([
      { name: "固定欄" },
      { name: "明細欄", isLineItem: true },
    ]);
    // 1 ページ・2 段: 段0=(fixed=X, item=A)、段1=(item=B)
    const cells = makeMatrix([[1, [
      [["f1", "X"], ["f2", "A"]],
      [["f2", "B"]],
    ]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    // ヘッダ + 2 行
    expect(rows).toHaveLength(3);
    // 固定欄は常に rows[0] から（= X）、明細欄は各段から
    expect(rows[1]).toBe("X,A");
    expect(rows[2]).toBe("X,B");
  });

  it("固定欄の値は各行に複製される（rows[0] から取得）", () => {
    const tmpl = makeTemplateWithLineItems([
      { name: "ページ", isLineItem: false },
      { name: "品名", isLineItem: true },
      { name: "金額", isLineItem: true },
    ]);
    const cells = makeMatrix([[1, [
      [["f1", "固定値"], ["f2", "品名A"], ["f3", "100"]],
      [["f2", "品名B"], ["f3", "200"]],
    ]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe("固定値,品名A,100");
    expect(rows[2]).toBe("固定値,品名B,200");
  });

  it("全明細欄が空の段はスキップされる", () => {
    const tmpl = makeTemplateWithLineItems([
      { name: "固定欄" },
      { name: "明細欄", isLineItem: true },
    ]);
    // 段1 の明細欄が空 → スキップ
    const cells = makeMatrix([[1, [
      [["f1", "X"], ["f2", "A"]],
      [["f1", "ignored"], ["f2", ""]],
    ]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    // スキップで 1 行だけ
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("X,A");
  });

  it("スキップ後に 0 段になったとき rows[0] から 1 行出力（ページを落とさない）", () => {
    const tmpl = makeTemplateWithLineItems([
      { name: "固定欄" },
      { name: "明細欄", isLineItem: true },
    ]);
    // 全段の明細欄が空 → スキップ後 0 段 → rows[0] から 1 行（固定欄のみ）
    const cells = makeMatrix([[1, [
      [["f1", "固定値"], ["f2", ""]],
    ]]]);
    const csv = buildTemplateCsv(tmpl, cells, DEFAULT_OPTS, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("固定値,");
  });

  it("normalizeNumbers は明細欄にも適用される", () => {
    const tmpl = makeTemplateWithLineItems([
      { name: "金額", isLineItem: true },
    ]);
    const cells = makeMatrix([[1, [
      [["f1", "¥1,000"]],
      [["f1", "¥2,000"]],
    ]]]);
    const opts: CsvOptions = { ...DEFAULT_OPTS, normalizeNumbers: true };
    const csv = buildTemplateCsv(tmpl, cells, opts, { pageNumbers: [1] });
    const rows = csv.split("\r\n");
    expect(rows[1]).toBe("1000");
    expect(rows[2]).toBe("2000");
  });
});
