import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

// テスト用ユーティリティ: 指定構造の cells を State に設定する
function setupCells(entries: [number, [string, string][]][]) {
  const matrix: Map<number, Map<string, string>> = new Map();
  for (const [page, pairs] of entries) {
    matrix.set(page, new Map(pairs));
  }
  useReportStore.setState({ cells: matrix });
}

describe("setCellValue", () => {
  it("指定ページ・欄の値を更新する", () => {
    setupCells([[1, [["f1", "100"]]]]);
    useReportStore.getState().setCellValue(1, "f1", "999");
    expect(useReportStore.getState().cells.get(1)?.get("f1")).toBe("999");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)!;
    useReportStore.getState().setCellValue(1, "f1", "999");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する（不要な参照コピーなし）", () => {
    setupCells([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().setCellValue(1, "f1", "999");
    const nextRow2 = useReportStore.getState().cells.get(2)!;
    expect(nextRow2).toBe(prevRow2);
  });

  it("値が変わらない場合は no-op（cells の参照が変わらない）", () => {
    setupCells([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().setCellValue(1, "f1", "100");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページに値をセットするとページ行が新規作成される", () => {
    setupCells([[1, [["f1", "100"]]]]);
    useReportStore.getState().setCellValue(99, "f99", "hello");
    expect(useReportStore.getState().cells.get(99)?.get("f99")).toBe("hello");
  });
});

describe("clearCellValue", () => {
  it("指定ページ・欄の値を空文字にする（キーは残る）", () => {
    setupCells([[1, [["f1", "100"]]]]);
    useReportStore.getState().clearCellValue(1, "f1");
    const row = useReportStore.getState().cells.get(1)!;
    expect(row.has("f1")).toBe(true);
    expect(row.get("f1")).toBe("");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)!;
    useReportStore.getState().clearCellValue(1, "f1");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する", () => {
    setupCells([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().clearCellValue(1, "f1");
    expect(useReportStore.getState().cells.get(2)).toBe(prevRow2);
  });

  it("既に空文字のとき no-op（cells の参照が変わらない）", () => {
    setupCells([[1, [["f1", ""]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().clearCellValue(1, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページを渡したとき no-op", () => {
    setupCells([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().clearCellValue(99, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("行はあるが該当fieldIdが無いセルのclearCellValueは空文字をセットし新参照を返す", () => {
    // cells: page1 に f1=100 のみ。f99 は未設定（undefined）
    setupCells([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)!;
    // clearCellValue(1, "f99") → f99 は未設定なので get() = undefined ≠ "" → no-op にならない
    useReportStore.getState().clearCellValue(1, "f99");
    const nextCells = useReportStore.getState().cells;
    // cells は新参照になる
    expect(nextCells).not.toBe(prevCells);
    // row も新参照になる
    expect(nextCells.get(1)).not.toBe(prevRow);
    // f99 に空文字がセットされる
    expect(nextCells.get(1)!.get("f99")).toBe("");
    // f1 の値は変わらない
    expect(nextCells.get(1)!.get("f1")).toBe("100");
  });
});

describe("moveCellValue", () => {
  it("swap モード（既定）: from と to の値を交換する", () => {
    setupCells([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    const row = useReportStore.getState().cells.get(1)!;
    expect(row.get("f1")).toBe("BBB");
    expect(row.get("f2")).toBe("AAA");
  });

  it("move モード: from の値を to に移し、from を空にする", () => {
    setupCells([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    useReportStore.getState().moveCellValue(1, "f1", "f2", "move");
    const row = useReportStore.getState().cells.get(1)!;
    expect(row.get("f1")).toBe("");
    expect(row.get("f2")).toBe("AAA");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)!;
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する", () => {
    setupCells([
      [1, [["f1", "AAA"], ["f2", "BBB"]]],
      [2, [["f1", "CCC"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    expect(useReportStore.getState().cells.get(2)).toBe(prevRow2);
  });

  it("from === to のとき no-op（cells の参照が変わらない）", () => {
    setupCells([[1, [["f1", "AAA"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().moveCellValue(1, "f1", "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページを渡したとき: 新規ページ行に空文字で処理される（swap）", () => {
    setupCells([[1, [["f1", "AAA"]]]]);
    // page 99 は存在しない → prevRow が空 Map として処理される
    useReportStore.getState().moveCellValue(99, "f1", "f2");
    const row = useReportStore.getState().cells.get(99)!;
    // vFrom = "", vTo = "" → swap 後も "" のまま
    // from !== to なので new Map が作られ、cells は更新される
    expect(row.get("f1")).toBe("");
    expect(row.get("f2")).toBe("");
  });
});

describe("既存 setCells の挙動不変確認", () => {
  it("setCells は CellMatrix をそのままストアに設定する", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "金額");
    const { fields } = useReportStore.getState().template;
    const matrix: Map<number, Map<string, string>> = new Map([
      [1, new Map([[fields[0].id, "1000"]])],
    ]);
    useReportStore.getState().setCells(matrix);
    expect(useReportStore.getState().cells.get(1)?.get(fields[0].id)).toBe("1000");
  });

  it("setCells は新しい Matrix を丸ごと置換する（前の cells は消える）", () => {
    setupCells([[1, [["f1", "OLD"]]]]);
    const newMatrix: Map<number, Map<string, string>> = new Map([
      [2, new Map([["f2", "NEW"]])],
    ]);
    useReportStore.getState().setCells(newMatrix);
    expect(useReportStore.getState().cells.has(1)).toBe(false);
    expect(useReportStore.getState().cells.get(2)?.get("f2")).toBe("NEW");
  });
});
