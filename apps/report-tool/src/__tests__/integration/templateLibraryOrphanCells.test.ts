import { describe, it, expect, vi, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";
import { useTemplateLibraryStore } from "../../store/templateLibraryStore";
import { templateStorage } from "../../lib/templateStorage";
import { serializeTemplate } from "../../logic/templateLibrary";
import { buildTemplateCsv } from "../../logic/templateCsv";
import type { ReportField, CsvOptions } from "../../types/report";

/**
 * エンドツーエンド統合テスト: 「別テンプレ読込で旧 fieldId 由来の値が
 * CSV 出力に一切混入しない」孤児セル不変条件を、reportStore（OCR結果格納）
 * → templateLibraryStore.load（テンプレ切替）→ templateCsv（出力）まで
 * 実コードパスを通して検証する。
 *
 * 個々の層（reportStore.replaceTemplateFields / templateLibraryStore.load）は
 * 単体テストで別途カバー済み。本ファイルは層をまたいだ結合を確認する。
 */
vi.mock("../../lib/templateStorage", () => ({
  templateStorage: {
    saveTemplate: vi.fn(),
    listTemplates: vi.fn(),
    loadTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
  },
}));

const RECT = { x: 0, y: 0, width: 100, height: 30 };

const OLD_FIELDS: ReportField[] = [
  { id: "old-amount", name: "旧金額", color: "#7cb9e8", rect: RECT },
  { id: "old-date", name: "旧日付", color: "#90c8a0", rect: RECT },
  { id: "old-vendor", name: "旧取引先", color: "#f5b8a0", rect: RECT },
];

const NEW_FIELDS: ReportField[] = [
  { id: "new-total", name: "新合計", color: "#c8a8e0", rect: RECT },
  { id: "new-memo", name: "新メモ", color: "#f5d898", rect: RECT },
];

const CSV_OPTS: CsvOptions = {
  includeFileName: false,
  includePageNumber: true,
  emptyValue: "",
  normalizeNumbers: false,
};

beforeEach(() => {
  vi.mocked(templateStorage.saveTemplate).mockReset();
  vi.mocked(templateStorage.listTemplates).mockReset();
  vi.mocked(templateStorage.loadTemplate).mockReset();
  vi.mocked(templateStorage.deleteTemplate).mockReset();

  useTemplateLibraryStore.setState({ summaries: [], status: "idle", error: null });
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
});

describe("孤児セル不変条件（reportStore + templateLibraryStore + templateCsv 結合）", () => {
  it("OCR結果が入った状態で別テンプレをloadすると、旧fieldId由来の値がCSVに一切混入しない", async () => {
    // ① 欄3つのテンプレートで OCR 結果を模した cells/confidences/pageOffsets を投入する。
    useReportStore.setState({ template: { fields: OLD_FIELDS } });
    useReportStore.getState().setCellsForPage(1, [
      new Map([
        ["old-amount", "12,000"],
        ["old-date", "2026-01-01"],
        ["old-vendor", "テスト商事"],
      ]),
    ]);
    useReportStore.getState().setConfidencesForPage(1, [
      new Map([
        ["old-amount", 0.95],
        ["old-date", 0.88],
        ["old-vendor", 0.72],
      ]),
    ]);
    useReportStore.getState().setPageOffset(1, 3, -2);

    // 投入直後は旧テンプレートの CSV に旧値が正しく現れる（前提のサニティ確認）。
    const beforeCsv = buildTemplateCsv(
      { fields: OLD_FIELDS },
      useReportStore.getState().cells,
      CSV_OPTS,
      { pageNumbers: [1] }
    );
    expect(beforeCsv).toContain("12,000");
    expect(beforeCsv).toContain("テスト商事");

    // ② fieldId が全く異なる別テンプレートを load する。
    const newTemplateJson = serializeTemplate(NEW_FIELDS, "新テンプレ", "2026-07-08T00:00:00.000Z", {
      id: "tmpl-new",
    });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: newTemplateJson });

    const loadResult = await useTemplateLibraryStore.getState().load("tmpl-new");
    expect(loadResult.status).toBe("loaded");

    // ③ cells/confidences/pageOffsets が空になっている（孤児セル不変条件）。
    const state = useReportStore.getState();
    expect(state.cells.size).toBe(0);
    expect(state.confidences.size).toBe(0);
    expect(state.pageOffsets.size).toBe(0);
    expect(state.template.fields).toEqual(NEW_FIELDS);

    // ④ 新テンプレートで CSV を出力しても、旧値・旧欄名は一切現れない。
    const afterCsv = buildTemplateCsv(
      { fields: state.template.fields },
      state.cells,
      CSV_OPTS,
      { pageNumbers: [1] }
    );
    expect(afterCsv).not.toContain("12,000");
    expect(afterCsv).not.toContain("2026-01-01");
    expect(afterCsv).not.toContain("テスト商事");
    expect(afterCsv).not.toContain("旧金額");
    expect(afterCsv).not.toContain("旧日付");
    expect(afterCsv).not.toContain("旧取引先");

    // ヘッダは新テンプレートの欄名のみ、データ行は emptyValue のみで構成される。
    const [header, dataRow] = afterCsv.split("\r\n");
    expect(header).toBe("ページ,新合計,新メモ");
    expect(dataRow).toBe("1,,");
  });

  it("新テンプレ読込後にOCRを再実行して新fieldIdで値を入れても、出力CSVに旧値との混線がない", async () => {
    useReportStore.setState({ template: { fields: OLD_FIELDS } });
    useReportStore.getState().setCellsForPage(1, [new Map([["old-amount", "旧値999"]])]);

    const newTemplateJson = serializeTemplate(NEW_FIELDS, "新テンプレ", "2026-07-08T00:00:00.000Z", {
      id: "tmpl-new",
    });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: newTemplateJson });
    await useTemplateLibraryStore.getState().load("tmpl-new");

    // 新テンプレート下で新規に OCR 相当のセル入力を行う。
    useReportStore.getState().setCellsForPage(1, [
      new Map([
        ["new-total", "5,000"],
        ["new-memo", "備考A"],
      ]),
    ]);

    const csv = buildTemplateCsv(
      { fields: useReportStore.getState().template.fields },
      useReportStore.getState().cells,
      CSV_OPTS,
      { pageNumbers: [1] }
    );

    expect(csv).toContain("5,000");
    expect(csv).toContain("備考A");
    expect(csv).not.toContain("旧値999");
  });
});
