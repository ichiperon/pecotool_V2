/**
 * Unit tests for pdfCurveTextRender.ts — buildCurveBlockOperators / buildPageRotationCm
 * arc / polyline draw paths (test gap fill wave 7)
 *
 * buildCurveGlyphOperators depends on layoutTextOnCurve from curveGlyphLayout.
 * We use real CurveDefinition objects (no mock) but stub PDFFont / PDFName to
 * avoid needing a real embedded font.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildCurveBlockOperators,
  buildPageRotationCm,
  buildCurveGlyphOperators,
} from '../../utils/pdfCurveTextRender';
import type { CurveDefinition } from '../../types';
import { PDFName } from '@cantoo/pdf-lib';
import type { PDFFont, PDFOperator } from '@cantoo/pdf-lib';

// ── mock PDFFont / PDFName ────────────────────────────────────────────────

function makeMockFont(): PDFFont {
  return {
    encodeText: vi.fn((char: string) => ({ toString: () => `<${char}>` })),
  } as unknown as PDFFont;
}

function makeMockFontKey(): PDFName {
  return PDFName.of('MockFont');
}

// arc curve (反時計回り、90°分)
const arcCurve: CurveDefinition = {
  type: 'arc',
  center: { x: 100, y: 100 },
  radius: 80,
  startAngle: 0,
  endAngle: Math.PI / 2,
};

// polyline curve (斜め3点)
const polylineCurve: CurveDefinition = {
  type: 'polyline',
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: 200, y: 0 },
  ],
};

const PAGE_HEIGHT = 842;
const FONT_SIZE = 12;

// ── buildPageRotationCm ────────────────────────────────────────────────────

describe('buildPageRotationCm', () => {
  it('rotation=0 → 空配列を返す (cm 不要)', () => {
    expect(buildPageRotationCm(0, 595, 842)).toHaveLength(0);
  });

  it('rotation=90 → concatTransformationMatrix が 1 個返る', () => {
    const ops = buildPageRotationCm(90, 595, 842);
    expect(ops).toHaveLength(1);
    // PDFOperator は toString() で "0 1 -1 0 595 0 cm" に近い文字列になる
    expect(String(ops[0])).toMatch(/cm/);
  });

  it('rotation=180 → concatTransformationMatrix が 1 個返る', () => {
    const ops = buildPageRotationCm(180, 595, 842);
    expect(ops).toHaveLength(1);
    expect(String(ops[0])).toMatch(/cm/);
  });

  it('rotation=270 → concatTransformationMatrix が 1 個返る', () => {
    const ops = buildPageRotationCm(270, 595, 842);
    expect(ops).toHaveLength(1);
    expect(String(ops[0])).toMatch(/cm/);
  });

  it('rotation=45 (非標準) → 空配列を返す (switch default)', () => {
    expect(buildPageRotationCm(45, 595, 842)).toHaveLength(0);
  });
});

// ── buildCurveGlyphOperators — arc パス ───────────────────────────────────

describe('buildCurveGlyphOperators — arc path', () => {
  it('arc curve + 3 文字 → BT / Tf / Tr / 各 Tm + Tj / ET 構造が返る', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveGlyphOperators('abc', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT);

    expect(ops.length).toBeGreaterThan(0);
    const str = ops.map(String).join(' ');
    // BT
    expect(str).toContain('BT');
    // ET
    expect(str).toContain('ET');
    // Tf (setFontAndSize)
    expect(str).toContain('Tf');
    // Tr (setTextRenderingMode = 3 invisible)
    expect(str).toContain('3 Tr');
    // Tm (setTextMatrix) が 3 文字 + word-break スペース分で 4 回
    const tmCount = (str.match(/ Tm/g) ?? []).length;
    expect(tmCount).toBe(4);
    // encodeText が各文字 + word-break U+0020 の計 4 回呼ばれる (issue #1)
    expect(font.encodeText).toHaveBeenCalledTimes(4);
  });

  it('空文字列 → 空配列', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveGlyphOperators('', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT);
    expect(ops).toHaveLength(0);
  });

  it('1 文字 → Tm が 2 回 (glyph + word-break), encodeText が 2 回', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveGlyphOperators('X', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT);
    const str = ops.map(String).join(' ');
    // glyph 'X' + word-break U+0020 の 2 Tm (issue #1)
    expect((str.match(/ Tm/g) ?? []).length).toBe(2);
    expect(font.encodeText).toHaveBeenCalledTimes(2);
    expect(font.encodeText).toHaveBeenCalledWith('X');
    expect(font.encodeText).toHaveBeenCalledWith(' ');
  });

  it('時計回り arc (endAngle < startAngle) でも ops が生成される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const cwArc: CurveDefinition = {
      type: 'arc',
      center: { x: 100, y: 100 },
      radius: 80,
      startAngle: Math.PI / 2,
      endAngle: 0, // 時計回り (sweep < 0)
    };
    const ops = buildCurveGlyphOperators('AB', cwArc, font, fontKey, FONT_SIZE, PAGE_HEIGHT);
    expect(ops.length).toBeGreaterThan(0);
    // 'A', 'B' + word-break U+0020 の計 3 回 (issue #1)
    expect(font.encodeText).toHaveBeenCalledTimes(3);
  });
});

// ── buildCurveGlyphOperators — polyline パス ──────────────────────────────

describe('buildCurveGlyphOperators — polyline path', () => {
  it('polyline curve + 4 文字 → BT...ET + 5 Tm + 5 Tj が返る (word-break 含む)', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveGlyphOperators('Test', polylineCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT);

    const str = ops.map(String).join(' ');
    expect(str).toContain('BT');
    expect(str).toContain('ET');
    // 4 glyph + 1 word-break space = 5 Tm (issue #1)
    expect((str.match(/ Tm/g) ?? []).length).toBe(5);
    expect(font.encodeText).toHaveBeenCalledTimes(5);
  });

  it('頂点 1 つだけの polyline (長さ 0) → 空配列', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const degenPolyline: CurveDefinition = {
      type: 'polyline',
      points: [{ x: 10, y: 20 }],
    };
    const ops = buildCurveGlyphOperators('Hi', degenPolyline, font, fontKey, FONT_SIZE, PAGE_HEIGHT);
    expect(ops).toHaveLength(0);
  });

  it('同一点の polyline (ゼロ長セグメント) → 空配列', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const zeroPoly: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 50, y: 50 },
        { x: 50, y: 50 },
      ],
    };
    const ops = buildCurveGlyphOperators('ZZ', zeroPoly, font, fontKey, FONT_SIZE, PAGE_HEIGHT);
    expect(ops).toHaveLength(0);
  });

  it('空文字列 → 空配列', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    expect(buildCurveGlyphOperators('', polylineCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT)).toHaveLength(0);
  });
});

// ── buildCurveBlockOperators ──────────────────────────────────────────────

describe('buildCurveBlockOperators', () => {
  it('空文字列 text → 空配列 (テキストなし curve block はスキップ)', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveBlockOperators('', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, []);
    expect(ops).toHaveLength(0);
  });

  it('arc curve + rotationCm なし → q ... Q で囲まれた ops が返る', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveBlockOperators('AB', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, []);

    const str = ops.map(String).join(' ');
    // 先頭 q (pushGraphicsState)
    expect(String(ops[0])).toBe('q');
    // 末尾 Q (popGraphicsState)
    expect(String(ops[ops.length - 1])).toBe('Q');
    // BT / ET も内包されている
    expect(str).toContain('BT');
    expect(str).toContain('ET');
  });

  it('rotationCm が含まれていれば q の直後に挿入される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const rotCm = buildPageRotationCm(90, 595, 842);
    const ops = buildCurveBlockOperators('XY', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, rotCm);

    // [0] = q, [1] = cm (rotation), [2..] = inner BT...ET ops, [last] = Q
    expect(String(ops[0])).toBe('q');
    expect(String(ops[1])).toMatch(/cm/);
    expect(String(ops[ops.length - 1])).toBe('Q');
  });

  it('polyline curve + rotationCm 270 → 正常に ops が返る', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const rotCm = buildPageRotationCm(270, 595, 842);
    const ops = buildCurveBlockOperators('POLY', polylineCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, rotCm);

    expect(ops.length).toBeGreaterThan(3);
    expect(String(ops[0])).toBe('q');
    expect(String(ops[ops.length - 1])).toBe('Q');
    // 'P','O','L','Y' の 4 文字 + word-break U+0020 = 5 回 (issue #1)
    expect(font.encodeText).toHaveBeenCalledTimes(5);
  });

  it('layoutTextOnCurve が空配列を返す (degenerate polyline) → 空配列', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const degenPoly: CurveDefinition = {
      type: 'polyline',
      points: [{ x: 0, y: 0 }], // 1 点のみ = セグメントなし
    };
    const ops = buildCurveBlockOperators('TEXT', degenPoly, font, fontKey, FONT_SIZE, PAGE_HEIGHT, []);
    expect(ops).toHaveLength(0);
  });

  it('サロゲートペア文字 (emoji) 1 個 → encodeText が 2 回呼ばれる (glyph + word-break)', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const emoji = '\u{1F600}'; // 😀 (U+1F600 = surrogate pair)
    const ops = buildCurveBlockOperators(emoji, arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, []);
    expect(ops.length).toBeGreaterThan(0);
    // emoji glyph + word-break U+0020 = 2 回 (issue #1)
    expect(font.encodeText).toHaveBeenCalledTimes(2);
  });

  it('offset 未指定 → オフセット cm は挿入されない (既存挙動と同一)', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveBlockOperators('AB', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, []);
    // [0]=q, [1]=BT(rotationCm 無し) ... cm は 1 個も無い
    expect(ops.map(String).filter((s) => s.includes('cm'))).toHaveLength(0);
  });

  it('offset {0,0} → オフセット cm は挿入されない (無シフト)', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveBlockOperators('AB', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, [], { dx: 0, dy: 0 });
    expect(ops.map(String).filter((s) => s.includes('cm'))).toHaveLength(0);
  });

  it('offset 指定 (右4/下2pt) → q の直後に translate cm (1 0 0 1 dx -dy) が挿入される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const ops = buildCurveBlockOperators('AB', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, [], { dx: 4, dy: 2 });
    // [0]=q, [1]=offset cm (rotationCm 無しのため offset cm が直後に来る)
    expect(String(ops[0])).toBe('q');
    // dy は下方向なので f 成分は -2 (y-up 座標で下へずらす)
    expect(String(ops[1])).toMatch(/^1 0 0 1 4 -2 cm$/);
    expect(String(ops[ops.length - 1])).toBe('Q');
  });

  it('offset 指定 + rotationCm あり → cm が 2 個 (rotation → offset の順) 挿入される', () => {
    const font = makeMockFont();
    const fontKey = makeMockFontKey();
    const rotCm = buildPageRotationCm(90, 595, 842);
    const ops = buildCurveBlockOperators('XY', arcCurve, font, fontKey, FONT_SIZE, PAGE_HEIGHT, rotCm, { dx: 4, dy: 2 });
    // [0]=q, [1]=rotation cm, [2]=offset cm
    expect(String(ops[0])).toBe('q');
    expect(String(ops[1])).toMatch(/cm/);
    expect(String(ops[2])).toMatch(/^1 0 0 1 4 -2 cm$/);
  });
});
