import { describe, it, expect, vi } from "vitest";
import { createSessionFileStorage } from "../../lib/sessionFileStorage";

describe("sessionFileStorage（invoke 注入）", () => {
  it("save は save_session コマンドへ json を渡す", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const s = createSessionFileStorage(invoke as never);
    const r = await s.save('{"version":1}');
    expect(r.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_session", { json: '{"version":1}' });
  });

  it("load 成功は json を返し、失敗（ファイル不在含む）は missing 扱い", async () => {
    const invoke = vi.fn().mockResolvedValueOnce('{"a":1}').mockRejectedValueOnce(new Error("なし"));
    const s = createSessionFileStorage(invoke as never);
    expect(await s.load()).toEqual({ ok: true, json: '{"a":1}' });
    expect(await s.load()).toEqual({ ok: false, missing: true });
  });

  it("save の失敗は reason 付き ok:false（throw しない）", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("disk full"));
    const s = createSessionFileStorage(invoke as never);
    const r = await s.save("{}");
    expect(r).toEqual({ ok: false, reason: "disk full" });
  });

  it("clear は成功で ok:true", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const s = createSessionFileStorage(invoke as never);
    expect((await s.clear()).ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("clear_session");
  });
});
