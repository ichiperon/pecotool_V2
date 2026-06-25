import { describe, it, expect } from "vitest";
import { encodeCsvUtf8Bom } from "../../logic/csvEncode";

const BOM = [0xef, 0xbb, 0xbf];

describe("encodeCsvUtf8Bom", () => {
  it("先頭 3 バイトが BOM（0xEF 0xBB 0xBF）である", () => {
    const result = encodeCsvUtf8Bom("hello");
    expect(result[0]).toBe(0xef);
    expect(result[1]).toBe(0xbb);
    expect(result[2]).toBe(0xbf);
  });

  it("BOM を除いた本文が UTF-8 の期待値と一致する", () => {
    const csv = "hello";
    const result = encodeCsvUtf8Bom(csv);
    const bodyBytes = result.slice(3);
    const encoder = new TextEncoder();
    const expected = encoder.encode(csv);
    expect(bodyBytes).toEqual(expected);
  });

  it("日本語が正しく UTF-8 にエンコードされる", () => {
    const csv = "金額,摘要\r\n1000,テスト";
    const result = encodeCsvUtf8Bom(csv);
    const bodyBytes = result.slice(3);
    const decoder = new TextDecoder("utf-8");
    expect(decoder.decode(bodyBytes)).toBe(csv);
  });

  it("空文字でも BOM だけ付与される（本文 0 バイト）", () => {
    const result = encodeCsvUtf8Bom("");
    expect(result.length).toBe(3);
    expect([...result.slice(0, 3)]).toEqual(BOM);
  });

  it("全体バイト長 = BOM(3) + UTF-8 本文バイト長", () => {
    const csv = "abc";
    const result = encodeCsvUtf8Bom(csv);
    const encoder = new TextEncoder();
    const bodyLen = encoder.encode(csv).length;
    expect(result.length).toBe(3 + bodyLen);
  });

  it("マルチバイト文字でのバイト長が正しい", () => {
    const csv = "あ"; // UTF-8 で 3 バイト
    const result = encodeCsvUtf8Bom(csv);
    expect(result.length).toBe(3 + 3); // BOM(3) + 'あ'(3)
  });
});
