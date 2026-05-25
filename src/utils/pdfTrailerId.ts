/**
 * PDF trailer /ID 保持ユーティリティ
 *
 * 背景: pdf-lib の save() は出力 trailer の /ID を毎回再生成する。
 * Acrobat はファイルを開いた時の /ID と現在の /ID を突き合わせて
 * 「別文書 / 変更あり」と判定して dirty 化することがあるため、
 * 入力 PDF の /ID を保存後 PDF に書き戻すことで「未変更で開いて閉じる」
 * シナリオの保存確認ダイアログを抑止する。
 *
 * 実装は binary surgery (正規表現 + Uint8Array substring) のみで完結し、
 * pdf-lib API には依存しない。
 */

const TAIL_SCAN_BYTES = 8192;

// /ID [ <hex0> <hex1> ] — hex string 両端で空白許容
// PDF spec 的には literal string `(...)` も合法だが、@cantoo/pdf-lib が出力する
// /ID は常に hex string なので主実装は hex のみ。literal は今回 scope 外。
const TRAILER_ID_HEX_REGEX_GLOBAL =
  /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/g;

export interface TrailerId {
  id0Hex: string;
  id1Hex: string;
}

function asciiFromBytes(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  const chunkSize = 8192;
  for (let i = start; i < end; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, end);
    for (let j = i; j < chunkEnd; j++) {
      out += String.fromCharCode(bytes[j]);
    }
  }
  return out;
}

/**
 * 入力 PDF の trailer から /ID 配列を抽出する。
 * incremental update で複数 trailer がある場合は最後のものが有効。
 *
 * tail 8KB のみスキャンする (trailer は通常ファイル末尾近くにあり、
 * 巨大 PDF でも tail だけで十分)。tail に見つからなければ null。
 */
export function extractTrailerId(pdfBytes: Uint8Array): TrailerId | null {
  if (pdfBytes.length === 0) return null;
  const tailStart = Math.max(0, pdfBytes.length - TAIL_SCAN_BYTES);
  const tail = asciiFromBytes(pdfBytes, tailStart, pdfBytes.length);

  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  TRAILER_ID_HEX_REGEX_GLOBAL.lastIndex = 0;
  while ((m = TRAILER_ID_HEX_REGEX_GLOBAL.exec(tail)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;
  return { id0Hex: lastMatch[1], id1Hex: lastMatch[2] };
}

/**
 * 保存後 PDF の trailer 内 /ID を入力由来 /ID で上書きする。
 *
 * - /ID が見つからなければ savedBytes をそのまま返す。
 * - 出力 hex 長 == 入力 hex 長 のとき in-place 置換 (byte length 不変、xref offset 安全)。
 * - 長さが違う場合は警告ログを出し、上書きを諦めて savedBytes をそのまま返す
 *   (xref/startxref offset 再計算は scope 外。実用上 pdf-lib は 16-byte MD5 = 32 hex で
 *   出すケースが多く、入力も 16-byte なら一致する)。
 */
export function overwriteTrailerId(
  savedBytes: Uint8Array,
  trailerId: TrailerId,
): Uint8Array {
  if (savedBytes.length === 0) return savedBytes;
  const tailStart = Math.max(0, savedBytes.length - TAIL_SCAN_BYTES);
  const tail = asciiFromBytes(savedBytes, tailStart, savedBytes.length);

  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  TRAILER_ID_HEX_REGEX_GLOBAL.lastIndex = 0;
  while ((m = TRAILER_ID_HEX_REGEX_GLOBAL.exec(tail)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return savedBytes;

  const outId0Hex = lastMatch[1];
  const outId1Hex = lastMatch[2];

  if (
    outId0Hex.length !== trailerId.id0Hex.length ||
    outId1Hex.length !== trailerId.id1Hex.length
  ) {
    // 長さが異なるケースは xref offset の再計算が必要になるため見送る。
    // 確実な dirty 回避を優先し、ID 不一致による Acrobat dirty 化のリスクは受容する。
    console.warn(
      '[overwriteTrailerId] /ID hex length mismatch — skipping (input=',
      trailerId.id0Hex.length, '/', trailerId.id1Hex.length,
      'output=', outId0Hex.length, '/', outId1Hex.length,
      ')',
    );
    return savedBytes;
  }

  // tail 内オフセットを絶対オフセットに変換して in-place 上書き。
  // match.index は tail 文字列内位置。tail は ASCII 1:1 マッピングなので
  // byte offset = tailStart + match.index。
  // 置換対象は capture group 内の hex 文字列だけ (区切り `< >` 等は触らない)。
  const matchAbsStart = tailStart + lastMatch.index;
  const matchText = lastMatch[0];

  const id0StartInMatch = matchText.indexOf('<') + 1;
  const id0EndInMatch = id0StartInMatch + outId0Hex.length;
  // 2 つ目の `<` は id0 の `>` 以降
  const id1StartInMatch =
    matchText.indexOf('<', id0EndInMatch) + 1;

  const out = new Uint8Array(savedBytes);
  for (let i = 0; i < trailerId.id0Hex.length; i++) {
    out[matchAbsStart + id0StartInMatch + i] = trailerId.id0Hex.charCodeAt(i) & 0xff;
  }
  for (let i = 0; i < trailerId.id1Hex.length; i++) {
    out[matchAbsStart + id1StartInMatch + i] = trailerId.id1Hex.charCodeAt(i) & 0xff;
  }
  return out;
}
