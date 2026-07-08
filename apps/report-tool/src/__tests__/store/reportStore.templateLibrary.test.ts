import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";
import type { ReportField, ReportRow } from "../../types/report";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

const OLD_FIELD: ReportField = { id: "old-1", name: "旧欄", color: "#7cb9e8", rect: SAMPLE_RECT };
const NEW_FIELDS: ReportField[] = [
  { id: "new-1", name: "新欄A", color: "#90c8a0", rect: SAMPLE_RECT },
  { id: "new-2", name: "新欄B", color: "#f5b8a0", rect: SAMPLE_RECT, isLineItem: true },
];

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

describe("replaceTemplateFields", () => {
  it("template.fields を渡した fields に置き換える", () => {
    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);
    expect(useReportStore.getState().template.fields).toEqual(NEW_FIELDS);
  });

  it("旧テンプレートの cells を破棄する（孤児セル残留を防ぐ・最重要不変条件）", () => {
    // 旧テンプレート下でセルにデータを入れておく
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    useReportStore.getState().setCellValue(1, OLD_FIELD.id, "値A");
    expect(useReportStore.getState().cells.get(1)?.[0].get(OLD_FIELD.id)).toBe("値A");

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("confidences を破棄する", () => {
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    const rows: Array<Map<string, number>> = [new Map([[OLD_FIELD.id, 0.9]])];
    useReportStore.getState().setConfidencesForPage(1, rows);
    expect(useReportStore.getState().confidences.get(1)).toBeDefined();

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    expect(useReportStore.getState().confidences.size).toBe(0);
  });

  it("pageOffsets を破棄する", () => {
    useReportStore.getState().setPageOffset(1, 10, -5);
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(true);

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    expect(useReportStore.getState().pageOffsets.size).toBe(0);
  });

  it("cells/confidences/pageOffsets が全て同時に空になる（1回の呼び出しで原子的に）", () => {
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    useReportStore.getState().setCellValue(1, OLD_FIELD.id, "値A");
    useReportStore.getState().setConfidencesForPage(1, [new Map([[OLD_FIELD.id, 0.9]])]);
    useReportStore.getState().setPageOffset(2, 3, 4);

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    const state = useReportStore.getState();
    expect(state.cells.size).toBe(0);
    expect(state.confidences.size).toBe(0);
    expect(state.pageOffsets.size).toBe(0);
    expect(state.template.fields).toEqual(NEW_FIELDS);
  });

  it("複数ページ・複数段のセルがあってもすべて破棄される", () => {
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    const rows: ReportRow[] = [new Map([[OLD_FIELD.id, "行1"]]), new Map([[OLD_FIELD.id, "行2"]])];
    useReportStore.getState().setCellsForPage(1, rows);
    useReportStore.getState().setCellsForPage(2, rows);
    expect(useReportStore.getState().cells.size).toBe(2);

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("mode は変更しないが selectedFieldId は null にクリアする（旧欄idの孤児選択防止）", () => {
    useReportStore.getState().setMode("defineField");
    useReportStore.getState().selectField("some-id");

    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);

    expect(useReportStore.getState().mode).toBe("defineField");
    expect(useReportStore.getState().selectedFieldId).toBeNull();
  });

  it("空配列を渡すと欄が全削除される", () => {
    useReportStore.getState().replaceTemplateFields(NEW_FIELDS);
    expect(useReportStore.getState().template.fields).toHaveLength(2);

    useReportStore.getState().replaceTemplateFields([]);
    expect(useReportStore.getState().template.fields).toEqual([]);
  });
});
