/**
 * stripStrayTextOperatorsOutsideTextObjects の単体テスト。
 *
 * 仕様: BT...ET（テキストレイヤー）をバイト等価で温存し、テキストオブジェクト外
 * (textDepth===0) に漏れたテキスト演算子（Tj, TJ, Tf, TL, T*, Td, TD, Tm, Tc, Tw, Tz,
 * Tr, Ts ほか）とその operand、孤児 ET、空 q-Q ラッパーのみ除去する。
 *
 * 目的: Acrobat "text operator outside text object" エラーを、原本 OCR/手補正テキストを
 * 失わずに除去する（mondai の損傷ページと同型のフィクスチャで固定）。
 */
import { describe, it, expect } from 'vitest';
import {
  stripStrayTextOperatorsOutsideTextObjects,
  hasTextOperatorsOutsideTextObjects,
  hasUnbalancedTextBlockBoundary,
} from '../../utils/pdfContentStream';

function enc(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function dec(b: Uint8Array): string {
  return new TextDecoder('latin1').decode(b);
}

describe('stripStrayTextOperatorsOutsideTextObjects', () => {
  it('BT...ET 内テキストは保持し、BT 外の漏れ演算子を除去する', () => {
    const input = enc('BT /F1 12 Tf (inside) Tj ET\n(orphan) Tj\n12 TL\n0 0 100 100 re f');
    const out = dec(stripStrayTextOperatorsOutsideTextObjects(input));
    expect(out).toContain('(inside) Tj'); // テキスト保持
    expect(out).not.toContain('(orphan)'); // 漏れ Tj 除去
    expect(out).not.toMatch(/\bTL\b/); // 漏れ TL 除去
    expect(out).toContain('re f'); // 非テキスト描画保持
    expect(hasTextOperatorsOutsideTextObjects(enc(out))).toBe(false);
  });

  it('mondai 同型: 空 q-Q ラッパー内に紛れた Tf/TL/T* を q-Q ごと除去し BT...ET は保持', () => {
    // q ... cm <漏れ Tf/TL/T*> Q（描画なし空ラッパー）+ 健全な BT...ET
    const input = enc(
      'q\n1 0 0 1 98 575 cm\n10.1 TL\n/F2 8.4 Tf\nT*\nQ\n' +
        'BT 0 0 0 rg /IPAexGothic 1 Tf 24 TL 1 0 0 1 0 0 Tm <00010002> Tj T* ET',
    );
    const out = dec(stripStrayTextOperatorsOutsideTextObjects(input));
    // 空 q-Q ラッパー（と内部の漏れ演算子）は丸ごと消える
    expect(out).not.toContain('cm');
    expect(out).not.toContain('/F2');
    // 健全な BT...ET（手補正テキスト hex）は完全保持
    expect(out).toContain('<00010002> Tj');
    expect(out).toContain('/IPAexGothic 1 Tf');
    expect(hasTextOperatorsOutsideTextObjects(enc(out))).toBe(false);
  });

  it('損傷なし・描画ありは保持（実質無変更）', () => {
    const input = enc('q\n0 0 100 100 re f\nQ\nBT /F1 12 Tf (keep) Tj ET');
    const out = dec(stripStrayTextOperatorsOutsideTextObjects(input));
    expect(out).toContain('re f');
    expect(out).toContain('(keep) Tj');
    expect(hasTextOperatorsOutsideTextObjects(enc(out))).toBe(false);
  });

  it('文字列リテラル内の "ET"/"Tj" を誤認しない（BT...ET をそのまま温存）', () => {
    const input = enc('BT /F1 12 Tf (a ET b Tj c) Tj ET');
    const out = dec(stripStrayTextOperatorsOutsideTextObjects(input));
    expect(out).toContain('(a ET b Tj c) Tj'); // 文字列内は無傷
    expect(hasTextOperatorsOutsideTextObjects(enc(out))).toBe(false);
  });

  it('冪等: 2 回適用しても結果は変わらない', () => {
    const input = enc('BT /F1 12 Tf (x) Tj ET\n(orphan) Tj\nq\n1 0 0 1 5 5 cm\nQ');
    const once = stripStrayTextOperatorsOutsideTextObjects(input);
    const twice = stripStrayTextOperatorsOutsideTextObjects(once);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });
});

// PCT-177 (#408) 残余: stream 単体で BT/ET が閉じているかの判定（ストリーム跨ぎ検出用ガード）
describe('hasUnbalancedTextBlockBoundary', () => {
  it('単体で閉じた BT...ET は false', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('q\nBT /F1 12 Tf (keep) Tj ET\nQ\n0 0 100 100 re f'))).toBe(false);
  });

  it('BT 演算子が無い stream は false', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('q\n0 0 100 100 re f\nQ'))).toBe(false);
  });

  it('BT が終端まで閉じない（stream B に ET がある想定）は true', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('q 1 0 0 1 0 0 cm\nBT\n/F1 12 Tf\n(Hi) Tj\n'))).toBe(true);
  });

  it('先頭付近に textDepth===0 での ET（stream A の BT を継続して閉じる想定）は true', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('ET\nQ\n'))).toBe(true);
  });

  it('文字列リテラル内の "BT"/"ET" は誤認識しない', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('BT (a ET b) Tj ET'))).toBe(false);
  });

  it('複数 BT...ET が単体 stream 内で全て閉じていれば false', () => {
    expect(hasUnbalancedTextBlockBoundary(enc('BT (a) Tj ET\nBT (b) Tj ET'))).toBe(false);
  });
});
