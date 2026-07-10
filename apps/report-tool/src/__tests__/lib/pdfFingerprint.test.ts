import { describe, it, expect } from "vitest";
import { computePdfFingerprint } from "../../lib/pdfFingerprint";

describe("computePdfFingerprint", () => {
  it("同じバイト列からは同じフィンガープリントが得られる", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await computePdfFingerprint(bytes);
    const b = await computePdfFingerprint(bytes.slice());
    expect(a).toBe(b);
  });

  it("異なるバイト列からは異なるフィンガープリントが得られる", async () => {
    const a = await computePdfFingerprint(new Uint8Array([1, 2, 3]));
    const b = await computePdfFingerprint(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });

  it("SHA-256 の16進文字列（64文字・小文字16進）を返す", async () => {
    const hash = await computePdfFingerprint(new Uint8Array([0, 1, 2]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("空バイト列でも計算できる（既知のSHA-256空文字列ハッシュと一致）", async () => {
    const hash = await computePdfFingerprint(new Uint8Array([]));
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
