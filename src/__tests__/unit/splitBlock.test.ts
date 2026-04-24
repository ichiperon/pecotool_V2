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
});
