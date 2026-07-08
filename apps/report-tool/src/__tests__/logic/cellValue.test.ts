import { describe, it, expect } from "vitest";
import { decideCellValue, decideCellConfidence, clusterBlocksToRows } from "../../logic/cellValue";
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

describe("clusterBlocksToRows", () => {
  it("y座標が3クラスタに分かれるブロック群 → 3段の文字列配列を返す", () => {
    // 品名が縦に3つ並ぶ crop を想定（y座標が離れた3クラスタ）
    const blocks = [
      makeBlock("商品A", 0, 0),
      makeBlock("商品B", 0, 30),
      makeBlock("商品C", 0, 60),
    ];
    const result = clusterBlocksToRows(blocks);
    expect(result).toEqual(["商品A", "商品B", "商品C"]);
  });

  it("y近接2ブロック（同一行折返し）→ 閾値内で同一段に束ねる", () => {
    // lineThreshold(既定8) 以内の y 差 → 同一段として decideCellValue で連結
    const blocks = [
      makeBlock("折返し前半", 0, 0),
      makeBlock("折返し後半", 150, 3),
    ];
    const result = clusterBlocksToRows(blocks);
    expect(result).toEqual(["折返し前半折返し後半"]);
  });

  it("1件のみ → 1段の配列を返す", () => {
    const result = clusterBlocksToRows([makeBlock("単一", 0, 0)]);
    expect(result).toEqual(["単一"]);
  });

  it("空配列 → 空配列を返す", () => {
    expect(clusterBlocksToRows([])).toEqual([]);
  });

  it("空文字・空白のみのブロックは除外してからクラスタリングする", () => {
    const blocks = [
      makeBlock("", 0, 0),
      makeBlock("　", 0, 30),
      makeBlock("有効値", 0, 60),
    ];
    expect(clusterBlocksToRows(blocks)).toEqual(["有効値"]);
  });

  it("全件空白 → 空配列を返す", () => {
    const blocks = [makeBlock("", 0, 0), makeBlock("   ", 0, 30)];
    expect(clusterBlocksToRows(blocks)).toEqual([]);
  });

  it("同一段内は x 昇順で連結される（decideCellValue に委譲）", () => {
    const blocks = [
      makeBlock("右", 200, 0),
      makeBlock("左", 0, 2),
    ];
    expect(clusterBlocksToRows(blocks)).toEqual(["左右"]);
  });

  it("lineThreshold をカスタム指定できる（段の分かれ方が変わる）", () => {
    const blocks = [
      makeBlock("A", 0, 0),
      makeBlock("B", 0, 20),
    ];
    // threshold=5 → y差20 > 5 → 別段
    expect(clusterBlocksToRows(blocks, { lineThreshold: 5 })).toEqual(["A", "B"]);
    // threshold=25 → y差20 <= 25 → 同段
    expect(clusterBlocksToRows(blocks, { lineThreshold: 25 })).toEqual(["A" + "B"]);
  });

  it("joiner オプションが各段の連結に反映される", () => {
    const blocks = [
      makeBlock("A", 0, 0),
      makeBlock("B", 100, 0),
      makeBlock("C", 0, 60),
    ];
    expect(clusterBlocksToRows(blocks, { joiner: " " })).toEqual(["A B", "C"]);
  });
});

function makeBlockWithConf(
  text: string,
  confidence?: number
): ReportBlock {
  return {
    text,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    fieldId: "F1",
    confidence,
  };
}

describe("decideCellConfidence", () => {
  it("confidence を持つブロックが 1 件のみ → その値を返す", () => {
    const result = decideCellConfidence([makeBlockWithConf("A", 0.9)]);
    expect(result).toBe(0.9);
  });

  it("複数ブロックがある場合、最小値を返す（保守的）", () => {
    const blocks = [
      makeBlockWithConf("A", 0.9),
      makeBlockWithConf("B", 0.5),
      makeBlockWithConf("C", 0.3),
    ];
    expect(decideCellConfidence(blocks)).toBe(0.3);
  });

  it("confidence なしのブロックのみ → undefined を返す", () => {
    const blocks = [makeBlock("A", 0, 0), makeBlock("B", 10, 0)];
    expect(decideCellConfidence(blocks)).toBeUndefined();
  });

  it("confidence あり / なし が混在 → confidence 付きブロックの最小値を返す", () => {
    const blocks = [
      makeBlockWithConf("A", 0.9),
      makeBlock("B", 10, 0), // confidence なし
      makeBlockWithConf("C", 0.5),
    ];
    expect(decideCellConfidence(blocks)).toBe(0.5);
  });

  it("空配列 → undefined を返す", () => {
    expect(decideCellConfidence([])).toBeUndefined();
  });

  it("confidence=0.3（空判定値）のブロック → 0.3 を返す", () => {
    expect(decideCellConfidence([makeBlockWithConf("", 0.3)])).toBe(0.3);
  });
});
