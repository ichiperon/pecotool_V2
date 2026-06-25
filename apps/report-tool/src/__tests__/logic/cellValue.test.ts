import { describe, it, expect } from "vitest";
import { decideCellValue } from "../../logic/cellValue";
import type { ReportBlock } from "../../types/report";

function makeBlock(
  text: string,
  x: number,
  y: number,
  w = 100,
  h = 20
): ReportBlock {
  return {
    text,
    bbox: { x, y, width: w, height: h },
    fieldId: "F1",
  };
}

describe("decideCellValue", () => {
  it("ブロックが 1 件 → そのテキストをそのまま返す", () => {
    const result = decideCellValue([makeBlock("ABC", 0, 0)]);
    expect(result).toBe("ABC");
  });

  it("複数ブロックを読み順（y昇順→同帯内x昇順）で連結する", () => {
    // y が異なる → y 昇順
    const blocks = [
      makeBlock("二行目", 0, 30),
      makeBlock("一行目", 0, 0),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("一行目二行目");
  });

  it("同一帯内は x 昇順で連結する", () => {
    // y 差が lineThreshold(8) 以内 → 同一行扱い → x 昇順
    const blocks = [
      makeBlock("右", 200, 0),
      makeBlock("左", 0, 0),
      makeBlock("中", 100, 3),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("左中右");
  });

  it("joiner オプションでセパレータを指定できる", () => {
    const blocks = [
      makeBlock("A", 0, 0),
      makeBlock("B", 100, 0),
    ];
    const result = decideCellValue(blocks, { joiner: " " });
    expect(result).toBe("A B");
  });

  it("空文字のブロックは除外される", () => {
    const blocks = [
      makeBlock("", 0, 0),
      makeBlock("ABC", 100, 0),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("ABC");
  });

  it("空白のみのブロックは除外される（半角スペース）", () => {
    const blocks = [
      makeBlock("   ", 0, 0),
      makeBlock("ABC", 100, 0),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("ABC");
  });

  it("全角空白のみのブロックは除外される", () => {
    const blocks = [
      makeBlock("　", 0, 0),
      makeBlock("ABC", 100, 0),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("ABC");
  });

  it("全件空白 → 空文字を返す", () => {
    const blocks = [
      makeBlock("", 0, 0),
      makeBlock("　", 100, 0),
    ];
    const result = decideCellValue(blocks);
    expect(result).toBe("");
  });

  it("ブロックなし（空配列）→ 空文字を返す", () => {
    expect(decideCellValue([])).toBe("");
  });

  it("改行を含むテキストをそのまま保持する", () => {
    const block = makeBlock("ABC\nDEF", 0, 0);
    const result = decideCellValue([block]);
    expect(result).toBe("ABC\nDEF");
  });

  it("lineThreshold をカスタム指定できる", () => {
    // y 差が 20 → threshold=5 なら別行、threshold=25 なら同行
    const blocks = [
      makeBlock("右", 200, 0),
      makeBlock("左", 0, 20),
    ];
    // threshold=5 → y 差 20 > 5 → 別行 → y 昇順（左が y=20 なので右が先）
    const r1 = decideCellValue(blocks, { lineThreshold: 5 });
    expect(r1).toBe("右左");

    // threshold=25 → y 差 20 <= 25 → 同行 → x 昇順（左が x=0 なので左が先）
    const r2 = decideCellValue(blocks, { lineThreshold: 25 });
    expect(r2).toBe("左右");
  });
});
