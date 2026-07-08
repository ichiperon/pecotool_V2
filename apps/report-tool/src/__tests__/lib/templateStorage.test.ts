import { describe, it, expect, vi } from "vitest";
import { createTemplateStorageAdapter } from "../../lib/templateStorage";
import type { TemplateSummary } from "../../lib/templateStorage";

describe("createTemplateStorageAdapter（invoke 注入）", () => {
  describe("saveTemplate", () => {
    it("成功時は ok:true を返し save_template を id/json で呼ぶ", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.saveTemplate("tmpl-1", '{"a":1}');
      expect(result.ok).toBe(true);
      expect(invoke).toHaveBeenCalledWith("save_template", { id: "tmpl-1", json: '{"a":1}' });
    });

    it("invoke が reject したら ok:false・reason を返す", async () => {
      const invoke = vi.fn().mockRejectedValue(new Error("disk full"));
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.saveTemplate("tmpl-1", "{}");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("disk full");
        expect(result.unavailable).toBeUndefined();
      }
    });
  });

  describe("listTemplates", () => {
    it("成功時は TemplateSummary[] を返す", async () => {
      const summaries: TemplateSummary[] = [
        { id: "a", name: "A", savedAt: "2026-01-01", schemaVersion: 1, readable: true },
        { id: "b", name: "??", savedAt: "2026-01-02", schemaVersion: 1, readable: false },
      ];
      const invoke = vi.fn().mockResolvedValue(summaries);
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.listTemplates();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(summaries);
      }
      expect(invoke).toHaveBeenCalledWith("list_templates");
    });

    it("1件破損していても listTemplates 自体は失敗しない（readable:false を許容）", async () => {
      const invoke = vi.fn().mockResolvedValue([
        { id: "broken", name: "?", savedAt: "", schemaVersion: 0, readable: false },
      ]);
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.listTemplates();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0].readable).toBe(false);
      }
    });

    it("invoke が reject したら ok:false を返す", async () => {
      const invoke = vi.fn().mockRejectedValue(new Error("io error"));
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.listTemplates();
      expect(result.ok).toBe(false);
    });
  });

  describe("loadTemplate", () => {
    it("成功時は生 JSON 文字列を返す", async () => {
      const invoke = vi.fn().mockResolvedValue('{"schemaVersion":1}');
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.loadTemplate("tmpl-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('{"schemaVersion":1}');
      }
      expect(invoke).toHaveBeenCalledWith("load_template", { id: "tmpl-1" });
    });

    it("invoke が reject したら ok:false を返す", async () => {
      const invoke = vi.fn().mockRejectedValue(new Error("not found"));
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.loadTemplate("missing");
      expect(result.ok).toBe(false);
    });
  });

  describe("deleteTemplate", () => {
    it("成功時は ok:true を返す", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.deleteTemplate("tmpl-1");
      expect(result.ok).toBe(true);
      expect(invoke).toHaveBeenCalledWith("delete_template", { id: "tmpl-1" });
    });

    it("invoke が reject したら ok:false を返す", async () => {
      const invoke = vi.fn().mockRejectedValue(new Error("locked"));
      const adapter = createTemplateStorageAdapter(invoke);
      const result = await adapter.deleteTemplate("tmpl-1");
      expect(result.ok).toBe(false);
    });
  });
});
