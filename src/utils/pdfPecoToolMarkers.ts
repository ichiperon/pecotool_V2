// See: GitHub Issue #96 — Fix 1: 自前生成フォント識別の堅牢化
import type { PDFName } from '@cantoo/pdf-lib';

/**
 * PecoTool が新規生成するフォント辞書キーの統一プレフィックス。
 * `pdfDoc.context.newFontDictionary(tag, ref)` の tag に渡すと
 * pdf-lib が `<tag>-<random>` の形式で key を生成する。
 *
 * 以後この PECO_FONT_KEY_TAG を介して生成されたキーは
 * `isPecoToolFontKey()` で確実に検出・削除できる。
 */
export const PECO_FONT_KEY_TAG = 'PecoF';

/**
 * 旧バージョンの PecoTool が生成した古いフォントキーの正規表現リスト。
 * 後方互換のためここに残しておく。新しいキーは PECO_FONT_KEY_TAG ベース。
 *
 * 重要: いずれも「ベース名 + ハイフン + 数値サフィックス」に限定する。
 * pdf-lib が生成する subset key は `<tag>-<random数値>` の形式なので、
 * 数値サフィックスでない（例: `/Meiryo-Bold`, `/Meiryo-Italic`）原本由来の
 * フォントキーを誤って Pecotool 生成扱いしないように正規表現でガードする。
 *
 * /MS-Gothic- は OS フォントフォールバック経路でも使われるが、ベース埋め込み
 * （オリジナル）と PecoTool 生成 subset の両方が `/AAAAAA+MS-Gothic-0` のような
 * ID で出現するため判定保留扱い。Acrobat 7 互換やオリジナル文書のフォントを
 * 誤削除しないよう、ここには含めない。
 */
const LEGACY_PECO_FONT_KEY_PATTERNS: RegExp[] = [
  /^\/IPAexGothic-\d/,
  /^\/IPAmjMincho-\d/,
  /^\/NotoSansCJKjp-\d/,
  /^\/NotoSans-\d/,
  /^\/NotoSansSymbols-\d/,
  /^\/NotoSansSymbols2-\d/,
  /^\/Meiryo-\d/,
];

export function isPecoToolFontKey(key: PDFName): boolean {
  const name = key.toString();
  if (name.startsWith(`/${PECO_FONT_KEY_TAG}-`)) return true;
  return LEGACY_PECO_FONT_KEY_PATTERNS.some((pat) => pat.test(name));
}

export function isPecoToolGraphicsStateKey(key: PDFName): boolean {
  return /^\/GS-\d+$/.test(key.toString());
}
