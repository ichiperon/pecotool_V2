import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";
import type { ReportRow } from "../../types/report";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

// テスト用ユーティリティ: 指定構造の cells を State に設定する（新形 Map<number, ReportRow[]>）
function setupCells(entries: [number, [string, string][][]][]) {
  const matrix: Map<number, ReportRow[]> = new Map();
  for (const [page, rowsData] of entries) {
    matrix.set(page, rowsData.map((pairs) => new Map(pairs)));
  }
  useReportStore.setState({ cells: matrix });
}

// 後方互換ヘルパー: 単段の entries を受け取る（[page, pairs[]] → [page, [pairs][]]）
function setupCells1(entries: [number, [string, string][]][]) {
  setupCells(entries.map(([page, pairs]) => [page, [pairs]] as [number, [string, string][][]]));
}

describe("setCellValue", () => {
  it("指定ページ・欄の値を更新する（rowIndex=0 既定）", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    useReportStore.getState().setCellValue(1, "f1", "999");
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("f1")).toBe("999");
  });

  it("rowIndex=1 を指定すると 2 段目に設定される", () => {
    setupCells([[1, [[["f1", "row0"]], [["f1", "row1"]]]]]);
    useReportStore.getState().setCellValue(1, "f1", "updated", 1);
    expect(useReportStore.getState().cells.get(1)?.[1]?.get("f1")).toBe("updated");
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("f1")).toBe("row0");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)![0];
    useReportStore.getState().setCellValue(1, "f1", "999");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)![0]).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する（不要な参照コピーなし）", () => {
    setupCells1([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().setCellValue(1, "f1", "999");
    const nextRow2 = useReportStore.getState().cells.get(2)!;
    expect(nextRow2).toBe(prevRow2);
  });

  it("値が変わらない場合は no-op（cells の参照が変わらない）", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().setCellValue(1, "f1", "100");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページに値をセットするとページ行が新規作成される", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    useReportStore.getState().setCellValue(99, "f99", "hello");
    expect(useReportStore.getState().cells.get(99)?.[0]?.get("f99")).toBe("hello");
  });
});

describe("clearCellValue", () => {
  it("指定ページ・欄の値を空文字にする（キーは残る）", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    useReportStore.getState().clearCellValue(1, "f1");
    const row = useReportStore.getState().cells.get(1)![0];
    expect(row.has("f1")).toBe(true);
    expect(row.get("f1")).toBe("");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)![0];
    useReportStore.getState().clearCellValue(1, "f1");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)![0]).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する", () => {
    setupCells1([
      [1, [["f1", "100"]]],
      [2, [["f1", "200"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().clearCellValue(1, "f1");
    expect(useReportStore.getState().cells.get(2)).toBe(prevRow2);
  });

  it("既に空文字のとき no-op（cells の参照が変わらない）", () => {
    setupCells1([[1, [["f1", ""]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().clearCellValue(1, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページを渡したとき no-op", () => {
    setupCells1([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().clearCellValue(99, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("行はあるが該当fieldIdが無い（undefined）セルの clearCellValue は no-op", () => {
    // cells: page1 に f1=100 のみ。f99 は未設定（undefined）。
    // undefined も表示上は同じ「(空)」なので、書き込みを許すと見た目が変わらないのに
    // 手修正バッジと undo 履歴だけが積まれる — レビュー指摘（MINOR）で no-op に統一。
    setupCells1([[1, [["f1", "100"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevPast = useReportStore.getState().past;
    useReportStore.getState().clearCellValue(1, "f99");
    // no-op: cells も履歴も参照ごと変わらない
    expect(useReportStore.getState().cells).toBe(prevCells);
    expect(useReportStore.getState().past).toBe(prevPast);
    // f1 の値は変わらない
    expect(prevCells.get(1)![0].get("f1")).toBe("100");
  });
});

describe("moveCellValue", () => {
  it("swap モード（既定）: from と to の値を交換する", () => {
    setupCells1([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    const row = useReportStore.getState().cells.get(1)![0];
    expect(row.get("f1")).toBe("BBB");
    expect(row.get("f2")).toBe("AAA");
  });

  it("move モード: from の値を to に移し、from を空にする", () => {
    setupCells1([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    useReportStore.getState().moveCellValue(1, "f1", "f2", "move");
    const row = useReportStore.getState().cells.get(1)![0];
    expect(row.get("f1")).toBe("");
    expect(row.get("f2")).toBe("AAA");
  });

  it("cells と row が両方新規参照になる（イミュータブル更新）", () => {
    setupCells1([[1, [["f1", "AAA"], ["f2", "BBB"]]]]);
    const prevCells = useReportStore.getState().cells;
    const prevRow = prevCells.get(1)![0];
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    const nextCells = useReportStore.getState().cells;
    expect(nextCells).not.toBe(prevCells);
    expect(nextCells.get(1)![0]).not.toBe(prevRow);
  });

  it("他のページの row は同一参照を維持する", () => {
    setupCells1([
      [1, [["f1", "AAA"], ["f2", "BBB"]]],
      [2, [["f1", "CCC"]]],
    ]);
    const prevRow2 = useReportStore.getState().cells.get(2)!;
    useReportStore.getState().moveCellValue(1, "f1", "f2");
    expect(useReportStore.getState().cells.get(2)).toBe(prevRow2);
  });

  it("from === to のとき no-op（cells の参照が変わらない）", () => {
    setupCells1([[1, [["f1", "AAA"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().moveCellValue(1, "f1", "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("存在しないページを渡したとき: 新規ページ行に空文字で処理される（swap）", () => {
    setupCells1([[1, [["f1", "AAA"]]]]);
    // page 99 は存在しない → prevRow が空 Map として処理される
    useReportStore.getState().moveCellValue(99, "f1", "f2");
    const row = useReportStore.getState().cells.get(99)![0];
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
    const matrix: Map<number, Map<string, string>[]> = new Map([
      [1, [new Map([[fields[0].id, "1000"]])]],
    ]);
    useReportStore.getState().setCells(matrix);
    expect(useReportStore.getState().cells.get(1)?.[0]?.get(fields[0].id)).toBe("1000");
  });

  it("setCells は新しい Matrix を丸ごと置換する（前の cells は消える）", () => {
    setupCells1([[1, [["f1", "OLD"]]]]);
    const newMatrix: Map<number, Map<string, string>[]> = new Map([
      [2, [new Map([["f2", "NEW"]])]],
    ]);
    useReportStore.getState().setCells(newMatrix);
    expect(useReportStore.getState().cells.has(1)).toBe(false);
    expect(useReportStore.getState().cells.get(2)?.[0]?.get("f2")).toBe("NEW");
  });
});

// ---------------------------------------------------------------------------
// 新規アクションのテスト
// ---------------------------------------------------------------------------

describe("insertRowAt", () => {
  it("afterRowIndex=0 の直後に空段を挿入する", () => {
    setupCells1([[1, [["f1", "A"]]]]);
    useReportStore.getState().insertRowAt(1, 0);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(2);
    expect(rows[0].get("f1")).toBe("A");
    // 挿入された段は空
    expect(rows[1].size).toBe(0);
  });

  it("afterRowIndex=-1 で先頭に挿入する", () => {
    setupCells1([[1, [["f1", "A"]]]]);
    useReportStore.getState().insertRowAt(1, -1);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(2);
    // 先頭が新しい空段
    expect(rows[0].size).toBe(0);
    expect(rows[1].get("f1")).toBe("A");
  });

  it("複数段ある場合に中間に挿入できる", () => {
    setupCells([[1, [[["f1", "A"]], [["f1", "B"]], [["f1", "C"]]]]]);
    useReportStore.getState().insertRowAt(1, 1);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(4);
    expect(rows[0].get("f1")).toBe("A");
    expect(rows[1].get("f1")).toBe("B");
    expect(rows[2].size).toBe(0); // 挿入された空段
    expect(rows[3].get("f1")).toBe("C");
  });
});

describe("removeRowAt", () => {
  it("指定インデックスの段を削除する", () => {
    setupCells([[1, [[["f1", "A"]], [["f1", "B"]]]]]);
    useReportStore.getState().removeRowAt(1, 0);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(1);
    expect(rows[0].get("f1")).toBe("B");
  });

  it("最後の 1 段は削除しない（no-op）", () => {
    setupCells1([[1, [["f1", "A"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().removeRowAt(1, 0);
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("cells はイミュータブルに更新される", () => {
    setupCells([[1, [[["f1", "A"]], [["f1", "B"]]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().removeRowAt(1, 1);
    expect(useReportStore.getState().cells).not.toBe(prevCells);
  });
});

describe("splitCellToNextRow", () => {
  it("値を splitAt で分割して現段と新段に格納する", () => {
    setupCells1([[1, [["f1", "ABCDE"]]]]);
    useReportStore.getState().splitCellToNextRow(1, 0, "f1", 3);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(2);
    expect(rows[0].get("f1")).toBe("ABC");
    expect(rows[1].get("f1")).toBe("DE");
  });

  it("新段には他欄が入らない（固定欄も新段にはコピーしない）", () => {
    setupCells1([[1, [["f1", "ABC"], ["f2", "FIXED"]]]]);
    useReportStore.getState().splitCellToNextRow(1, 0, "f1", 1);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows[1].has("f2")).toBe(false);
  });

  it("splitAt=0 のとき before が空文字・after が全体", () => {
    setupCells1([[1, [["f1", "HELLO"]]]]);
    useReportStore.getState().splitCellToNextRow(1, 0, "f1", 0);
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows[0].get("f1")).toBe("");
    expect(rows[1].get("f1")).toBe("HELLO");
  });
});

describe("splitCellByNewlines", () => {
  it("改行で分割して各段に格納する", () => {
    setupCells1([[1, [["f1", "A\nB\nC"]]]]);
    useReportStore.getState().splitCellByNewlines(1, 0, "f1");
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(3);
    expect(rows[0].get("f1")).toBe("A");
    expect(rows[1].get("f1")).toBe("B");
    expect(rows[2].get("f1")).toBe("C");
  });

  it("改行が無い場合（1 要素）は何もしない（no-op）", () => {
    setupCells1([[1, [["f1", "HELLO"]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().splitCellByNewlines(1, 0, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("空文字は何もしない（no-op）", () => {
    setupCells1([[1, [["f1", ""]]]]);
    const prevCells = useReportStore.getState().cells;
    useReportStore.getState().splitCellByNewlines(1, 0, "f1");
    expect(useReportStore.getState().cells).toBe(prevCells);
  });

  it("2 行の場合: 先頭段に 1 行目・新段に 2 行目", () => {
    setupCells1([[1, [["f1", "LINE1\nLINE2"]]]]);
    useReportStore.getState().splitCellByNewlines(1, 0, "f1");
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(2);
    expect(rows[0].get("f1")).toBe("LINE1");
    expect(rows[1].get("f1")).toBe("LINE2");
  });
});
