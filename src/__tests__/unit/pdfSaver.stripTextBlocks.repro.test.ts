import { describe, it, expect, vi } from 'vitest';

// ── hoisted mocks ────────────────────────────────────────────────────────────
// pdfSaver.ts は @cantoo/pdf-lib / fontkit / pako をトップレベル import するため、
// stripTextBlocks 単独テストでも vi.mock で外部依存をスタブ化しておく。
vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument: { load: vi.fn() },
  StandardFonts: { Helvetica: 'Helvetica' },
  degrees: (n: number) => n,
  pushGraphicsState: vi.fn(),
  popGraphicsState: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  PDFName: Object.assign(function PDFName() {}, { of: vi.fn((s: string) => s) }),
  PDFHexString: { of: vi.fn(), fromText: vi.fn() },
  PDFString: { of: vi.fn(), fromText: vi.fn() },
  PDFRawStream: class {},
  PDFArray: class {},
  PDFDict: class {},
  PDFRef: class {},
  PDFObject: class {},
}));
vi.mock('@pdf-lib/fontkit', () => ({ default: {} }));
vi.mock('pako', () => ({ deflate: vi.fn(), inflate: vi.fn() }));

import { stripTextBlocks } from '../../utils/pdfSaver';

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

describe('stripTextBlocks — PDF string literal safety (repro)', () => {
  it('ケースA: 文字列内 " ET " を含む BT ブロックを正しく全削除する', () => {
    const input = enc('q\nBT /F1 12 Tf (Hello ET world) Tj ET\nQ');
    const output = dec(stripTextBlocks(input));
    // Tj が残っていれば BT...ET 外に漏れて Acrobat 7 で "Tj outside text object" が起きる
    expect(output).not.toContain('Tj');
    expect(output).not.toContain('BT');
    // BT...ET 削除後に空となった q...Q ラッパーは 2nd pass で除去される
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  it('ケースB: ベースライン（文字列内に特殊トークンなし）— BT...ET を削除', () => {
    const input = enc('q\nBT /F1 12 Tf (foo) Tj ET\nq Q');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toContain('Tj');
    expect(output).not.toContain('BT');
    expect(output).not.toContain('ET');
  });

  it('ケースC: 文字列内 " BT " を含む — Tj が漏れないこと', () => {
    const input = enc('BT /F1 12 Tf (a) Tj (BT b) Tj ET');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toContain('Tj');
  });

  it('ケースD: inline image 内の BT/ET はテキストブロックとして削除しない', () => {
    const inlineImage = 'BI /W 2 /H 2 /CS /RGB /BPC 8 ID abc BT image ET xyz EI';
    const input = enc(`q\n${inlineImage}\nBT /F1 12 Tf (remove me) Tj ET\nQ`);
    const output = dec(stripTextBlocks(input));
    expect(output).toContain(inlineImage);
    expect(output).not.toContain('remove me');
    expect(output).not.toContain('Tj');
  });

  it('ケースE: BT 外に孤立した Tj / TJ / ET があれば削除する', () => {
    const input = enc('q\n(legacy leak) Tj\n[(legacy) 120 (array)] TJ\nET\nQ');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toMatch(/\bTj\b|\bTJ\b|\bET\b/);
    expect(output).not.toContain('(legacy leak)');
    expect(output).not.toContain('[(legacy) 120 (array)]');
    // テキスト演算子が除去された結果、q...Q が空になれば 2nd pass で削除される
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  it('ケースF: BT 外の hex string Tj と壊れた ") Tj ET" 断片を削除する', () => {
    const input = enc('q\n<48656c6c6f> Tj\n) Tj ET\nQ');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toMatch(/\bTj\b|\bET\b/);
    expect(output).not.toContain('<48656c6c6f>');
    expect(output).not.toContain(')');
    // q...Q ラッパーは空になるので 2nd pass で削除される
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  it('ケースG: BT 外でも text-show ではない operand は pass1 で削除しない', () => {
    // 描画オペレータ `S` を含めて q...Q が描画扱いとなるようにする
    const input = enc('q\n(plain string without operator)\n10 20 m S\nQ');
    const output = dec(stripTextBlocks(input));
    expect(output).toContain('(plain string without operator)');
    expect(output).toContain('10 20 m');
    expect(output).toContain('S');
  });

  it('ケースG2: 描画オペレータが無い q...Q は 2nd pass で除去される', () => {
    const input = enc('q\n(plain string without operator)\n10 20 m\nQ');
    const output = dec(stripTextBlocks(input));
    // 描画オペレータが無いので q...Q ごと丸ごと削除される
    expect(output).not.toContain('(plain string without operator)');
    expect(output).not.toContain('10 20 m');
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  it('ケースH: inline image 内の ") Tj TJ ET" は削除しない', () => {
    const inlineImage = 'BI /W 2 /H 2 /CS /RGB /BPC 8 ID abc ) Tj [(x)] TJ ET xyz EI';
    const input = enc(`q\n${inlineImage}\nQ`);
    const output = dec(stripTextBlocks(input));
    expect(output).toContain(inlineImage);
  });

  it('ケースJ: ネストした空 q...Q ブロックは丸ごと除去される', () => {
    const input = enc('q\n1 0 0 1 100 200 cm\n1.5 0 0 0.83 0 0 cm\nq\n\nQ\nQ\n');
    const output = dec(stripTextBlocks(input));
    // ネストした内側の q...Q は空 → 削除 → 外側も空になり削除
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
    expect(output).not.toContain('cm');
  });

  it('ケースK: Do を含む q...Q は描画扱いで保持される', () => {
    const input = enc('q\n1 0 0 1 100 200 cm\n/Im0 Do\nQ\n');
    const output = dec(stripTextBlocks(input));
    expect(output).toContain('q');
    expect(output).toContain('Q');
    expect(output).toContain('/Im0 Do');
    expect(output).toContain('cm');
  });

  it('ケース冪等性: stripTextBlocks を 2 回適用しても結果が変わらない', () => {
    const input = enc(
      'q\nBT /F1 12 Tf (Hello) Tj ET\nQ\n' +
        'q\n1 0 0 1 0 0 cm\nq\nQ\nQ\n' +
        'q\n1 0 0 1 0 0 cm\n/Im0 Do\nQ\n',
    );
    const once = stripTextBlocks(input);
    const twice = stripTextBlocks(once);
    expect(dec(twice)).toBe(dec(once));
  });

  it('ケースL: 描画オペレータ S を含む q...Q は保持される', () => {
    const input = enc('q\n10 10 100 100 re\nS\nQ');
    const output = dec(stripTextBlocks(input));
    expect(output).toContain('q');
    expect(output).toContain('Q');
    expect(output).toContain('S');
    expect(output).toContain('10 10 100 100 re');
  });

  it('ケースM: 文字列リテラル内の q/Q は誤って状態変更しない', () => {
    // 文字列内 "q" "Q" は NORMAL ではないので、外側の描画 (S) を保護できる
    const input = enc('q\n(q Q inside string) (label) Tj\nQ');
    const output = dec(stripTextBlocks(input));
    // Tj とそのオペランドは pass1 で除去、結果として q...Q が空になり 2nd pass で削除
    expect(output).not.toContain('Tj');
    expect(output).not.toContain('q Q inside string');
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  it('ケースI: BT 外のテキスト状態/位置演算子をオペランドごと削除する', () => {
    const input = enc('q\n/F2+0 5.99829 Tf 7.197948 TL T*\n1 2 Td 1 0 0 1 3 4 Tm\nQ');
    const output = dec(stripTextBlocks(input));
    expect(output).not.toMatch(/\bTf\b|\bTL\b|\bT\*\b|\bTd\b|\bTm\b/);
    expect(output).not.toContain('/F2+0');
    // 結果として q...Q が空になり 2nd pass で除去される
    expect(output).not.toContain('q');
    expect(output).not.toContain('Q');
  });

  // -------------------------------------------------------------------------
  // Add T4 (review finding): 不正な q-Q アンバランスに対する耐性
  // -------------------------------------------------------------------------
  it('Fix 2 (T4-a): 末尾に余分な Q がある content stream を例外なく処理する', () => {
    const input = enc('q\n(text) Tj\nQ\nQ\n'); // 末尾に余分な Q
    expect(() => stripTextBlocks(input)).not.toThrow();
  });

  it('Fix 2 (T4-b): 先頭に余分な q がある content stream を例外なく処理する', () => {
    const input = enc('q\nq\n(text) Tj\nQ\n'); // 最初に余分な q
    expect(() => stripTextBlocks(input)).not.toThrow();
  });

  // #78: replacePageTextContentStreams の per-stream fallback 経路の挙動を再現する。
  // 旧実装: Contents=[A, B, C] で B が decode 失敗 → 早期 return → A と C の Tj が残存。
  // 修正後: A と C を個別に stripTextBlocks へ通して in-place strip する。
  //
  // issue #96 Fix 2 を併用後の挙動: BT..ET 除去で空になった `q...Q` ラッパーも
  // 第2パス (stripEmptyGraphicsStateBlocks) で除去される。描画に影響しないので
  // ラッパーの残存は要求しない。検証ポイントは「BT/ET/Tj とその operand が消える」こと。
  it('#78: per-stream strip 経路で個別 stream の BT..ET が削除される (multi-stream 失敗時の代替経路)', () => {
    const streamA = enc('q\nBT /F1 12 Tf (legacyA) Tj ET\nQ');
    const streamC = enc('q\nBT /F1 12 Tf (legacyC) Tj ET\nQ');

    const cleanedA = dec(stripTextBlocks(streamA));
    const cleanedC = dec(stripTextBlocks(streamC));

    expect(cleanedA).not.toContain('(legacyA)');
    expect(cleanedA).not.toMatch(/\bTj\b|\bBT\b|\bET\b/);

    expect(cleanedC).not.toContain('(legacyC)');
    expect(cleanedC).not.toMatch(/\bTj\b|\bBT\b|\bET\b/);
  });
});
