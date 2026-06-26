import { describe, it, expect } from "vitest";
import { computeFitZoom } from "../../lib/fitZoom";

describe("computeFitZoom", () => {
  // width モード
  describe("fitMode=width", () => {
    it("幅フィットを計算する（基本ケース）", () => {
      const result = computeFitZoom({
        fitMode: "width",
        containerWidth: 900,
        containerHeight: 1200,
        pageWidth: 595,
        pageHeight: 842,
        padding: 32,
      });
      // floor((900 - 32) / 595 * 100) = floor(145.88...) = 145
      expect(result).toBe(145);
    });

    it("padding デフォルト値（32）が適用される", () => {
      const result = computeFitZoom({
        fitMode: "width",
        containerWidth: 627,
        containerHeight: 1000,
        pageWidth: 595,
        pageHeight: 842,
      });
      // floor((627 - 32) / 595 * 100) = floor(100.0) = 100
      expect(result).toBe(100);
    });

    it("計算結果が 400 を超えるときは 400 にクランプされる", () => {
      const result = computeFitZoom({
        fitMode: "width",
        containerWidth: 10000,
        containerHeight: 10000,
        pageWidth: 100,
        pageHeight: 100,
        padding: 32,
      });
      expect(result).toBe(400);
    });

    it("計算結果が 25 を下回るときは 25 にクランプされる", () => {
      const result = computeFitZoom({
        fitMode: "width",
        containerWidth: 50,
        containerHeight: 1000,
        pageWidth: 595,
        pageHeight: 842,
        padding: 32,
      });
      expect(result).toBe(25);
    });
  });

  // page モード
  describe("fitMode=page", () => {
    it("幅フィットと高さフィットの min を採用する（高さが制約になるケース）", () => {
      const result = computeFitZoom({
        fitMode: "page",
        containerWidth: 1200,
        containerHeight: 600,
        pageWidth: 595,
        pageHeight: 842,
        padding: 32,
      });
      // 幅フィット: floor((1200 - 32) / 595 * 100) = floor(196.2) = 196
      // 高さフィット: floor((600 - 32) / 842 * 100) = floor(67.4...) = 67
      // min(196, 67) = 67
      expect(result).toBe(67);
    });

    it("幅フィットと高さフィットの min を採用する（幅が制約になるケース）", () => {
      const result = computeFitZoom({
        fitMode: "page",
        containerWidth: 400,
        containerHeight: 2000,
        pageWidth: 595,
        pageHeight: 842,
        padding: 32,
      });
      // 幅フィット: floor((400 - 32) / 595 * 100) = floor(61.8...) = 61
      // 高さフィット: floor((2000 - 32) / 842 * 100) = floor(233.7...) = 233
      // min(61, 233) = 61
      expect(result).toBe(61);
    });

    it("計算結果が 400 を超えるときは 400 にクランプされる", () => {
      const result = computeFitZoom({
        fitMode: "page",
        containerWidth: 50000,
        containerHeight: 50000,
        pageWidth: 100,
        pageHeight: 100,
        padding: 0,
      });
      expect(result).toBe(400);
    });

    it("計算結果が 25 を下回るときは 25 にクランプされる", () => {
      const result = computeFitZoom({
        fitMode: "page",
        containerWidth: 50,
        containerHeight: 50,
        pageWidth: 595,
        pageHeight: 842,
        padding: 32,
      });
      expect(result).toBe(25);
    });
  });

  // 不正入力ガード
  describe("不正入力: 0 を返す", () => {
    it("containerWidth が 0 のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "width",
          containerWidth: 0,
          containerHeight: 800,
          pageWidth: 595,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("containerHeight が 0 のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "page",
          containerWidth: 800,
          containerHeight: 0,
          pageWidth: 595,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("pageWidth が 0 のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "width",
          containerWidth: 800,
          containerHeight: 800,
          pageWidth: 0,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("pageHeight が 0 のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "page",
          containerWidth: 800,
          containerHeight: 800,
          pageWidth: 595,
          pageHeight: 0,
        })
      ).toBe(0);
    });

    it("containerWidth が負の値のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "width",
          containerWidth: -100,
          containerHeight: 800,
          pageWidth: 595,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("containerWidth が Infinity のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "width",
          containerWidth: Infinity,
          containerHeight: 800,
          pageWidth: 595,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("pageWidth が NaN のとき 0 を返す", () => {
      expect(
        computeFitZoom({
          fitMode: "width",
          containerWidth: 800,
          containerHeight: 800,
          pageWidth: NaN,
          pageHeight: 842,
        })
      ).toBe(0);
    });

    it("0 は 25 にクランプされない（クランプは0判定の後）", () => {
      // containerWidth=0 → 0 を返す（25にクランプしない）
      const result = computeFitZoom({
        fitMode: "width",
        containerWidth: 0,
        containerHeight: 800,
        pageWidth: 595,
        pageHeight: 842,
      });
      expect(result).toBe(0);
      expect(result).not.toBe(25);
    });
  });
});
