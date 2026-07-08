import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTemplateLibraryStore } from "../../store/templateLibraryStore";
import { useReportStore } from "../../store/reportStore";
import { templateStorage } from "../../lib/templateStorage";
import { serializeTemplate } from "../../logic/templateLibrary";
import type { ReportField } from "../../types/report";

vi.mock("../../lib/templateStorage", () => ({
  templateStorage: {
    saveTemplate: vi.fn(),
    listTemplates: vi.fn(),
    loadTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
  },
}));

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };
const OLD_FIELD: ReportField = { id: "old-1", name: "旧欄", color: "#7cb9e8", rect: SAMPLE_RECT };
const FIELDS: ReportField[] = [{ id: "f1", name: "金額", color: "#90c8a0", rect: SAMPLE_RECT }];

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

describe("refreshList", () => {
  it("成功時に summaries を更新する", async () => {
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({
      ok: true,
      value: [{ id: "a", name: "A", savedAt: "2026-01-01", schemaVersion: 1, readable: true }],
    });

    await useTemplateLibraryStore.getState().refreshList();

    expect(useTemplateLibraryStore.getState().summaries).toHaveLength(1);
    expect(useTemplateLibraryStore.getState().status).toBe("idle");
    expect(useTemplateLibraryStore.getState().error).toBeNull();
  });

  it("失敗時は error を設定し summaries を空にする", async () => {
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({
      ok: false,
      reason: "list failed",
    });

    await useTemplateLibraryStore.getState().refreshList();

    expect(useTemplateLibraryStore.getState().summaries).toEqual([]);
    expect(useTemplateLibraryStore.getState().status).toBe("error");
    expect(useTemplateLibraryStore.getState().error).toBe("list failed");
  });

  it("破損テンプレート（readable:false）が混ざっても summaries から落とさない", async () => {
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({
      ok: true,
      value: [
        { id: "a", name: "A", savedAt: "2026-01-01", schemaVersion: 1, readable: true },
        { id: "b", name: "?", savedAt: "", schemaVersion: 0, readable: false },
      ],
    });

    await useTemplateLibraryStore.getState().refreshList();

    expect(useTemplateLibraryStore.getState().summaries).toHaveLength(2);
    expect(useTemplateLibraryStore.getState().summaries[1].readable).toBe(false);
  });
});

describe("saveAs", () => {
  it("不正な名前はバリデーションエラーで保存しない", async () => {
    const result = await useTemplateLibraryStore.getState().saveAs("", "2026-01-01T00:00:00.000Z");
    expect(result.status).toBe("error");
    expect(templateStorage.saveTemplate).not.toHaveBeenCalled();
  });

  it("同名なしなら新規 id で保存し refreshList する", async () => {
    useReportStore.setState({ template: { fields: FIELDS } });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({ ok: true, value: [] });

    const result = await useTemplateLibraryStore.getState().saveAs("新規A", "2026-01-01T00:00:00.000Z");

    expect(result.status).toBe("saved");
    expect(templateStorage.saveTemplate).toHaveBeenCalledTimes(1);
    const [, json] = vi.mocked(templateStorage.saveTemplate).mock.calls[0];
    const record = JSON.parse(json as string);
    expect(record.name).toBe("新規A");
    expect(record.fields).toEqual(FIELDS);
    expect(templateStorage.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("同名の既存テンプレートがあると保存せず conflict を返す（overwriteId 未指定）", async () => {
    useTemplateLibraryStore.setState({
      summaries: [{ id: "existing-1", name: "重複名", savedAt: "2025-01-01", schemaVersion: 1, readable: true }],
    });

    const result = await useTemplateLibraryStore.getState().saveAs("重複名", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "conflict", existingId: "existing-1" });
    expect(templateStorage.saveTemplate).not.toHaveBeenCalled();
  });

  it("overwriteId を指定すると同名チェックをスキップして同一idで上書き保存する", async () => {
    useTemplateLibraryStore.setState({
      summaries: [{ id: "existing-1", name: "重複名", savedAt: "2025-01-01", schemaVersion: 1, readable: true }],
    });
    useReportStore.setState({ template: { fields: FIELDS } });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({ ok: true, value: [] });

    const result = await useTemplateLibraryStore
      .getState()
      .saveAs("重複名", "2026-01-01T00:00:00.000Z", "existing-1");

    expect(result).toEqual({ status: "saved", id: "existing-1" });
    const [id] = vi.mocked(templateStorage.saveTemplate).mock.calls[0];
    expect(id).toBe("existing-1");
  });

  it("保存失敗時は error を返す", async () => {
    useReportStore.setState({ template: { fields: FIELDS } });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: false, reason: "disk full" });

    const result = await useTemplateLibraryStore.getState().saveAs("A", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "error", reason: "disk full" });
  });
});

describe("load", () => {
  it("成功時に useReportStore.replaceTemplateFields を反映し record を返す", async () => {
    const json = serializeTemplate(FIELDS, "テンプレA", "2026-01-01T00:00:00.000Z", { id: "tmpl-1" });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: json });

    const result = await useTemplateLibraryStore.getState().load("tmpl-1");

    expect(result.status).toBe("loaded");
    expect(useReportStore.getState().template.fields).toEqual(FIELDS);
    expect(useTemplateLibraryStore.getState().status).toBe("idle");
  });

  it("load 後に旧テンプレートの cells/confidences/pageOffsets が空になる（最重要不変条件・孤児セル防止）", async () => {
    // 旧テンプレート下でセル・信頼度・オフセットにデータを入れておく
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    useReportStore.getState().setCellValue(1, OLD_FIELD.id, "旧値");
    useReportStore.getState().setConfidencesForPage(1, [new Map([[OLD_FIELD.id, 0.8]])]);
    useReportStore.getState().setPageOffset(1, 5, 5);

    const json = serializeTemplate(FIELDS, "テンプレA", "2026-01-01T00:00:00.000Z", { id: "tmpl-1" });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: json });

    await useTemplateLibraryStore.getState().load("tmpl-1");

    const state = useReportStore.getState();
    expect(state.cells.size).toBe(0);
    expect(state.confidences.size).toBe(0);
    expect(state.pageOffsets.size).toBe(0);
    expect(state.template.fields).toEqual(FIELDS);
  });

  it("loadTemplate 失敗時は error を返し useReportStore は変更しない", async () => {
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: false, reason: "not found" });

    const result = await useTemplateLibraryStore.getState().load("missing");

    expect(result).toEqual({ status: "error", reason: "not found" });
    expect(useReportStore.getState().template.fields).toEqual([OLD_FIELD]);
  });

  it("破損 JSON（parse失敗）は error を返し useReportStore は変更しない", async () => {
    useReportStore.setState({ template: { fields: [OLD_FIELD] } });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: "{broken" });

    const result = await useTemplateLibraryStore.getState().load("tmpl-1");

    expect(result.status).toBe("error");
    expect(useReportStore.getState().template.fields).toEqual([OLD_FIELD]);
  });
});

describe("remove", () => {
  it("成功時に refreshList する", async () => {
    vi.mocked(templateStorage.deleteTemplate).mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({ ok: true, value: [] });

    const result = await useTemplateLibraryStore.getState().remove("tmpl-1");

    expect(result).toEqual({ status: "removed" });
    expect(templateStorage.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("失敗時は error を返す", async () => {
    vi.mocked(templateStorage.deleteTemplate).mockResolvedValue({ ok: false, reason: "locked" });

    const result = await useTemplateLibraryStore.getState().remove("tmpl-1");

    expect(result).toEqual({ status: "error", reason: "locked" });
  });
});

describe("rename", () => {
  it("load→name書換→save_template（同一id）の順で改名する", async () => {
    const json = serializeTemplate(FIELDS, "旧名", "2025-01-01T00:00:00.000Z", { id: "tmpl-1" });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: json });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({ ok: true, value: [] });

    const result = await useTemplateLibraryStore
      .getState()
      .rename("tmpl-1", "新名", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "renamed", id: "tmpl-1" });
    expect(templateStorage.loadTemplate).toHaveBeenCalledWith("tmpl-1");
    const [savedId, savedJson] = vi.mocked(templateStorage.saveTemplate).mock.calls[0];
    expect(savedId).toBe("tmpl-1");
    const record = JSON.parse(savedJson as string);
    expect(record.name).toBe("新名");
    expect(record.id).toBe("tmpl-1");
    expect(record.savedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.fields).toEqual(FIELDS);
  });

  it("不正な新名は保存せずエラーを返す", async () => {
    const result = await useTemplateLibraryStore.getState().rename("tmpl-1", "", "2026-01-01T00:00:00.000Z");
    expect(result.status).toBe("error");
    expect(templateStorage.loadTemplate).not.toHaveBeenCalled();
  });

  it("loadTemplate 失敗時は save_template を呼ばずエラーを返す", async () => {
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: false, reason: "not found" });

    const result = await useTemplateLibraryStore
      .getState()
      .rename("tmpl-1", "新名", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "error", reason: "not found" });
    expect(templateStorage.saveTemplate).not.toHaveBeenCalled();
  });

  it("save_template 失敗時は status/error をストアにセットする（remove/load と同じ経路に統一・P2）", async () => {
    const json = serializeTemplate(FIELDS, "旧名", "2025-01-01T00:00:00.000Z", { id: "tmpl-1" });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: json });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: false, reason: "disk full" });

    const result = await useTemplateLibraryStore
      .getState()
      .rename("tmpl-1", "新名", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "error", reason: "disk full" });
    expect(useTemplateLibraryStore.getState().status).toBe("error");
    expect(useTemplateLibraryStore.getState().error).toBe("disk full");
  });

  it("loadTemplate 失敗時も status/error をストアにセットする（P2）", async () => {
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: false, reason: "not found" });

    await useTemplateLibraryStore.getState().rename("tmpl-1", "新名", "2026-01-01T00:00:00.000Z");

    expect(useTemplateLibraryStore.getState().status).toBe("error");
    expect(useTemplateLibraryStore.getState().error).toBe("not found");
  });

  it("同名の別テンプレートへの改名は拒否されエラーになる（P3c）", async () => {
    useTemplateLibraryStore.setState({
      summaries: [
        { id: "tmpl-1", name: "旧名", savedAt: "2025-01-01", schemaVersion: 1, readable: true },
        { id: "tmpl-2", name: "既存名", savedAt: "2025-01-01", schemaVersion: 1, readable: true },
      ],
    });

    const result = await useTemplateLibraryStore
      .getState()
      .rename("tmpl-1", "既存名", "2026-01-01T00:00:00.000Z");

    expect(result.status).toBe("error");
    expect(useTemplateLibraryStore.getState().status).toBe("error");
    expect(useTemplateLibraryStore.getState().error).toBeTruthy();
    expect(templateStorage.loadTemplate).not.toHaveBeenCalled();
    expect(templateStorage.saveTemplate).not.toHaveBeenCalled();
  });

  it("自分自身と同名への改名（実質無変更）は拒否されない（P3c: id 自身は重複対象から除外）", async () => {
    useTemplateLibraryStore.setState({
      summaries: [
        { id: "tmpl-1", name: "旧名", savedAt: "2025-01-01", schemaVersion: 1, readable: true },
      ],
    });
    const json = serializeTemplate(FIELDS, "旧名", "2025-01-01T00:00:00.000Z", { id: "tmpl-1" });
    vi.mocked(templateStorage.loadTemplate).mockResolvedValue({ ok: true, value: json });
    vi.mocked(templateStorage.saveTemplate).mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(templateStorage.listTemplates).mockResolvedValue({ ok: true, value: [] });

    const result = await useTemplateLibraryStore
      .getState()
      .rename("tmpl-1", "旧名", "2026-01-01T00:00:00.000Z");

    expect(result).toEqual({ status: "renamed", id: "tmpl-1" });
  });
});
