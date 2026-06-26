import { describe, it, expect } from "vitest";
import { effectiveRectForPage } from "../../logic/pageOffset";
import { ZERO_OFFSET } from "../../types/report";
import type { BoundingBox, PageOffset } from "../../types/report";

const rect: BoundingBox = { x: 100, y: 200, width: 80, height: 40 };

describe("effectiveRectForPage", () => {
  it("dx/dy を加算した x/y を返す", () => {
    const offset: PageOffset = { dx: 10, dy: -5 };
    const result = effectiveRectForPage(rect, offset);
    expect(result.x).toBe(110);
    expect(result.y).toBe(195);
  });

  it("width と height は変化しない", () => {
    const offset: PageOffset = { dx: 50, dy: 30 };
    const result = effectiveRectForPage(rect, offset);
    expect(result.width).toBe(rect.width);
    expect(result.height).toBe(rect.height);
  });

  it("ZERO_OFFSET では元の rect と同一の値を返す", () => {
    const result = effectiveRectForPage(rect, ZERO_OFFSET);
    expect(result).toEqual(rect);
  });

  it("負のオフセットでも正しく計算する", () => {
    const offset: PageOffset = { dx: -20, dy: -30 };
    const result = effectiveRectForPage(rect, offset);
    expect(result.x).toBe(80);
    expect(result.y).toBe(170);
  });

  it("元の BoundingBox オブジェクトを変更しない（イミュータブル）", () => {
    const original = { x: 10, y: 20, width: 50, height: 25 };
    const offset: PageOffset = { dx: 5, dy: 5 };
    effectiveRectForPage(original, offset);
    expect(original.x).toBe(10);
    expect(original.y).toBe(20);
  });

  it("小数のオフセットでも正しく計算する", () => {
    const offset: PageOffset = { dx: 0.5, dy: -1.5 };
    const result = effectiveRectForPage(rect, offset);
    expect(result.x).toBeCloseTo(100.5);
    expect(result.y).toBeCloseTo(198.5);
  });
});
