import { describe, it, expect } from "vitest";
import { applyCellMove } from "../../logic/cellEdit";

function makeRow(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe("applyCellMove - swap モード（既定挙動）", () => {
  it("to が空のとき: from の値が to に移り、from が空になる（実質 move）", () => {
    const row = makeRow([["f1", "1000"], ["f2", ""]]);
    const result = applyCellMove(row, "f1", "f2", "swap");
    expect(result.get("f1")).toBe("");
    expect(result.get("f2")).toBe("1000");
  });

  it("to が埋まっているとき: from と to の値が交換される", () => {
    const row = makeRow([["f1", "AAA"], ["f2", "BBB"]]);
    const result = applyCellMove(row, "f1", "f2", "swap");
    expect(result.get("f1")).toBe("BBB");
    expect(result.get("f2")).toBe("AAA");
  });

  it("from === to のとき: 同一参照を返す（no-op）", () => {
    const row = makeRow([["f1", "AAA"]]);
    const result = applyCellMove(row, "f1", "f1", "swap");
    expect(result).toBe(row);
  });

  it("from が空のとき: to に空文字が入り、from は to の元値になる", () => {
    const row = makeRow([["f1", ""], ["f2", "BBB"]]);
    const result = applyCellMove(row, "f1", "f2", "swap");
    expect(result.get("f1")).toBe("BBB");
    expect(result.get("f2")).toBe("");
  });
});

describe("applyCellMove - move モード", () => {
  it("to が空のとき: from の値が to に移り、from が空になる", () => {
    const row = makeRow([["f1", "1000"], ["f2", ""]]);
    const result = applyCellMove(row, "f1", "f2", "move");
    expect(result.get("f1")).toBe("");
    expect(result.get("f2")).toBe("1000");
  });

  it("to が埋まっているとき: to は from の値に上書き、from は空になる（to の値は消える）", () => {
    const row = makeRow([["f1", "AAA"], ["f2", "BBB"]]);
    const result = applyCellMove(row, "f1", "f2", "move");
    expect(result.get("f1")).toBe("");
    expect(result.get("f2")).toBe("AAA");
  });

  it("from === to のとき: 同一参照を返す（no-op）", () => {
    const row = makeRow([["f1", "AAA"]]);
    const result = applyCellMove(row, "f1", "f1", "move");
    expect(result).toBe(row);
  });

  it("from が空のとき: to に空文字が設定され、from も空のまま", () => {
    const row = makeRow([["f1", ""], ["f2", "BBB"]]);
    const result = applyCellMove(row, "f1", "f2", "move");
    expect(result.get("f1")).toBe("");
    expect(result.get("f2")).toBe("");
  });
});

describe("applyCellMove - 元 row 非破壊", () => {
  it("swap モードで結果を変えても元の row が変わらない", () => {
    const row = makeRow([["f1", "AAA"], ["f2", "BBB"]]);
    applyCellMove(row, "f1", "f2", "swap");
    expect(row.get("f1")).toBe("AAA");
    expect(row.get("f2")).toBe("BBB");
  });

  it("move モードで結果を変えても元の row が変わらない", () => {
    const row = makeRow([["f1", "AAA"], ["f2", "BBB"]]);
    applyCellMove(row, "f1", "f2", "move");
    expect(row.get("f1")).toBe("AAA");
    expect(row.get("f2")).toBe("BBB");
  });
});

describe("applyCellMove - from/to に存在しないフィールドIDを渡した場合", () => {
  it("from が存在しないキー: from は空文字扱い、to に空文字が入る（swap）", () => {
    const row = makeRow([["f2", "BBB"]]);
    const result = applyCellMove(row, "f99", "f2", "swap");
    // vFrom = "" (未存在 → ""), vTo = "BBB"
    // swap: f2 = "", f99 = "BBB"
    expect(result.get("f2")).toBe("");
    expect(result.get("f99")).toBe("BBB");
  });

  it("to が存在しないキー: to に from の値が入る（swap）", () => {
    const row = makeRow([["f1", "AAA"]]);
    const result = applyCellMove(row, "f1", "f99", "swap");
    // vFrom = "AAA", vTo = "" (未存在 → "")
    // swap: f99 = "AAA", f1 = ""
    expect(result.get("f99")).toBe("AAA");
    expect(result.get("f1")).toBe("");
  });
});
