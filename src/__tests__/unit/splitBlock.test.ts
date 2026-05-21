import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextBlock } from "../../types";
import { splitBlockAtRatio } from "../../utils/splitBlock";

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: "block-1",
    text: "abcdef",
    originalText: "abcdef",
    bbox: { x: 10, y: 20, width: 100, height: 40 },
    writingMode: "horizontal",
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("splitBlockAtRatio", () => {
  beforeEach(() => {
    let seq = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `uuid-${++seq}`),
    });
  });

  it("does not split inside a surrogate pair", () => {
    const result = splitBlockAtRatio(makeBlock({ text: "A😀B" }), 0.5);

    expect(result).not.toBeNull();
    expect(result!.b1.text + result!.b2.text).toBe("A😀B");
    expect(hasLoneSurrogate(result!.b1.text)).toBe(false);
    expect(hasLoneSurrogate(result!.b2.text)).toBe(false);
  });

  it("does not split inside a combining character sequence", () => {
    const text = "Aか\u3099B";
    const result = splitBlockAtRatio(makeBlock({ text }), 0.5);

    expect(result).not.toBeNull();
    expect(result!.b1.text + result!.b2.text).toBe(text);
    expect(result!.b1.text.endsWith("か")).toBe(false);
    expect(result!.b2.text.startsWith("\u3099")).toBe(false);
  });

  it("returns null for tiny horizontal bbox", () => {
    const result = splitBlockAtRatio(makeBlock({
      bbox: { x: 0, y: 0, width: 1.5, height: 20 },
    }), 0.5);

    expect(result).toBeNull();
  });

  it("returns null for tiny vertical bbox", () => {
    const result = splitBlockAtRatio(makeBlock({
      writingMode: "vertical",
      bbox: { x: 0, y: 0, width: 20, height: 1.5 },
    }), 0.5);

    expect(result).toBeNull();
  });

  it("returns null for a single-grapheme block", () => {
    // graphemes.length < 2 → 分割不能
    expect(splitBlockAtRatio(makeBlock({ text: "A" }), 0.5)).toBeNull();
  });

  // ── ratio による分割位置 (horizontal) ───────────────────────
  it("ratio=0 でも b1 は最低 1 文字を持つ (空ブロックを作らない)", () => {
    const result = splitBlockAtRatio(makeBlock({ text: "abcdef" }), 0);
    expect(result).not.toBeNull();
    expect(result!.b1.text.length).toBeGreaterThanOrEqual(1);
    expect(result!.b2.text.length).toBeGreaterThanOrEqual(1);
    expect(result!.b1.text + result!.b2.text).toBe("abcdef");
  });

  it("ratio=1 でも b2 は最低 1 文字を持つ (空ブロックを作らない)", () => {
    const result = splitBlockAtRatio(makeBlock({ text: "abcdef" }), 1);
    expect(result).not.toBeNull();
    expect(result!.b1.text.length).toBeGreaterThanOrEqual(1);
    expect(result!.b2.text.length).toBeGreaterThanOrEqual(1);
    expect(result!.b1.text + result!.b2.text).toBe("abcdef");
  });

  it("ratio>1 は 1 に、ratio<0 は 0 にクランプされる (例外を投げない)", () => {
    const over = splitBlockAtRatio(makeBlock({ text: "abcdef" }), 5);
    const under = splitBlockAtRatio(makeBlock({ text: "abcdef" }), -3);
    expect(over).not.toBeNull();
    expect(under).not.toBeNull();
    expect(over!.b1.text + over!.b2.text).toBe("abcdef");
    expect(under!.b1.text + under!.b2.text).toBe("abcdef");
  });

  it("ratio=0.5 の等幅 ASCII テキストは中央付近で分割される", () => {
    // 6 文字均等 weight → targetW=3。currentW>=3 になる j=2 (0-indexed) で
    // currentW-targetW=0 < weight/2=0.5 → return j+1=3。"abc"/"def"。
    const result = splitBlockAtRatio(makeBlock({ text: "abcdef" }), 0.5);
    expect(result).not.toBeNull();
    expect(result!.b1.text).toBe("abc");
    expect(result!.b2.text).toBe("def");
  });

  it("全角文字 (weight=2) は半角 (weight=1) より重く扱われ、分割位置が幅基準になる", () => {
    // "あいうA" → weights [2,2,2,1], totalW=7。ratio=0.5 → targetW=3.5。
    // j=0: currentW=2 (<3.5), j=1: currentW=4 (>=3.5)。
    // currentW-targetW=0.5, weight/2=1 → 0.5<1 → return j+1=2。"あい"/"うA"。
    const result = splitBlockAtRatio(makeBlock({ text: "あいうA" }), 0.5);
    expect(result).not.toBeNull();
    expect(result!.b1.text).toBe("あい");
    expect(result!.b2.text).toBe("うA");
  });

  // ── bbox 配分 (horizontal / vertical) ───────────────────────
  it("horizontal: b1/b2 の幅合計は元の幅と一致し、b2.x は b1 の右端から始まる", () => {
    const block = makeBlock({ text: "abcdef", bbox: { x: 10, y: 20, width: 100, height: 40 } });
    const result = splitBlockAtRatio(block, 0.5)!;
    expect(result.b1.bbox.width + result.b2.bbox.width).toBeCloseTo(100, 5);
    expect(result.b2.bbox.x).toBeCloseTo(result.b1.bbox.x + result.b1.bbox.width, 5);
    // y / height は両方とも元のまま
    expect(result.b1.bbox.y).toBe(20);
    expect(result.b2.bbox.height).toBe(40);
  });

  it("vertical: b1/b2 の高さ合計は元の高さと一致し、b2.y は b1 の下端から始まる", () => {
    const block = makeBlock({
      text: "あいうえお",
      writingMode: "vertical",
      bbox: { x: 10, y: 20, width: 40, height: 100 },
    });
    const result = splitBlockAtRatio(block, 0.5)!;
    expect(result.b1.bbox.height + result.b2.bbox.height).toBeCloseTo(100, 5);
    expect(result.b2.bbox.y).toBeCloseTo(result.b1.bbox.y + result.b1.bbox.height, 5);
    expect(result.b1.bbox.x).toBe(10);
    expect(result.b2.bbox.width).toBe(40);
  });

  it("分割幅は最低 1px を確保する (ratio=0 でも b1.width >= 1)", () => {
    // ratio=0 → dx=0 → safeDx=Math.max(1, min(width-1, 0))=1
    const block = makeBlock({ text: "abcdef", bbox: { x: 0, y: 0, width: 100, height: 40 } });
    const result = splitBlockAtRatio(block, 0)!;
    expect(result.b1.bbox.width).toBeGreaterThanOrEqual(1);
    expect(result.b2.bbox.width).toBeGreaterThanOrEqual(1);
  });

  it("分割後の 2 ブロックは新しい一意な id を持ち、isDirty=true・text と originalText が一致する", () => {
    const block = makeBlock({ text: "abcdef" });
    const result = splitBlockAtRatio(block, 0.5)!;
    expect(result.b1.id).not.toBe(result.b2.id);
    expect(result.b1.id).not.toBe(block.id);
    expect(result.b2.id).not.toBe(block.id);
    expect(result.b1.isDirty).toBe(true);
    expect(result.b2.isDirty).toBe(true);
    // split で text を確定したら originalText も同じ値に揃える
    expect(result.b1.originalText).toBe(result.b1.text);
    expect(result.b2.originalText).toBe(result.b2.text);
  });
});
