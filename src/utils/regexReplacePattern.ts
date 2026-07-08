/**
 * useRegex=true の検索置換で使う $ 置換パターン展開 (ECMA-262 の GetSubstitution 相当)。
 *
 * 背景 (bug-hunt round3): pecoStore.replaceText/replaceTextBatch と
 * useFindReplace.buildMatchPreview は、いずれも `(?<=第)3` のような lookbehind/lookahead
 * を含む正規表現で「切り出したマッチ文字列 (matchStr) 単体に同じ正規表現を再適用して
 * $1 等の後方参照を解決する」実装だった。lookbehind/lookahead はマッチ範囲外の文脈に
 * 依存するため、matchStr だけを取り出して再マッチさせると不成立になり、
 * matchStr がそのまま返って置換が反映されない (それでいてヒット件数は加算済みなので
 * 「N件置換しました」という虚偽の成功トーストが出る)。
 *
 * この関数は再マッチを行わず、既に元テキスト全体に対する走査で確定済みの
 * マッチ情報 (ReplacerMatch) から $ 置換パターンを直接展開する。
 * lookbehind/lookahead の成否は「元テキスト全体に対する走査」の時点で
 * 既に正しく評価済みなので、この展開処理はその結果 (キャプチャ済み文字列) を
 * 使うだけでよく、lookaround の再評価を必要としない。
 */
export interface ReplacerMatch {
  /** マッチした文字列全体 ($&) */
  matched: string;
  /** マッチ開始位置 (0-based, 元テキスト基準) */
  index: number;
  /** マッチ対象の元テキスト全体 ($` / $' の算出に使う) */
  input: string;
  /** 番号付きキャプチャグループ (1-indexed。未マッチのグループは undefined) */
  captures: Array<string | undefined>;
  /** 名前付きキャプチャグループ (存在する場合のみ) */
  groups?: Record<string, string | undefined>;
}

/**
 * String.prototype.replace の関数版 replacer に渡される引数配列
 * (match, p1, ..., pN, offset, string[, groups]) を ReplacerMatch に変換する。
 *
 * groups は「正規表現が名前付きキャプチャグループを含む場合のみ」末尾に追加される
 * (MDN 仕様どおり。含まない場合は引数自体が無い)。offset/string は object ではなく
 * number/string なので、末尾要素が object かどうかで groups の有無を判定できる。
 */
export function replacerArgsToMatch(args: unknown[]): ReplacerMatch {
  let rest = args;
  let groups: Record<string, string | undefined> | undefined;
  const last = rest[rest.length - 1];
  if (last !== undefined && typeof last === 'object' && !Array.isArray(last)) {
    groups = last as Record<string, string | undefined>;
    rest = rest.slice(0, -1);
  }
  const input = rest[rest.length - 1] as string;
  const index = rest[rest.length - 2] as number;
  const matched = rest[0] as string;
  const captures = rest.slice(1, rest.length - 2) as Array<string | undefined>;
  return { matched, index, input, captures, groups };
}

/**
 * RegExp.prototype.exec の戻り値 (RegExpExecArray) を ReplacerMatch に変換する。
 * こちらも re.exec(fullText) で得た「元テキスト全体に対する走査結果」をそのまま使うため、
 * lookbehind/lookahead の再評価を必要としない (useFindReplace.buildMatchPreview 用)。
 */
export function execArrayToMatch(m: RegExpExecArray): ReplacerMatch {
  return {
    matched: m[0],
    index: m.index,
    input: m.input,
    captures: Array.from(m).slice(1) as Array<string | undefined>,
    groups: m.groups as Record<string, string | undefined> | undefined,
  };
}

/**
 * $ 置換パターンを ReplacerMatch の情報で展開する。
 *  - $$ -> $
 *  - $& -> マッチ全体
 *  - $` -> マッチより前の文字列
 *  - $' -> マッチより後の文字列
 *  - $n / $nn -> n 番目のキャプチャグループ (有効な範囲でなければ 1 桁として再解釈、
 *    それも無効なら $ をそのまま残す。ネイティブ String.replace と同じ挙動)
 *  - $<name> -> 名前付きキャプチャグループ
 */
export function expandReplacementPattern(pattern: string, m: ReplacerMatch): string {
  return pattern.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (whole: string, token: string, name: string | undefined) => {
    if (token === '$') return '$';
    if (token === '&') return m.matched;
    if (token === '`') return m.input.slice(0, m.index);
    if (token === "'") return m.input.slice(m.index + m.matched.length);
    if (name !== undefined) {
      return m.groups?.[name] ?? '';
    }
    const n = Number(token);
    if (n >= 1 && n <= m.captures.length) {
      return m.captures[n - 1] ?? '';
    }
    // 2 桁で範囲外なら 1 桁目だけをグループ番号として解釈し、2 桁目は literal として残す
    if (token.length === 2) {
      const n1 = Number(token[0]);
      if (n1 >= 1 && n1 <= m.captures.length) {
        return (m.captures[n1 - 1] ?? '') + token[1];
      }
    }
    return whole;
  });
}
