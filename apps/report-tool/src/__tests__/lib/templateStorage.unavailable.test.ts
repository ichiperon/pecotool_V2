import { describe, it, expect, vi } from "vitest";

// "@tauri-apps/api/core" の動的 import 自体を失敗させ、
// 非Tauri環境（ブラウザ/テスト）で templateStorage が unavailable に degrade することを検証する。
vi.mock("@tauri-apps/api/core", () => {
  throw new Error("Tauri runtime not available");
});

describe("templateStorage（既定アダプタ・Tauri invoke 解決不可）", () => {
  it("saveTemplate は例外を投げず unavailable:true を返す", async () => {
    const { templateStorage } = await import("../../lib/templateStorage");
    const result = await templateStorage.saveTemplate("tmpl-1", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable).toBe(true);
    }
  });

  it("listTemplates は例外を投げず unavailable:true を返す", async () => {
    const { templateStorage } = await import("../../lib/templateStorage");
    const result = await templateStorage.listTemplates();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable).toBe(true);
    }
  });

  it("loadTemplate は例外を投げず unavailable:true を返す", async () => {
    const { templateStorage } = await import("../../lib/templateStorage");
    const result = await templateStorage.loadTemplate("tmpl-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable).toBe(true);
    }
  });

  it("deleteTemplate は例外を投げず unavailable:true を返す", async () => {
    const { templateStorage } = await import("../../lib/templateStorage");
    const result = await templateStorage.deleteTemplate("tmpl-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable).toBe(true);
    }
  });
});
