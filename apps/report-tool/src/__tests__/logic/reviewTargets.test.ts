import { describe, it, expect } from "vitest";
import {
  listReviewTargets,
  countReviewTargets,
  LOW_CONFIDENCE_THRESHOLD,
} from "../../logic/reviewTargets";
import type { ReportField, CellMatrix } from "../../types/report";
import type { ConfidenceMatrix } from "../../store/reportStore";

const RECT = { x: 0, y: 0, width: 100, height: 30 };

function field(id: string, isLineItem = false): ReportField {
  return { id, name: id, color: "#7cb9e8", rect: RECT, isLineItem };
}

describe("listReviewTargets", () => {
  it("空セルは kind=empty、低信頼セルは kind=lowConfidence で列挙される", () => {
    const fields = [field("a"), field("b")];
    const cells: CellMatrix = new Map([
      [1, [new Map([["a", ""], ["b", "値あり"]])]],
    ]);
    const conf: ConfidenceMatrix = new Map([[1, [new Map([["b", 0.3]])]]]);

    const targets = listReviewTargets(cells, conf, fields);
    expect(targets).toEqual([
      { pageNum: 1, rowIndex: 0, fieldId: "a", kind: "empty" },
      { pageNum: 1, rowIndex: 0, fieldId: "b", kind: "lowConfidence" },
    ]);
  });

  it("閾値ちょうど（0.5）は低信頼、閾値超（0.51）は対象外 — CsvPreviewTable の可視化と同じ境界", () => {
    const fields = [field("a"), field("b")];
    const cells: CellMatrix = new Map([
      [1, [new Map([["a", "x"], ["b", "y"]])]],
    ]);
    const conf: ConfidenceMatrix = new Map([
      [1, [new Map([["a", LOW_CONFIDENCE_THRESHOLD], ["b", LOW_CONFIDENCE_THRESHOLD + 0.01]])]],
    ]);

    const targets = listReviewTargets(cells, conf, fields);
    expect(targets).toEqual([
      { pageNum: 1, rowIndex: 0, fieldId: "a", kind: "lowConfidence" },
    ]);
  });

  it("confidence が無い（手編集済み・OCR外）セルは値があれば対象外", () => {
    const fields = [field("a")];
    const cells: CellMatrix = new Map([[1, [new Map([["a", "手修正値"]])]]]);
    const targets = listReviewTargets(cells, new Map(), fields);
    expect(targets).toEqual([]);
  });

  it("固定欄の2段目以降（〃セル）は空でも対象外", () => {
    const fields = [field("fixed"), field("item", true)];
    const cells: CellMatrix = new Map([
      [
        1,
        [
          new Map([["fixed", "F"], ["item", "1行目"]]),
          new Map([["item", "2行目"]]), // fixed は未設定（〃セル）
        ],
      ],
    ]);
    const targets = listReviewTargets(cells, new Map(), fields);
    // 段2の fixed（〃）は含まれない
    expect(targets).toEqual([]);
  });

  it("明細欄は2段目以降も対象になる（空の明細セル）", () => {
    const fields = [field("item", true)];
    const cells: CellMatrix = new Map([
      [1, [new Map([["item", "1行目"]]), new Map([["item", ""]])]],
    ]);
    const targets = listReviewTargets(cells, new Map(), fields);
    expect(targets).toEqual([
      { pageNum: 1, rowIndex: 1, fieldId: "item", kind: "empty" },
    ]);
  });

  it("ドキュメント順（ページ昇順→段昇順→欄定義順）で返る", () => {
    const fields = [field("a"), field("b")];
    const cells: CellMatrix = new Map([
      [3, [new Map([["a", ""], ["b", ""]])]],
      [1, [new Map([["a", ""]]), new Map()]],
    ]);
    // 明細でない b は段2で〃になるので、page1 段2 は a も b も対象外
    const targets = listReviewTargets(cells, new Map(), fields);
    expect(targets.map((t) => [t.pageNum, t.rowIndex, t.fieldId])).toEqual([
      [1, 0, "a"],
      [1, 0, "b"], // b はエントリなし = 空
      [3, 0, "a"],
      [3, 0, "b"],
    ]);
  });
});

describe("countReviewTargets", () => {
  it("kind 別の件数を数える", () => {
    const counts = countReviewTargets([
      { pageNum: 1, rowIndex: 0, fieldId: "a", kind: "empty" },
      { pageNum: 1, rowIndex: 0, fieldId: "b", kind: "lowConfidence" },
      { pageNum: 2, rowIndex: 0, fieldId: "a", kind: "lowConfidence" },
    ]);
    expect(counts).toEqual({ lowConfidence: 2, empty: 1 });
  });

  it("空リストは両方 0", () => {
    expect(countReviewTargets([])).toEqual({ lowConfidence: 0, empty: 0 });
  });
});
