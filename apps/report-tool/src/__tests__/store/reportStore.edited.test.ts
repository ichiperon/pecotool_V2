import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    edited: new Map(),
    past: [],
    future: [],
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
});

function makeFields(names: string[]): string[] {
  names.forEach((n) => useReportStore.getState().addField(SAMPLE_RECT, n));
  return useReportStore.getState().template.fields.map((f) => f.id);
}

function seedCells(pairs: [string, string][], page = 1) {
  useReportStore.getState().setCells(new Map([[page, [new Map(pairs)]]]));
}

function isEdited(page: number, row: number, fieldId: string): boolean {
  return useReportStore.getState().edited.get(page)?.[row]?.has(fieldId) === true;
}

describe("手修正フラグ: セル編集系で立つ", () => {
  it("setCellValue でフラグが立つ", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    expect(isEdited(1, 0, id)).toBe(false);

    useReportStore.getState().setCellValue(1, id, "200");
    expect(isEdited(1, 0, id)).toBe(true);
  });

  it("clearCellValue（削除）でもフラグが立つ — 人が意図して空にした証跡", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().clearCellValue(1, id);
    expect(isEdited(1, 0, id)).toBe(true);
  });

  it("moveCellValue で from/to 両方にフラグが立つ", () => {
    const [idA, idB] = makeFields(["A", "B"]);
    seedCells([
      [idA, "あ"],
      [idB, "い"],
    ]);
    useReportStore.getState().moveCellValue(1, idA, idB, "swap");
    expect(isEdited(1, 0, idA)).toBe(true);
    expect(isEdited(1, 0, idB)).toBe(true);
  });

  it("no-op（同値 setCellValue）ではフラグが立たない", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "100");
    expect(isEdited(1, 0, id)).toBe(false);
  });
});

describe("手修正フラグ: 段構造変更で index が正しくリマップされる", () => {
  it("insertRowAt で挿入位置以降のフラグが段ごと下にずれる", () => {
    const [id] = makeFields(["明細"]);
    useReportStore
      .getState()
      .setCells(new Map([[1, [new Map([[id, "1段目"]]), new Map([[id, "2段目"]])]]]));
    useReportStore.getState().setCellValue(1, id, "2段目改", 1);
    expect(isEdited(1, 1, id)).toBe(true);

    // 先頭に空段を挿入 → フラグは段2（index 2）へ移動しているべき
    useReportStore.getState().insertRowAt(1, -1);
    expect(isEdited(1, 1, id)).toBe(false);
    expect(isEdited(1, 2, id)).toBe(true);
  });

  it("removeRowAt で削除段のフラグが消え、後続の段のフラグが上にずれる", () => {
    const [id] = makeFields(["明細"]);
    useReportStore
      .getState()
      .setCells(new Map([[1, [new Map([[id, "1段目"]]), new Map([[id, "2段目"]])]]]));
    useReportStore.getState().setCellValue(1, id, "2段目改", 1);

    useReportStore.getState().removeRowAt(1, 0);
    expect(isEdited(1, 0, id)).toBe(true); // 旧段2のフラグが段1へ
  });

  it("splitCellToNextRow で両断片にフラグが立つ", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "りんごみかん"]]);
    useReportStore.getState().splitCellToNextRow(1, 0, id, 3);
    expect(isEdited(1, 0, id)).toBe(true);
    expect(isEdited(1, 1, id)).toBe(true);
  });

  it("splitCellByNewlines で全断片にフラグが立つ", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "a\nb\nc"]]);
    useReportStore.getState().splitCellByNewlines(1, 0, id);
    expect(isEdited(1, 0, id)).toBe(true);
    expect(isEdited(1, 1, id)).toBe(true);
    expect(isEdited(1, 2, id)).toBe(true);
  });
});

describe("手修正フラグ: クリア契機", () => {
  it("setCellsForPage（再 OCR）で該当ページのフラグが消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    expect(isEdited(1, 0, id)).toBe(true);

    useReportStore.getState().setCellsForPage(1, new Map([[id, "999"]]));
    expect(isEdited(1, 0, id)).toBe(false);
  });

  it("setCellsForPage は他ページのフラグを消さない", () => {
    const [id] = makeFields(["金額"]);
    useReportStore.getState().setCells(
      new Map([
        [1, [new Map([[id, "p1"]])]],
        [2, [new Map([[id, "p2"]])]],
      ])
    );
    useReportStore.getState().setCellValue(2, id, "p2改");

    useReportStore.getState().setCellsForPage(1, new Map([[id, "p1新"]]));
    expect(isEdited(2, 0, id)).toBe(true);
  });

  it("setCells（全ページ OCR 取り込み）で全フラグが消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    seedCells([[id, "999"]]);
    expect(isEdited(1, 0, id)).toBe(false);
  });

  it("replaceTemplateFields / resetExtractedData でフラグが消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    useReportStore.getState().resetExtractedData();
    expect(useReportStore.getState().edited.size).toBe(0);
  });
});

describe("手修正フラグ: undo/redo との整合", () => {
  it("フラグを立てた操作を undo するとフラグも戻る", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    expect(isEdited(1, 0, id)).toBe(true);

    useReportStore.getState().undo();
    expect(isEdited(1, 0, id)).toBe(false);

    useReportStore.getState().redo();
    expect(isEdited(1, 0, id)).toBe(true);
  });

  it("splitCellByNewlines を undo すると断片フラグが消え edited の段構造も分割前に戻る", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "a\nb\nc"]]);
    expect(useReportStore.getState().edited.get(1)).toBeUndefined();

    useReportStore.getState().splitCellByNewlines(1, 0, id);
    expect(useReportStore.getState().edited.get(1)).toHaveLength(3);
    expect(isEdited(1, 0, id)).toBe(true);
    expect(isEdited(1, 2, id)).toBe(true);

    useReportStore.getState().undo();
    // 分割前の edited（ページエントリなし）へ完全復元 — 幽霊フラグが残らない
    expect(useReportStore.getState().edited.get(1)).toBeUndefined();
    expect(isEdited(1, 0, id)).toBe(false);

    useReportStore.getState().redo();
    expect(useReportStore.getState().edited.get(1)).toHaveLength(3);
    expect(isEdited(1, 1, id)).toBe(true);
  });

  it("既存フラグがある段の後ろで splitCellToNextRow → undo でフラグ位置が元に戻る", () => {
    const [idA, idB] = makeFields(["明細", "備考"]);
    useReportStore
      .getState()
      .setCells(new Map([[1, [new Map([[idA, "りんごみかん"], [idB, "メモ"]])]]]));
    useReportStore.getState().setCellValue(1, idB, "メモ改"); // 段0 の idB にフラグ
    expect(isEdited(1, 0, idB)).toBe(true);

    useReportStore.getState().splitCellToNextRow(1, 0, idA, 3);
    expect(isEdited(1, 0, idA)).toBe(true);
    expect(isEdited(1, 1, idA)).toBe(true);
    expect(isEdited(1, 0, idB)).toBe(true); // 既存フラグは保持

    useReportStore.getState().undo();
    expect(isEdited(1, 0, idA)).toBe(false); // 分割フラグは消える
    expect(isEdited(1, 1, idA)).toBe(false);
    expect(isEdited(1, 0, idB)).toBe(true); // 分割前に立てたフラグは残る
  });
});
