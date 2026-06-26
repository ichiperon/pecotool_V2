import { describe, it, expect } from "vitest";
import { normalizeNumeric } from "../../logic/normalize";

describe("normalizeNumeric", () => {
  it("空文字 → 空文字を返す", () => {
    expect(normalizeNumeric("")).toBe("");
  });

  it("全角数字 → 半角数字", () => {
    expect(normalizeNumeric("１２３")).toBe("123");
  });

  it("前後空白を trim する", () => {
    expect(normalizeNumeric("  123  ")).toBe("123");
  });

  it("前後全角空白も trim する", () => {
    expect(normalizeNumeric("　123　")).toBe("123");
  });

  it("¥記号と桁区切りカンマを除去する", () => {
    expect(normalizeNumeric("¥1,234,567")).toBe("1234567");
  });

  it("バックスラッシュ通貨記号を除去する", () => {
    expect(normalizeNumeric("\\1,234")).toBe("1234");
  });

  it("「円」文字を除去する", () => {
    expect(normalizeNumeric("1234円")).toBe("1234");
  });

  it("△ で始まる値 → マイナス符号に変換する", () => {
    expect(normalizeNumeric("△50,000")).toBe("-50000");
  });

  it("▲ で始まる値 → マイナス符号に変換する", () => {
    expect(normalizeNumeric("▲1,000")).toBe("-1000");
  });

  it("△ + 全角数字 → マイナス + 半角数字", () => {
    expect(normalizeNumeric("△１，２３４")).toBe("-1234");
  });

  it("% はそのまま保持する（パーセント変換しない）", () => {
    expect(normalizeNumeric("8%")).toBe("8%");
  });

  it("非数値文字列はそのまま返す（壊さない）", () => {
    expect(normalizeNumeric("請求書")).toBe("請求書");
  });

  it("数字と漢字が混在 → そのまま返す", () => {
    expect(normalizeNumeric("123号")).toBe("123号");
  });

  it("小数点を含む数値を正規化する", () => {
    expect(normalizeNumeric("¥1,234.56")).toBe("1234.56");
  });

  it("全角カンマ（桁区切り）を除去する", () => {
    expect(normalizeNumeric("１，２３４")).toBe("1234");
  });

  it("通常のマイナス（半角）はそのまま扱う", () => {
    expect(normalizeNumeric("-5000")).toBe("-5000");
  });

  it("全角マイナス → 半角マイナスに変換する", () => {
    expect(normalizeNumeric("－5000")).toBe("-5000");
  });

  it("純粋な数字文字列はそのまま（正規化後も同値）", () => {
    expect(normalizeNumeric("12345")).toBe("12345");
  });

  it("¥ + 全角数字 + 全角カンマ → 正規化される", () => {
    expect(normalizeNumeric("¥１，２３４，５６７")).toBe("1234567");
  });

  // --- 修正2: #376（PCT-148）追加テスト ---

  // (1) 全角％ → 半角％
  it("全角パーセント（１２３％）→ 半角数字＋半角%（123%）", () => {
    expect(normalizeNumeric("１２３％")).toBe("123%");
  });

  // (2) 全角カンマ正規化（桁区切りでないケース）
  it("全角カンマが桁区切りでない場合は化けない（1，2，3 → 1，2，3）", () => {
    // "1，2，3" は全角カンマを半角へ変換すると "1,2,3" になるが、
    // isNumericLike=/^-?\d+(\.\d+)?%?$/ では falsy（カンマが残るため）。
    // 非数値として trimmedOriginal（="1，2，3"）を返す。
    // これが「数値文脈でない場合は化けさせない」仕様に合致する。
    // 旧来の無条件除去（"1，2，3" → "123"）と比べて格段に安全。
    expect(normalizeNumeric("1，2，3")).toBe("1，2，3");
  });

  // (2) 全角カンマが3桁区切りの場合は除去される
  it("全角カンマが3桁区切りなら除去される（１，２３４ → 1234）", () => {
    expect(normalizeNumeric("１，２３４")).toBe("1234");
  });

  // (3) △/▲ + 非数値は壊さない
  it("△% は壊さない（'△%' を返す）", () => {
    // △ + "%" → negative=true、v="%" → isNumericLike=false → trimmedOriginal="△%" を返す
    expect(normalizeNumeric("△%")).toBe("△%");
  });

  it("△. は壊さない（'△.' を返す）", () => {
    // △ + "." → negative=true、v="." → isNumericLike=false → trimmedOriginal="△." を返す
    expect(normalizeNumeric("△.")).toBe("△.");
  });

  // (4) 数値判定の厳格化 - 非数値文字列が壊れない
  it("1.2.3 は壊れず元相当で返る", () => {
    expect(normalizeNumeric("1.2.3")).toBe("1.2.3");
  });

  it("% 単体は壊れず元相当で返る", () => {
    expect(normalizeNumeric("%")).toBe("%");
  });

  it("5%5 は壊れず元相当で返る", () => {
    expect(normalizeNumeric("5%5")).toBe("5%5");
  });

  it("- 単体は壊れず元相当で返る", () => {
    expect(normalizeNumeric("-")).toBe("-");
  });

  // リグレッション: 既存の重要ケースが変わっていないこと
  it("[リグレッション] ¥1,234,567 → 1234567", () => {
    expect(normalizeNumeric("¥1,234,567")).toBe("1234567");
  });

  it("[リグレッション] △50,000 → -50000", () => {
    expect(normalizeNumeric("△50,000")).toBe("-50000");
  });

  it("[リグレッション] 8% → 8%", () => {
    expect(normalizeNumeric("8%")).toBe("8%");
  });

  it("[リグレッション] -5000 → -5000", () => {
    expect(normalizeNumeric("-5000")).toBe("-5000");
  });

  it("[リグレッション] △１，２３４ → -1234", () => {
    expect(normalizeNumeric("△１，２３４")).toBe("-1234");
  });
});
