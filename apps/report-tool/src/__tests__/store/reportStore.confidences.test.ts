import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";
import type { ReportRow } from "../../types/report";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
});

function setupCells(entries: [number, [string, string][][]][]) {
  const matrix: Map<number, ReportRow[]> = new Map();
  for (const [page, rowsData] of entries) {
    matrix.set(page, rowsData.map((pairs) => new Map(pairs)));
  }
  useReportStore.setState({ cells: matrix });
}

function setupConfidences(entries: [number, [string, number][][]][]) {
  const matrix: Map<number, Array<Map<string, number>>> = new Map();
  for (const [page, rowsData] of entries) {
    matrix.set(page, rowsData.map((pairs) => new Map(pairs)));
  }
  useReportStore.setState({ confidences: matrix });
}

// ========== setConfidences / setConfidencesForPage ==========

describe("setConfidences", () => {
  it("全ページの confidences を一括設定できる", () => {
    setupConfidences([
      [1, [[["f1", 0.9], ["f2", 0.5]]]],
      [2, [[["f1", 0.3]]]],
    ]);
    const conf = useReportStore.getState().confidences;
    expect(conf.get(1)?.[0]?.get("f1")).toBe(0.9);
    expect(conf.get(1)?.[0]?.get("f2")).toBe(0.5);
    expect(conf.get(2)?.[0]?.get("f1")).toBe(0.3);
  });

  it("setCells は confidences を丸ごとクリアする", () => {
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([["f1", "value"]])]],
    ]);
    useReportStore.getState().setCells(matrix);
    expect(useReportStore.getState().confidences.size).toBe(0);
  });

  it("setCells 後に setConfidences を呼べば再設定できる", () => {
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([["f1", "value"]])]],
    ]);
    useReportStore.getState().setCells(matrix);
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get("f1")).toBe(0.9);
  });
});

describe("setConfidencesForPage", () => {
  it("単一ページの confidences を部分更新できる", () => {
    setupConfidences([
      [1, [[["f1", 0.9]]]],
      [2, [[["f1", 0.3]]]],
    ]);
    useReportStore.getState().setConfidencesForPage(1, [new Map([["f1", 0.5]])]);
    const conf = useReportStore.getState().confidences;
    expect(conf.get(1)?.[0]?.get("f1")).toBe(0.5);
    // ページ2は変わらない
    expect(conf.get(2)?.[0]?.get("f1")).toBe(0.3);
  });

  it("setCellsForPage は対象ページの confidences をクリアする", () => {
    setupCells([[1, [[["f1", "old"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    useReportStore.getState().setCellsForPage(1, [new Map([["f1", "new"]])]);
    expect(useReportStore.getState().confidences.has(1)).toBe(false);
  });

  it("setCellsForPage 後に setConfidencesForPage を呼べば再設定できる", () => {
    setupCells([[1, [[["f1", "val"]]]]]);
    useReportStore.getState().setCellsForPage(1, [new Map([["f1", "new"]])]);
    useReportStore.getState().setConfidencesForPage(1, [new Map([["f1", 0.5]])]);
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get("f1")).toBe(0.5);
  });
});

// ========== 変更時クリア: setCellValue ==========

describe("setCellValue が confidence をクリアする", () => {
  it("手編集したセルの confidence が削除される", () => {
    setupCells([[1, [[["f1", "old"]]]]]);
    setupConfidences([[1, [[["f1", 0.5], ["f2", 0.9]]]]]);
    useReportStore.getState().setCellValue(1, "f1", "new");
    const conf = useReportStore.getState().confidences.get(1)?.[0];
    expect(conf?.has("f1")).toBe(false);
    // 別欄は維持
    expect(conf?.get("f2")).toBe(0.9);
  });

  it("rowIndex=1 のセルを編集すると段1の confidence が削除される", () => {
    setupCells([[1, [[["f1", "row0"]], [["f1", "row1"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]], [["f1", 0.5]]]]]);
    useReportStore.getState().setCellValue(1, "f1", "edited", 1);
    const conf = useReportStore.getState().confidences.get(1);
    // 段0は維持、段1はクリア
    expect(conf?.[0]?.get("f1")).toBe(0.9);
    expect(conf?.[1]?.has("f1")).toBe(false);
  });

  it("confidence がないセルを編集しても confidences 構造が壊れない", () => {
    setupCells([[1, [[["f1", "val"]]]]]);
    // confidences 未設定のまま setCellValue を呼んでも no-op で安全
    useReportStore.getState().setCellValue(1, "f1", "new");
    expect(useReportStore.getState().confidences.size).toBe(0);
  });
});

// ========== 変更時クリア: clearCellValue ==========

describe("clearCellValue が confidence をクリアする", () => {
  it("削除したセルの confidence が削除される", () => {
    setupCells([[1, [[["f1", "val"], ["f2", "other"]]]]]);
    setupConfidences([[1, [[["f1", 0.5], ["f2", 0.9]]]]]);
    useReportStore.getState().clearCellValue(1, "f1");
    const conf = useReportStore.getState().confidences.get(1)?.[0];
    expect(conf?.has("f1")).toBe(false);
    expect(conf?.get("f2")).toBe(0.9);
  });
});

// ========== 変更時クリア: moveCellValue ==========

describe("moveCellValue が from/to 両方の confidence をクリアする", () => {
  it("swap 後に from と to 両方の confidence が削除される", () => {
    setupCells([[1, [[["f1", "A"], ["f2", "B"]]]]]);
    setupConfidences([[1, [[["f1", 0.3], ["f2", 0.9], ["f3", 0.8]]]]]);
    useReportStore.getState().moveCellValue(1, "f1", "f2", "swap");
    const conf = useReportStore.getState().confidences.get(1)?.[0];
    expect(conf?.has("f1")).toBe(false);
    expect(conf?.has("f2")).toBe(false);
    // 無関係な欄は維持
    expect(conf?.get("f3")).toBe(0.8);
  });
});

// ========== 変更時クリア: insertRowAt / removeRowAt ==========

describe("insertRowAt / removeRowAt がページの confidences を丸ごとクリアする", () => {
  it("insertRowAt 後、そのページの confidences が消える", () => {
    setupCells([[1, [[["f1", "A"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]]]], [2, [[["f1", 0.5]]]]]);
    useReportStore.getState().insertRowAt(1, 0);
    const conf = useReportStore.getState().confidences;
    expect(conf.has(1)).toBe(false);
    // 別ページは維持
    expect(conf.get(2)?.[0]?.get("f1")).toBe(0.5);
  });

  it("removeRowAt 後、そのページの confidences が消える（2段以上ある場合）", () => {
    setupCells([[1, [[["f1", "A"]], [["f1", "B"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]], [["f1", 0.5]]]]]);
    useReportStore.getState().removeRowAt(1, 1);
    expect(useReportStore.getState().confidences.has(1)).toBe(false);
  });

  it("removeRowAt で最後の 1 段を消そうとすると no-op で confidences も維持", () => {
    setupCells([[1, [[["f1", "A"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    useReportStore.getState().removeRowAt(1, 0);
    // cells が変わらない（1段は削除しない）のでconfidencesも変わらない
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get("f1")).toBe(0.9);
  });
});

// ========== 変更時クリア: splitCellToNextRow / splitCellByNewlines ==========

describe("split 操作がページの confidences を丸ごとクリアする", () => {
  it("splitCellToNextRow 後、そのページの confidences が消える", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "欄1");
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([[fieldId, "ABCDE"]])]],
    ]);
    useReportStore.setState({ cells: matrix });
    setupConfidences([[1, [[[fieldId, 0.9]]]]]);
    useReportStore.getState().splitCellToNextRow(1, 0, fieldId, 3);
    expect(useReportStore.getState().confidences.has(1)).toBe(false);
  });

  it("splitCellByNewlines 後、そのページの confidences が消える", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "欄1");
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([[fieldId, "A\nB\nC"]])]],
    ]);
    useReportStore.setState({ cells: matrix });
    setupConfidences([[1, [[[fieldId, 0.5]]]]]);
    useReportStore.getState().splitCellByNewlines(1, 0, fieldId);
    expect(useReportStore.getState().confidences.has(1)).toBe(false);
  });

  it("splitCellByNewlines で改行なし → no-op で confidences 維持", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "欄1");
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([[fieldId, "単一行"]])]],
    ]);
    useReportStore.setState({ cells: matrix });
    setupConfidences([[1, [[[fieldId, 0.9]]]]]);
    useReportStore.getState().splitCellByNewlines(1, 0, fieldId);
    // 分割なし → confidences 変わらない
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get(fieldId)).toBe(0.9);
  });
});

// ========== reset / clearTemplate ==========

describe("clearTemplate が confidences をクリアする", () => {
  it("clearTemplate 後に confidences が空になる", () => {
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    useReportStore.getState().clearTemplate();
    expect(useReportStore.getState().confidences.size).toBe(0);
  });
});
