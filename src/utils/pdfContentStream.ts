/**
 * PDF content stream syntax-safe parser.
 *
 * PDF 1.7 仕様（7.2 Lexical Conventions）準拠の状態機械で content stream を走査し、
 * 文字列リテラル `(...)` ・16 進文字列 `<...>` ・コメント `%...EOL` ・inline image
 * `BI ... ID ... EI` の内部に現れる `BT` / `ET` バイト列を誤認識しないよう保証する。
 *
 * 誤認識の例（旧実装のバグ）:
 *   BT ... (Hello ET world) Tj ET
 *   → 文字列リテラル内の " ET " を終端と誤認 → ") Tj ET" が BT/ET 外に漏出
 *   → Acrobat で "Tj outside text object" エラーによるページブランク化
 */

// Delimiter 判定（PDF 1.7 §7.2.2 Character Set）
// whitespace(≤0x20) + '(' ')' '<' '>' '[' ']' '{' '}' '/' '%'
function isDelimiterOrEnd(byte: number | undefined): boolean {
  if (byte === undefined) return true; // ストリーム端
  if (byte <= 0x20) return true;
  return (
    byte === 0x28 /* ( */ ||
    byte === 0x29 /* ) */ ||
    byte === 0x3c /* < */ ||
    byte === 0x3e /* > */ ||
    byte === 0x5b /* [ */ ||
    byte === 0x5d /* ] */ ||
    byte === 0x7b /* { */ ||
    byte === 0x7d /* } */ ||
    byte === 0x2f /* / */ ||
    byte === 0x25 /* % */
  );
}

type State = 'NORMAL' | 'STRING' | 'HEX' | 'COMMENT';

/**
 * 状態機械で 1 byte 進める。state が NORMAL 以外の場合はそのバイトを呼び出し元が
 * 出力バッファにそのまま書き写す前提。state 遷移に必要な副作用はこの関数内で処理する。
 *
 * 戻り値: 遷移後の状態と「次に読み取るインデックスの増分」
 *
 * STRING 状態では `\` によるエスケープ・ネストした `(` `)` も扱う。
 */
interface ScanResult {
  state: State;
  advance: number; // 消費したバイト数
  stringDepth: number; // STRING 状態中の `(` ネスト深さ
}

/**
 * NORMAL 状態の入口判定: `data[i]` から開始する新しい状態（STRING / HEX / COMMENT）へ
 * 遷移する必要があるかを判定する。遷移しない場合は NORMAL のまま。
 *
 * 注意: `<<` と `>>` は辞書区切りなので HEX には入らない。
 */
function enterNonNormalState(
  data: Uint8Array,
  i: number,
): ScanResult | null {
  const b = data[i];
  if (b === 0x28 /* ( */) {
    return { state: 'STRING', advance: 1, stringDepth: 1 };
  }
  if (b === 0x3c /* < */) {
    // 辞書開始 `<<` かどうかを確認
    if (data[i + 1] === 0x3c) {
      return null; // 辞書なので NORMAL 継続
    }
    return { state: 'HEX', advance: 1, stringDepth: 0 };
  }
  if (b === 0x25 /* % */) {
    return { state: 'COMMENT', advance: 1, stringDepth: 0 };
  }
  return null;
}

/**
 * STRING 状態で 1 byte 消費し、次の状態を返す。
 * - `\` で始まる場合は続く 1 byte をエスケープとして literal 扱い（2 byte 消費）
 *   ただし `\` がストリーム末尾に来た場合は 1 byte だけ消費
 * - `(` でネスト depth++
 * - `)` で depth--、0 に達したら NORMAL 復帰
 */
function scanString(
  data: Uint8Array,
  i: number,
  depth: number,
): ScanResult {
  const b = data[i];
  if (b === 0x5c /* \ */) {
    // エスケープ: 次の 1 byte を literal として消費
    // 末尾に \ があれば、その \ だけ消費（PDF 仕様的には EOL 継続の扱いだが
    // ここでは単純化して 1 byte 消費に留める）
    const advance = i + 1 < data.length ? 2 : 1;
    return { state: 'STRING', advance, stringDepth: depth };
  }
  if (b === 0x28 /* ( */) {
    return { state: 'STRING', advance: 1, stringDepth: depth + 1 };
  }
  if (b === 0x29 /* ) */) {
    const newDepth = depth - 1;
    if (newDepth <= 0) {
      return { state: 'NORMAL', advance: 1, stringDepth: 0 };
    }
    return { state: 'STRING', advance: 1, stringDepth: newDepth };
  }
  return { state: 'STRING', advance: 1, stringDepth: depth };
}

/**
 * HEX 状態で 1 byte 消費。`>` を見つけたら NORMAL 復帰。
 */
function scanHex(data: Uint8Array, i: number): ScanResult {
  if (data[i] === 0x3e /* > */) {
    return { state: 'NORMAL', advance: 1, stringDepth: 0 };
  }
  return { state: 'HEX', advance: 1, stringDepth: 0 };
}

/**
 * COMMENT 状態で 1 byte 消費。LF(0x0a) / CR(0x0d) で NORMAL 復帰。
 */
function scanComment(data: Uint8Array, i: number): ScanResult {
  const b = data[i];
  if (b === 0x0a || b === 0x0d) {
    return { state: 'NORMAL', advance: 1, stringDepth: 0 };
  }
  return { state: 'COMMENT', advance: 1, stringDepth: 0 };
}

/**
 * `data[i]` 位置にトークン `BT` または `ET` が存在し、delimiter 境界を満たすか判定。
 */
function matchesToken(data: Uint8Array, i: number, t0: number, t1: number): boolean {
  if (data[i] !== t0 || data[i + 1] !== t1) return false;
  const prev = i === 0 ? undefined : data[i - 1];
  const next = i + 2 >= data.length ? undefined : data[i + 2];
  return isDelimiterOrEnd(prev) && isDelimiterOrEnd(next);
}

function copyInlineImage(data: Uint8Array, start: number, result: Uint8Array, resultIdx: number): {
  inputIdx: number;
  resultIdx: number;
} {
  let i = start;
  let inImageData = false;
  while (i < data.length) {
    result[resultIdx++] = data[i];
    if (!inImageData && matchesToken(data, i, 0x49, 0x44 /* ID */)) {
      if (i + 1 < data.length) result[resultIdx++] = data[i + 1];
      i += 2;
      inImageData = true;
      continue;
    }
    if (inImageData && matchesToken(data, i, 0x45, 0x49 /* EI */)) {
      if (i + 1 < data.length) result[resultIdx++] = data[i + 1];
      i += 2;
      break;
    }
    i += 1;
  }
  return { inputIdx: i, resultIdx };
}

function trimTrailingWhitespace(data: Uint8Array, end: number): number {
  while (end > 0 && data[end - 1] <= 0x20) end -= 1;
  return end;
}

function isEscaped(data: Uint8Array, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && data[i] === 0x5c /* \ */; i--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findLiteralStringStart(data: Uint8Array, end: number): number | null {
  if (end <= 0 || data[end - 1] !== 0x29 /* ) */) return null;
  let depth = 1;
  for (let i = end - 2; i >= 0; i--) {
    if (isEscaped(data, i)) continue;
    if (data[i] === 0x29 /* ) */) depth += 1;
    if (data[i] === 0x28 /* ( */) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function findHexStringStart(data: Uint8Array, end: number): number | null {
  if (end <= 0 || data[end - 1] !== 0x3e /* > */) return null;
  if (end > 1 && data[end - 2] === 0x3e /* > */) return null;
  for (let i = end - 2; i >= 0; i--) {
    if (data[i] !== 0x3c /* < */) continue;
    if (data[i + 1] === 0x3c /* < */) return null;
    return i;
  }
  return null;
}

function findArrayStart(data: Uint8Array, end: number): number | null {
  if (end <= 0 || data[end - 1] !== 0x5d /* ] */) return null;
  const stack: number[] = [];
  let state: State = 'NORMAL';
  let stringDepth = 0;
  let i = 0;

  while (i < end) {
    if (state === 'NORMAL') {
      if (data[i] === 0x5b /* [ */) {
        stack.push(i);
        i += 1;
        continue;
      }
      if (data[i] === 0x5d /* ] */) {
        const start = stack.pop();
        if (i === end - 1 && stack.length === 0) return start ?? null;
        i += 1;
        continue;
      }
      const entry = enterNonNormalState(data, i);
      if (entry) {
        state = entry.state;
        stringDepth = entry.stringDepth;
        i += entry.advance;
        continue;
      }
      i += 1;
    } else if (state === 'STRING') {
      const r = scanString(data, i, stringDepth);
      state = r.state;
      stringDepth = r.stringDepth;
      i += r.advance;
    } else if (state === 'HEX') {
      const r = scanHex(data, i);
      state = r.state;
      stringDepth = 0;
      i += r.advance;
    } else {
      const r = scanComment(data, i);
      state = r.state;
      stringDepth = 0;
      i += r.advance;
    }
  }

  return null;
}

function dropTrailingTjOperand(data: Uint8Array, resultIdx: number): number {
  const end = trimTrailingWhitespace(data, resultIdx);
  const literalStart = findLiteralStringStart(data, end);
  if (literalStart !== null) return literalStart;
  const hexStart = findHexStringStart(data, end);
  if (hexStart !== null) return hexStart;
  if (end > 0 && data[end - 1] === 0x29 /* ) */) return end - 1;
  return resultIdx;
}

function dropTrailingTJOperand(data: Uint8Array, resultIdx: number): number {
  const end = trimTrailingWhitespace(data, resultIdx);
  const arrayStart = findArrayStart(data, end);
  return arrayStart ?? resultIdx;
}

/**
 * content stream から BT...ET ブロックを安全に削除する。
 *
 * NORMAL 状態で BT トークンを見つけたら、BT 直前までは出力、BT からは「BT 内モード」で
 * 再度状態機械を回しながら ET を探し、ET までまとめて破棄する。文字列リテラル内等に
 * 紛れた "BT"/"ET" バイト列は誤認識しない。
 */
export function stripTextBlocks(decoded: Uint8Array): Uint8Array {
  const len = decoded.length;
  const result = new Uint8Array(len);
  let resultIdx = 0;

  let state: State = 'NORMAL';
  let stringDepth = 0;
  let i = 0;

  while (i < len) {
    if (state === 'NORMAL') {
      // NORMAL 状態で BT を検出したら、対応する ET まで読み飛ばす
      if (matchesToken(decoded, i, 0x42, 0x54 /* BT */)) {
        // BT 内モード: ET（delimiter 境界付き・NORMAL 状態）を探しながら状態機械を維持
        i += 2;
        let innerState: State = 'NORMAL';
        let innerDepth = 0;
        while (i < len) {
          if (innerState === 'NORMAL') {
            if (matchesToken(decoded, i, 0x45, 0x54 /* ET */)) {
              i += 2;
              break;
            }
            const entry = enterNonNormalState(decoded, i);
            if (entry) {
              innerState = entry.state;
              innerDepth = entry.stringDepth;
              i += entry.advance;
              continue;
            }
            i += 1;
          } else if (innerState === 'STRING') {
            const r = scanString(decoded, i, innerDepth);
            innerState = r.state;
            innerDepth = r.stringDepth;
            i += r.advance;
          } else if (innerState === 'HEX') {
            const r = scanHex(decoded, i);
            innerState = r.state;
            innerDepth = 0;
            i += r.advance;
          } else {
            // COMMENT
            const r = scanComment(decoded, i);
            innerState = r.state;
            innerDepth = 0;
            i += r.advance;
          }
        }
        continue;
      }

      if (matchesToken(decoded, i, 0x42, 0x49 /* BI */)) {
        const copied = copyInlineImage(decoded, i, result, resultIdx);
        i = copied.inputIdx;
        resultIdx = copied.resultIdx;
        continue;
      }

      if (matchesToken(decoded, i, 0x45, 0x54 /* ET */)) {
        i += 2;
        continue;
      }

      if (matchesToken(decoded, i, 0x54, 0x6a /* Tj */)) {
        resultIdx = dropTrailingTjOperand(result, resultIdx);
        i += 2;
        continue;
      }

      if (matchesToken(decoded, i, 0x54, 0x4a /* TJ */)) {
        resultIdx = dropTrailingTJOperand(result, resultIdx);
        i += 2;
        continue;
      }

      // NORMAL 継続 or 非 NORMAL 状態への遷移
      const entry = enterNonNormalState(decoded, i);
      if (entry) {
        // 開始バイト（`(` `<` `%`）はそのまま出力して状態遷移
        result[resultIdx++] = decoded[i];
        state = entry.state;
        stringDepth = entry.stringDepth;
        i += entry.advance;
        continue;
      }
      result[resultIdx++] = decoded[i];
      i += 1;
    } else if (state === 'STRING') {
      // STRING 内はバイトをそのまま複写しつつ状態遷移を追う
      const r = scanString(decoded, i, stringDepth);
      // エスケープ `\` の場合は 2 byte 消費するので両方複写する
      for (let k = 0; k < r.advance && i + k < len; k++) {
        result[resultIdx++] = decoded[i + k];
      }
      state = r.state;
      stringDepth = r.stringDepth;
      i += r.advance;
    } else if (state === 'HEX') {
      const r = scanHex(decoded, i);
      result[resultIdx++] = decoded[i];
      state = r.state;
      stringDepth = 0;
      i += r.advance;
    } else {
      // COMMENT
      const r = scanComment(decoded, i);
      result[resultIdx++] = decoded[i];
      state = r.state;
      stringDepth = 0;
      i += r.advance;
    }
  }

  return result.slice(0, resultIdx);
}
