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

// ========== 段構造変更時のリマップ: insertRowAt / removeRowAt ==========
// 旧仕様（ページ丸ごとクリア）は触っていないセルの低信頼ハイライトまで消す
// 情報損失だったため、edited と同じ index リマップに統一（レビュー指摘 P3）。

describe("insertRowAt / removeRowAt がページの confidences を index リマップする", () => {
  it("insertRowAt 後、挿入位置に空の段が入り既存の信頼度は段ごとシフトして保持される", () => {
    setupCells([[1, [[["f1", "A"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]]]], [2, [[["f1", 0.5]]]]]);
    useReportStore.getState().insertRowAt(1, -1); // 先頭に挿入
    const conf = useReportStore.getState().confidences;
    expect(conf.get(1)).toHaveLength(2);
    expect(conf.get(1)?.[0]?.size).toBe(0); // 挿入された空段
    expect(conf.get(1)?.[1]?.get("f1")).toBe(0.9); // 旧段0が段1へシフト
    // 別ページは維持
    expect(conf.get(2)?.[0]?.get("f1")).toBe(0.5);
  });

  it("removeRowAt 後、削除段の信頼度だけ落ち残段はシフトして保持される", () => {
    setupCells([[1, [[["f1", "A"]], [["f1", "B"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]], [["f1", 0.5]]]]]);
    useReportStore.getState().removeRowAt(1, 0);
    const conf = useReportStore.getState().confidences;
    expect(conf.get(1)).toHaveLength(1);
    expect(conf.get(1)?.[0]?.get("f1")).toBe(0.5); // 旧段1が段0へシフト
  });

  it("removeRowAt で最後の 1 段を消そうとすると no-op で confidences も維持", () => {
    setupCells([[1, [[["f1", "A"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]]]]]);
    useReportStore.getState().removeRowAt(1, 0);
    // cells が変わらない（1段は削除しない）のでconfidencesも変わらない
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get("f1")).toBe(0.9);
  });

  it("insertRowAt: afterRowIndex < -1 は 0 にクランプされ cells/confidences の挿入位置が揃う", () => {
    // クランプなしだと insertIdx が負値 splice で「配列長基準」に解釈され、
    // cells(4段) と confidences(3段) のように長さが違うと挿入位置が乖離して
    // 別の段の信頼度が空段に付け替わる（stale conf）。回帰防止テスト。
    setupCells([[1, [[["f1", "a0"]], [["f1", "a1"]], [["f1", "a2"]], [["f1", "a3"]]]]]);
    setupConfidences([[1, [[["f1", 0.9]], [["f1", 0.4]], [["f1", 0.7]]]]]);
    useReportStore.getState().insertRowAt(1, -3);
    const cells = useReportStore.getState().cells.get(1)!;
    const conf = useReportStore.getState().confidences.get(1)!;
    // 両配列とも先頭に空段が入りアラインが保たれる
    expect(cells[0].size).toBe(0);
    expect(cells[1].get("f1")).toBe("a0");
    expect(conf[0].size).toBe(0);
    expect(conf[1].get("f1")).toBe(0.9);
    expect(conf[2].get("f1")).toBe(0.4);
    expect(conf[3].get("f1")).toBe(0.7);
  });

  it("段操作の連鎖（末尾挿入→先頭挿入→削除→分割）でも conf が値の変わっていないセルにだけ残る", () => {
    // リマップ不変条件の統合検証: conf[page][i][f] が存在するなら
    // cells[page][i][f] は OCR 時の値のままであること
    setupCells([[1, [[["fA", "a0"], ["fB", "b0"]], [["fA", "a1"], ["fB", "b1"]], [["fA", "a2"]]]]]);
    setupConfidences([[1, [[["fA", 0.9], ["fB", 0.4]], [["fA", 0.3], ["fB", 0.8]], [["fA", 0.5]]]]]);
    const s = () => useReportStore.getState();

    s().insertRowAt(1, 2); // 末尾に挿入（insertIdx == conf 長の境界）
    s().insertRowAt(1, 0); // 中間（段1）に挿入
    s().removeRowAt(1, 1); // 挿入した空段を削除
    s().splitCellToNextRow(1, 1, "fA", 1); // 旧OCR段1の fA "a1" を "a"/"1" に分割

    // cells: [a0/b0, "a"/b1, "1", a2, 空]
    const cells = s().cells.get(1)!;
    expect(cells).toHaveLength(5);
    expect(cells[1].get("fA")).toBe("a");
    expect(cells[2].get("fA")).toBe("1");

    // conf: 分割欄 fA は落ち、同段の fB・他段の fA は正しい段に追従
    const conf = s().confidences.get(1)!;
    expect(conf).toHaveLength(5);
    expect(conf[0].get("fA")).toBe(0.9);
    expect(conf[0].get("fB")).toBe(0.4);
    expect(conf[1].get("fA")).toBeUndefined(); // 分割で値が変わった欄
    expect(conf[1].get("fB")).toBe(0.8); // 同段他欄は保持
    expect(conf[2].size).toBe(0); // 分割の新段
    expect(conf[3].get("fA")).toBe(0.5); // 旧段2の信頼度が正しい段に追従
    expect(conf[4].size).toBe(0); // 末尾挿入の空段
  });
});

// ========== 段構造変更時のリマップ: splitCellToNextRow / splitCellByNewlines ==========

describe("split 操作が分割欄の信頼度を落とし他欄・他段はリマップして保持する", () => {
  it("splitCellToNextRow 後、分割欄の信頼度は消え同段の他欄は保持される", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "欄1");
    useReportStore.getState().addField(SAMPLE_RECT, "欄2");
    const [fieldId, otherId] = useReportStore.getState().template.fields.map((f) => f.id);
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([[fieldId, "ABCDE"], [otherId, "固定"]])]],
    ]);
    useReportStore.setState({ cells: matrix });
    setupConfidences([[1, [[[fieldId, 0.9], [otherId, 0.7]]]]]);
    useReportStore.getState().splitCellToNextRow(1, 0, fieldId, 3);
    const conf = useReportStore.getState().confidences.get(1);
    expect(conf).toHaveLength(2);
    expect(conf?.[0]?.get(fieldId)).toBeUndefined(); // 分割で値が変わった欄は落ちる
    expect(conf?.[0]?.get(otherId)).toBe(0.7); // 同段の他欄は保持
    expect(conf?.[1]?.size).toBe(0); // 新段は情報なし
  });

  it("splitCellByNewlines 後、新段分の空エントリが挿入され段数が揃う", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "欄1");
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, ReportRow[]> = new Map([
      [1, [new Map([[fieldId, "A\nB\nC"]])]],
    ]);
    useReportStore.setState({ cells: matrix });
    setupConfidences([[1, [[[fieldId, 0.5]]]]]);
    useReportStore.getState().splitCellByNewlines(1, 0, fieldId);
    const conf = useReportStore.getState().confidences.get(1);
    expect(conf).toHaveLength(3); // cells の3段とアライン
    expect(conf?.[0]?.get(fieldId)).toBeUndefined();
    expect(conf?.[1]?.size).toBe(0);
    expect(conf?.[2]?.size).toBe(0);
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
