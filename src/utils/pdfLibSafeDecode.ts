import { PDFHexString, PDFString } from '@cantoo/pdf-lib';

/**
 * PDFHexString / PDFString の decodeText() は内部で `String.fromCharCode(...bytes)`
 * を spread 構文で呼ぶ実装になっており、数 MB の文字列で
 * "Maximum call stack size exceeded" を発生させる。
 *
 * PecoToolBBoxes メタデータは OCR ブロック数がページ当たり数十〜数百件、
 * 全 PDF で数万件になると JSON 化で数 MB の hex 文字列になるため、
 * decodeText() が silent にスタックオーバーフローする (呼び元の try/catch に
 * 握り潰され、既存メタが "無し" として扱われる)。
 *
 * 本ユーティリティは hex バイト列を直接 TextDecoder で decode することで
 * 非再帰・非 spread で大容量文字列に耐える。
 */
export function safeDecodePdfText(v: PDFHexString | PDFString): string {
  if (v instanceof PDFHexString) {
    // pdf-lib の PDFHexString は hex 表現の string を value プロパティに保持する
    const hex: string = (v as unknown as { value: string }).value;
    const byteLen = Math.floor(hex.length / 2);
    const bytes = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    // BOM (0xFE 0xFF) が付いていれば UTF-16BE、無ければ Latin1 として扱う
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    return new TextDecoder('latin1').decode(bytes);
  }
  // PDFString (リテラル文字列) は decodeText の実装が軽く、問題は確認されていない
  return v.decodeText();
}
