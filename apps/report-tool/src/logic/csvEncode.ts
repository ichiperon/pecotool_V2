/**
 * CSV 文字列を UTF-8 BOM 付きの Uint8Array にエンコードする。
 *
 * BOM (0xEF 0xBB 0xBF) を先頭に付与することで、
 * Excel での自動文字コード判定を UTF-8 として確定させる。
 *
 * @param csv  CSV 文字列（buildTemplateCsv の出力など）
 * @returns    BOM + UTF-8 エンコードされたバイト列
 *
 * TODO (将来 issue): Shift_JIS 出力への対応。
 *   TextEncoder は UTF-8 のみサポートするため Shift_JIS エンコードには
 *   encoding-japanese 等の外部ライブラリが必要。ユーザー要望・ブラウザ環境を
 *   確認してから実装する。
 */
export function encodeCsvUtf8Bom(csv: string): Uint8Array {
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
  const encoder = new TextEncoder();
  const body = encoder.encode(csv);

  const result = new Uint8Array(BOM.length + body.length);
  result.set(BOM, 0);
  result.set(body, BOM.length);

  return result;
}
