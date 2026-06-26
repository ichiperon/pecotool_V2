import { describe, it, expect } from "vitest";
import { parseOcrResponse, OcrAdapterError } from "../../lib/ocrAdapter";

describe("parseOcrResponse", () => {
  describe("正常系", () => {
    it("status=ok・blocks あり → ReportBlock[] を返す", () => {
      const json = JSON.stringify({
        status: "ok",
        blocks: [
          { text: "テスト", bbox: { x: 10, y: 20, width: 80, height: 15 }, confidence: 0.95 },
          { text: "サンプル", bbox: { x: 5, y: 40, width: 60, height: 12 } },
        ],
      });
      const result = parseOcrResponse(json);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("テスト");
      expect(result[0].bbox).toEqual({ x: 10, y: 20, width: 80, height: 15 });
      expect(result[0].fieldId).toBeNull();
      expect(result[0].confidence).toBe(0.95);
    });

    it("status=ok・blocks 空 → 空配列を返す", () => {
      const json = JSON.stringify({ status: "ok", blocks: [] });
      const result = parseOcrResponse(json);
      expect(result).toHaveLength(0);
    });

    it("status=ok・blocks 未定義 → 空配列を返す", () => {
      const json = JSON.stringify({ status: "ok" });
      const result = parseOcrResponse(json);
      expect(result).toHaveLength(0);
    });

    it("confidence が undefined のブロックも正常に変換できる", () => {
      const json = JSON.stringify({
        status: "ok",
        blocks: [{ text: "A", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      });
      const result = parseOcrResponse(json);
      expect(result[0].confidence).toBeUndefined();
    });

    it("fieldId は常に null になる", () => {
      const json = JSON.stringify({
        status: "ok",
        blocks: [
          { text: "X", bbox: { x: 0, y: 0, width: 5, height: 5 } },
          { text: "Y", bbox: { x: 10, y: 10, width: 5, height: 5 } },
        ],
      });
      const result = parseOcrResponse(json);
      for (const block of result) {
        expect(block.fieldId).toBeNull();
      }
    });

    it("複数ブロックの bbox が正確にマッピングされる", () => {
      const json = JSON.stringify({
        status: "ok",
        blocks: [
          { text: "First", bbox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.8 },
          { text: "Second", bbox: { x: 5, y: 6, width: 7, height: 8 }, confidence: 0.9 },
        ],
      });
      const result = parseOcrResponse(json);
      expect(result[0].bbox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
      expect(result[1].bbox).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    });
  });

  describe("エラー系", () => {
    it("不正な JSON → OcrAdapterError を throw", () => {
      expect(() => parseOcrResponse("not-json")).toThrow(OcrAdapterError);
      expect(() => parseOcrResponse("not-json")).toThrow("JSON パースに失敗");
    });

    it("空文字 → OcrAdapterError を throw", () => {
      expect(() => parseOcrResponse("")).toThrow(OcrAdapterError);
    });

    it("status=error → OcrAdapterError を throw", () => {
      const json = JSON.stringify({ status: "error", message: "OCR 失敗" });
      expect(() => parseOcrResponse(json)).toThrow(OcrAdapterError);
      expect(() => parseOcrResponse(json)).toThrow("OCR 失敗");
    });

    it("status=error で message なし → OcrAdapterError を throw（status 文字列を含む）", () => {
      const json = JSON.stringify({ status: "error" });
      expect(() => parseOcrResponse(json)).toThrow(OcrAdapterError);
      expect(() => parseOcrResponse(json)).toThrow('status="error"');
    });

    it("status=unknown → OcrAdapterError を throw", () => {
      const json = JSON.stringify({ status: "unknown" });
      expect(() => parseOcrResponse(json)).toThrow(OcrAdapterError);
    });

    it("OcrAdapterError は raw フィールドに元の文字列を持つ", () => {
      const raw = "not-json";
      let caughtError: OcrAdapterError | null = null;
      try {
        parseOcrResponse(raw);
      } catch (e) {
        caughtError = e as OcrAdapterError;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError?.raw).toBe(raw);
    });
  });
});
