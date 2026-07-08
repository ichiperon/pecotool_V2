import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";
import { listReviewTargets } from "../../logic/reviewTargets";

const RECT = { x: 0, y: 0, width: 100, height: 30 };

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
    excludedPages: new Set(),
  });
});

describe("ページ除外（excludedPages）", () => {
  it("togglePageExclusion で除外⇔解除がトグルする", () => {
    useReportStore.getState().togglePageExclusion(2);
    expect(useReportStore.getState().excludedPages.has(2)).toBe(true);
    useReportStore.getState().togglePageExclusion(2);
    expect(useReportStore.getState().excludedPages.has(2)).toBe(false);
  });

  it("resetExtractedData（PDF差し替え）で除外がクリアされる", () => {
    useReportStore.getState().togglePageExclusion(3);
    useReportStore.getState().resetExtractedData();
    expect(useReportStore.getState().excludedPages.size).toBe(0);
  });

  it("テンプレ置換（replaceTemplateFields）では除外を保持する（PDF個体の属性）", () => {
    useReportStore.getState().togglePageExclusion(3);
    useReportStore.getState().replaceTemplateFields([
      { id: "n1", name: "新欄", color: "#7cb9e8", rect: RECT },
    ]);
    expect(useReportStore.getState().excludedPages.has(3)).toBe(true);
  });

  it("undo は除外状態を巻き戻さない（スナップショット対象外）", () => {
    useReportStore.getState().addField(RECT, "金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setCells(new Map([[1, [new Map([[id, "a"]])]]]));
    useReportStore.getState().setCellValue(1, id, "b");
    useReportStore.getState().togglePageExclusion(1);
    useReportStore.getState().undo();
    expect(useReportStore.getState().excludedPages.has(1)).toBe(true);
  });

  it("listReviewTargets は除外ページの要確認セルを数えない", () => {
    useReportStore.getState().addField(RECT, "金額");
    const id = useReportStore.getState().template.fields[0].id;
    const cells = new Map([
      [1, [new Map([[id, ""]])]], // 空=要確認
      [2, [new Map([[id, ""]])]], // 空だが除外予定
    ]);
    const targets = listReviewTargets(cells, new Map(), useReportStore.getState().template.fields, new Set([2]));
    expect(targets).toEqual([{ pageNum: 1, rowIndex: 0, fieldId: id, kind: "empty" }]);
  });
});
