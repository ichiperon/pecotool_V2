import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
});

describe("setPageOffset", () => {
  it("(dx, dy) を設定するとページオフセット Map に追加される", () => {
    useReportStore.getState().setPageOffset(1, 10, -5);
    const offset = useReportStore.getState().pageOffsets.get(1);
    expect(offset).toEqual({ dx: 10, dy: -5 });
  });

  it("(0, 0) を設定するとキーが削除される（疎保持）", () => {
    useReportStore.getState().setPageOffset(1, 5, 3);
    useReportStore.getState().setPageOffset(1, 0, 0);
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);
  });

  it("既に (0, 0) 状態（キーなし）に (0, 0) を設定しても no-op（Map ref 変化なし）", () => {
    const before = useReportStore.getState().pageOffsets;
    useReportStore.getState().setPageOffset(1, 0, 0);
    const after = useReportStore.getState().pageOffsets;
    // no-op なので同一 ref
    expect(after).toBe(before);
  });

  it("前回と同値を設定しても no-op（Map ref 変化なし）", () => {
    useReportStore.getState().setPageOffset(1, 10, 5);
    const before = useReportStore.getState().pageOffsets;
    useReportStore.getState().setPageOffset(1, 10, 5);
    const after = useReportStore.getState().pageOffsets;
    expect(after).toBe(before);
  });

  it("setPageOffset は Map をイミュータブルに更新する（新規 Map を返す）", () => {
    const before = useReportStore.getState().pageOffsets;
    useReportStore.getState().setPageOffset(2, 3, 4);
    const after = useReportStore.getState().pageOffsets;
    expect(after).not.toBe(before);
  });
});

describe("nudgePageOffset", () => {
  it("前回オフセットに (ddx, ddy) を加算する", () => {
    useReportStore.getState().setPageOffset(1, 10, 5);
    useReportStore.getState().nudgePageOffset(1, 3, -2);
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 13, dy: 3 });
  });

  it("キーなし状態（ZERO_OFFSET）から nudge すると正しく加算される", () => {
    useReportStore.getState().nudgePageOffset(1, 5, 8);
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 5, dy: 8 });
  });

  it("nudge 結果が (0, 0) になるとキーが削除される", () => {
    useReportStore.getState().setPageOffset(1, 5, 3);
    useReportStore.getState().nudgePageOffset(1, -5, -3);
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);
  });
});

describe("clearPageOffset", () => {
  it("設定済みオフセットを削除する", () => {
    useReportStore.getState().setPageOffset(1, 5, 5);
    useReportStore.getState().clearPageOffset(1);
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);
  });

  it("キーが存在しない場合は no-op（Map ref 変化なし）", () => {
    const before = useReportStore.getState().pageOffsets;
    useReportStore.getState().clearPageOffset(99);
    expect(useReportStore.getState().pageOffsets).toBe(before);
  });
});

describe("clearTemplate", () => {
  it("clearTemplate で pageOffsets もリセットされる", () => {
    useReportStore.getState().setPageOffset(1, 10, 5);
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().clearTemplate();
    expect(useReportStore.getState().pageOffsets.size).toBe(0);
    expect(useReportStore.getState().template.fields).toHaveLength(0);
  });
});

describe("setCellsForPage", () => {
  it("指定ページの cells 行を設定する（ReportRow 単体は [row] に正規化）", () => {
    const row = new Map([["field-1", "value1"]]);
    useReportStore.getState().setCellsForPage(1, row);
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("value1");
  });

  it("ReportRow[] を渡すと複数段として設定される", () => {
    const rows = [
      new Map([["field-1", "row0"]]),
      new Map([["field-1", "row1"]]),
    ];
    useReportStore.getState().setCellsForPage(1, rows);
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("row0");
    expect(useReportStore.getState().cells.get(1)?.[1]?.get("field-1")).toBe("row1");
  });

  it("他ページの cells は保持される", () => {
    useReportStore.setState({
      cells: new Map([[2, [new Map([["field-a", "page2val"]])]]]),
    });
    useReportStore.getState().setCellsForPage(1, new Map([["field-1", "new"]]));
    expect(useReportStore.getState().cells.get(2)?.[0]?.get("field-a")).toBe("page2val");
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("new");
  });

  it("setCellsForPage は渡した row の新規コピーを格納する（元 Map の変更が伝播しない）", () => {
    const row = new Map([["field-1", "original"]]);
    useReportStore.getState().setCellsForPage(1, row);
    // 呼び出し元の row を変更
    row.set("field-1", "mutated");
    // store の値は変化しない
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("original");
  });

  it("cells をイミュータブルに更新する（新規 Map を返す）", () => {
    const before = useReportStore.getState().cells;
    useReportStore.getState().setCellsForPage(3, new Map([["f", "v"]]));
    expect(useReportStore.getState().cells).not.toBe(before);
  });
});
