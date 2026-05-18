/**
 * Issue #41: dropTrailingOperand / findNumericOperandStart の境界ケース回帰テスト。
 *
 * - `.3` のようなドット先頭小数 (PDF 仕様 §7.3.3 で valid な数値リテラル) を
 *   correct な offset で drop できること。
 * - 非 numeric な trailing token (オペレータ・文字列・名前) は drop されないこと
 *   (旧実装は delimiter まで丸ごと喰っていた)。
 */
import { describe, it, expect } from 'vitest';
import { stripTextBlocks } from '../../utils/pdfContentStream';

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const dec = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

describe('stripTextBlocks numeric operand drop (#41)', () => {
  it('Tw の単一 operand が `.3` でも正しく drop される', () => {
    // Tw takes 1 operand. `.3 Tw` → `.3` 削除 → Tw も除去
    const input = enc('q\n.3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toMatch(/\.3/);
    expect(out).not.toContain('Tw');
    expect(out).toContain('q');
  });

  it('`/Foo .3 Tw` のように name + numeric が並ぶと .3 のみ drop、/Foo は残る', () => {
    // findNumericOperandStart は `/` を operand に含めない。Tw は 1 operand を取り、
    // numeric 専用パーサで `.3` を drop。`/Foo` は次の iteration が回らないため残る。
    const input = enc('q\n/Foo .3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toMatch(/\.3\b/);
    expect(out).not.toContain('Tw');
    // /Foo は preserve される
    expect(out).toContain('/Foo');
  });

  it('text operator の numeric operand を符号付き・小数混在で drop できる', () => {
    // Td takes 2 operands (numerics). `-1.5 +0.3 Td` → 両方 drop → Td 削除
    const input = enc('q\n-1.5 +0.3 Td\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Td');
    expect(out).not.toMatch(/-1\.5/);
    expect(out).not.toMatch(/\+0\.3/);
    expect(out).toContain('q');
  });

  it('numeric ではない trailing token は drop されない (旧実装の暴走を防ぐ)', () => {
    // Tw に対し、operand 位置に non-numeric 識別子 `Foo` が来た場合 (PDF 的には不正だが
    // 念のため): numeric only パーサは `Foo` を operand と見なさず drop しない。
    // 旧実装は delimiter まで丸ごと喰っていたため、ここで `Foo` まで消える誤動作が
    // あった。
    const input = enc('q\nFoo Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    expect(out).toContain('Foo');
  });

  it('Tm の 6 operand (整数 + 小数混在) を全て drop する', () => {
    // Tm matrix: a b c d e f Tm. e/f が小数のケース。
    const input = enc('q\n1 0 0 1 12.5 .25 Tm\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tm');
    expect(out).not.toMatch(/12\.5/);
    expect(out).not.toMatch(/\.25\b/);
    expect(out).toContain('q');
  });

  it('単独 `.` は numeric として drop されない', () => {
    const input = enc('q\n. Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    // `.` は残る (numeric として扱われないため)
    expect(out).toContain('.');
  });

  it('`1.2.3` のような複数ドット混入はトークン拒否', () => {
    const input = enc('q\n1.2.3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    expect(out).toContain('1.2.3');
  });
});
