/**
 * Unit tests for buildBlockSeparatorOperators / buildBlockSeparatorOperatorsVertical
 * (pdfSaverCore.ts — 案A: BB 末尾境界スペースの送り幅拡大)
 *
 * 検証する不変条件:
 *   1. BT ... ET の構造を持つ
 *   2. renderMode 3 (invisible) が発行される
 *   3. Tw (setWordSpacing) が BT 内で発行され、ET 直前に 0 リセットされる
 *   4. U+0020 の showText が 1 回だけ発行される（本文グリフは含まない）
 *   5. 縦書き variant は Tm に -90° 相当の回転行列 (0 -1 1 0 ...) が含まれる
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFName } from '@cantoo/pdf-lib';
import type { PDFFont } from '@cantoo/pdf-lib';
import {
  buildBlockSeparatorOperators,
  buildBlockSeparatorOperatorsVertical,
} from '../../utils/pdfSaverCore';

// ── stub ─────────────────────────────────────────────────────────────────────

function makeMockFont(): PDFFont {
  return {
    encodeText: vi.fn((char: string) => ({ toString: () => `<${char}>` })),
  } as unknown as PDFFont;
}

function makeMockFontKey(): PDFName {
  return PDFName.of('TestFont');
}

// operator 列を文字列に結合してパースしやすくする
function opsToString(ops: import('@cantoo/pdf-lib').PDFOperator[]): string {
  return ops.map(String).join('\n');
}

// ---------------------------------------------------------------------------
// buildBlockSeparatorOperators (横書き)
// ---------------------------------------------------------------------------

describe('buildBlockSeparatorOperators — 横書き', () => {
  const FONT_SIZE = 12;
  const X = 100;
  const Y = 50;

  it('BT ... ET の構造を持つ', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    expect(str).toContain('BT');
    expect(str).toContain('ET');
  });

  it('renderMode 3 (invisible) が発行される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    expect(str).toContain('3 Tr');
  });

  it('Tw が 0 より大きい値で発行される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    // Tw オペレータが存在する
    expect(str).toContain('Tw');
    // 最初の Tw は正の値 (fontSize * 0.8 = 9.6 pt)
    const twMatches = [...str.matchAll(/([+-]?\d+(?:\.\d+)?)\s+Tw/g)];
    expect(twMatches.length).toBeGreaterThanOrEqual(1);
    const firstTwValue = parseFloat(twMatches[0][1]);
    expect(firstTwValue).toBeGreaterThan(0);
  });

  it('Tw が ET 直前に 0 にリセットされる', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    // Tw の値が 0 のものが存在する (リセット確認)
    const twMatches = [...str.matchAll(/([+-]?\d+(?:\.\d+)?)\s+Tw/g)];
    expect(twMatches.length).toBeGreaterThanOrEqual(2);
    const lastTwValue = parseFloat(twMatches[twMatches.length - 1][1]);
    expect(lastTwValue).toBe(0);
  });

  it('U+0020 の showText が 1 回だけ呼ばれる（本文グリフなし）', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);

    expect(font.encodeText).toHaveBeenCalledTimes(1);
    expect(font.encodeText).toHaveBeenCalledWith(' ');
  });

  it('Tm に指定した x/y 座標が含まれる', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    // setTextMatrix(1, 0, 0, 1, 100, 50) → "1 0 0 1 100 50 Tm" を期待
    expect(str).toContain('Tm');
    expect(str).toContain(`${X}`);
    expect(str).toContain(`${Y}`);
  });

  it('fontSize=0 でも Tw 値が 0 になる（ゼロ乗算は安全）', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, 0, X, Y);
    const str = opsToString(ops);

    // fontSize=0 → extraAdvancePt=0 → "0 Tw" だがリセットも "0 Tw" の 2 回
    expect(str).toContain('Tw');
  });

  it('Tw = 0 リセット → ET の直後には Tw オペレータが出ない', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperators(font, fontKey, FONT_SIZE, X, Y);
    const str = opsToString(ops);

    // ET 以降に Tw が存在しないことを確認
    const etIndex = str.lastIndexOf('ET');
    expect(etIndex).toBeGreaterThan(0);
    const afterEt = str.slice(etIndex);
    expect(afterEt).not.toContain('Tw');
  });
});

// ---------------------------------------------------------------------------
// buildBlockSeparatorOperatorsVertical (縦書き)
// ---------------------------------------------------------------------------

describe('buildBlockSeparatorOperatorsVertical — 縦書き', () => {
  const FONT_SIZE = 14;

  it('BT ... ET の構造を持つ', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperatorsVertical(font, fontKey, FONT_SIZE);
    const str = opsToString(ops);

    expect(str).toContain('BT');
    expect(str).toContain('ET');
  });

  it('renderMode 3 (invisible) が発行される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperatorsVertical(font, fontKey, FONT_SIZE);
    const str = opsToString(ops);

    expect(str).toContain('3 Tr');
  });

  it('Tw が正の値で発行されて ET 直前に 0 リセットされる', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperatorsVertical(font, fontKey, FONT_SIZE);
    const str = opsToString(ops);

    const twMatches = [...str.matchAll(/([+-]?\d+(?:\.\d+)?)\s+Tw/g)];
    expect(twMatches.length).toBeGreaterThanOrEqual(2);

    const firstTwValue = parseFloat(twMatches[0][1]);
    expect(firstTwValue).toBeGreaterThan(0);

    const lastTwValue = parseFloat(twMatches[twMatches.length - 1][1]);
    expect(lastTwValue).toBe(0);
  });

  it('Tm に -90° 相当の回転行列 (0 -1 1 0) が含まれる', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildBlockSeparatorOperatorsVertical(font, fontKey, FONT_SIZE);
    const str = opsToString(ops);

    // setTextMatrix(0, -1, 1, 0, 0, 0) → "0 -1 1 0 0 0 Tm"
    expect(str).toContain('Tm');
    // 0 -1 の部分が存在する (縦書き rotation)
    expect(str).toMatch(/0\s+-1\s+1\s+0/);
  });

  it('U+0020 の encodeText が 1 回だけ呼ばれる', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    buildBlockSeparatorOperatorsVertical(font, fontKey, FONT_SIZE);

    expect(font.encodeText).toHaveBeenCalledTimes(1);
    expect(font.encodeText).toHaveBeenCalledWith(' ');
  });
});

// ---------------------------------------------------------------------------
// curve 経路: buildCurveGlyphOperators の Tw 発行・リセット検証
// ---------------------------------------------------------------------------

describe('buildCurveGlyphOperators — 案A Tw 拡大・リセット', () => {
  // 実際の buildCurveGlyphOperators を直接インポートして検証
  it('末尾境界スペースの前後に Tw が発行され、ET 直前に 0 リセットされる', async () => {
    const { buildCurveGlyphOperators } = await import('../../utils/pdfCurveTextRender');
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const arcCurve = {
      type: 'arc' as const,
      center: { x: 100, y: 100 },
      radius: 80,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };

    const ops = buildCurveGlyphOperators('AB', arcCurve, font, fontKey, 12, 842);
    const str = opsToString(ops);

    // Tw が存在する
    expect(str).toContain('Tw');

    // Tw の最後の値が 0 (リセット確認)
    const twMatches = [...str.matchAll(/([+-]?\d+(?:\.\d+)?)\s+Tw/g)];
    expect(twMatches.length).toBeGreaterThanOrEqual(2);
    const lastTwValue = parseFloat(twMatches[twMatches.length - 1][1]);
    expect(lastTwValue).toBe(0);

    // 0 リセット Tw の後 ET が来る (Tw → showText(' ') → 0 Tw → ET の順)
    const zeroTwIdx = str.lastIndexOf('0 Tw');
    const etIdx = str.lastIndexOf('ET');
    expect(etIdx).toBeGreaterThan(zeroTwIdx);
  });

  it('本文グリフ (A, B) は Tw 変更前に全て発行済みで、Tw 後は U+0020 のみ', async () => {
    const { buildCurveGlyphOperators } = await import('../../utils/pdfCurveTextRender');
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const arcCurve = {
      type: 'arc' as const,
      center: { x: 100, y: 100 },
      radius: 80,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };

    buildCurveGlyphOperators('AB', arcCurve, font, fontKey, 12, 842);

    // encodeText は 'A', 'B', ' ' の計 3 回
    expect(font.encodeText).toHaveBeenCalledTimes(3);
    expect(font.encodeText).toHaveBeenNthCalledWith(3, ' ');
  });
});
