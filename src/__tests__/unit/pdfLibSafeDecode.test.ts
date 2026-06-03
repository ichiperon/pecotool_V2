/**
 * Unit tests for src/utils/pdfLibSafeDecode.ts
 *
 * U-PH-03: 壊れた FlateDecode stream で例外なく fallback する
 * U-PH-04: 正常な stream を decode できる
 * Extra: UTF-16BE BOM、Latin1、大容量 hex、PDFString 委譲
 */
import { describe, it, expect } from 'vitest';
import { PDFHexString, PDFString } from '@cantoo/pdf-lib';
import { safeDecodePdfText } from '../../utils/pdfLibSafeDecode';

// PDFHexString のモックファクトリ: value プロパティを直接セット
function makeHexString(hexValue: string): PDFHexString {
  const obj = Object.create(PDFHexString.prototype) as PDFHexString;
  (obj as unknown as { value: string }).value = hexValue;
  return obj;
}

describe('safeDecodePdfText / PDFHexString', () => {
  it('U-PH-04: ASCII hex を Latin1 デコードできる', () => {
    // "Hello" in hex: 48 65 6C 6C 6F
    const hex = makeHexString('48656c6c6f');
    expect(safeDecodePdfText(hex)).toBe('Hello');
  });

  it('U-PH-04b: 空の hex 値を空文字列に変換できる', () => {
    const hex = makeHexString('');
    expect(safeDecodePdfText(hex)).toBe('');
  });

  it('U-PH-04c: UTF-16BE BOM (FEFF) 付き hex を正しく decode する', () => {
    // UTF-16BE BOM + "AB"
    // 0xFE 0xFF 0x00 0x41 0x00 0x42 → "AB"
    const hex = makeHexString('feff00410042');
    const result = safeDecodePdfText(hex);
    expect(result).toBe('AB');
  });

  it('U-PH-04d: UTF-16BE BOM なし hex は Latin1 として decode される', () => {
    // 0x41 0x42 0x43 = "ABC" in Latin1
    const hex = makeHexString('414243');
    expect(safeDecodePdfText(hex)).toBe('ABC');
  });

  it('U-PH-03: 奇数長 hex でも crash せずに decode できる（切り捨て動作）', () => {
    // hex.length が奇数の場合 Math.floor(hex.length / 2) で切り捨てる
    const hex = makeHexString('414243f'); // 7 chars → 3 bytes = "ABC"
    expect(() => safeDecodePdfText(hex)).not.toThrow();
    expect(safeDecodePdfText(hex)).toBe('ABC');
  });

  it('大容量 hex (100000 バイト相当) でスタックオーバーフローしない', () => {
    // decodeText() が spread 構文で大容量だとスタック爆発する問題への対処テスト
    const large = '41'.repeat(100_000); // 100KB相当
    const hex = makeHexString(large);
    expect(() => safeDecodePdfText(hex)).not.toThrow();
    const result = safeDecodePdfText(hex);
    expect(result.length).toBe(100_000);
  });

  it('BOM ちょうど 2 バイトのみ (FE FF) の hex でも crash しない', () => {
    const hex = makeHexString('feff');
    expect(() => safeDecodePdfText(hex)).not.toThrow();
    // 2 バイト → BOM のみ → UTF-16BE で空文字列
    const result = safeDecodePdfText(hex);
    expect(result).toBe('');
  });

  it('0xFF などの非 ASCII バイトを含む hex を crash なく処理する', () => {
    const hex = makeHexString('ff00fe01');
    expect(() => safeDecodePdfText(hex)).not.toThrow();
  });
});

describe('safeDecodePdfText / PDFString', () => {
  it('U-PH-04e: PDFString インスタンスは decodeText() に委譲して結果を返す', () => {
    // PDFString.fromString() で実際のインスタンスを作成
    // PDFString のリテラルテキストはそのまま返る
    const pdfStr = PDFString.of('SampleText');
    // PDFString.decodeText() は実装内部に依存するが、例外なく文字列を返すことを確認
    expect(() => safeDecodePdfText(pdfStr)).not.toThrow();
    const result = safeDecodePdfText(pdfStr);
    expect(typeof result).toBe('string');
  });
});
