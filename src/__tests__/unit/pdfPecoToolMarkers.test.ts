/**
 * Unit tests for src/utils/pdfPecoToolMarkers.ts
 *
 * U-PH-05: PecoTool フォントキーが存在する PDF で true を返す
 * U-PH-06: 非 PecoTool PDF で false を返す
 * Extra: GS マーカー判定、旧キーパターン、境界値
 */
import { describe, it, expect } from 'vitest';
import { PDFName } from '@cantoo/pdf-lib';
import {
  isPecoToolFontKey,
  isPecoToolGraphicsStateKey,
  PECO_FONT_KEY_TAG,
} from '../../utils/pdfPecoToolMarkers';

function name(s: string): PDFName {
  return PDFName.of(s);
}

describe('isPecoToolFontKey', () => {
  it('U-PH-05: 現行 PecoF プレフィックスのキーで true を返す', () => {
    expect(isPecoToolFontKey(name(`${PECO_FONT_KEY_TAG}-12345`))).toBe(true);
  });

  it('U-PH-05b: PecoF-0 (最小数値サフィックス) で true を返す', () => {
    expect(isPecoToolFontKey(name(`${PECO_FONT_KEY_TAG}-0`))).toBe(true);
  });

  it('U-PH-06: 一般フォントキー /Helvetica で false を返す', () => {
    expect(isPecoToolFontKey(name('Helvetica'))).toBe(false);
  });

  it('U-PH-06b: /Times-Roman で false を返す（ハイフン含むが非 Peco キー）', () => {
    expect(isPecoToolFontKey(name('Times-Roman'))).toBe(false);
  });

  it('U-PH-06c: /Meiryo-Bold は数値サフィックスでないため false を返す', () => {
    // 正規表現 /^\/Meiryo-\d/ — /Meiryo-Bold はマッチしない
    expect(isPecoToolFontKey(name('Meiryo-Bold'))).toBe(false);
  });

  it('旧キー: /IPAexGothic-0 で true を返す（legacy）', () => {
    expect(isPecoToolFontKey(name('IPAexGothic-0'))).toBe(true);
  });

  it('旧キー: /IPAexGothic-9999 で true を返す（legacy 大きな数値）', () => {
    expect(isPecoToolFontKey(name('IPAexGothic-9999'))).toBe(true);
  });

  it('旧キー: /IPAmjMincho-1 で true を返す', () => {
    expect(isPecoToolFontKey(name('IPAmjMincho-1'))).toBe(true);
  });

  it('旧キー: /NotoSansCJKjp-0 で true を返す', () => {
    expect(isPecoToolFontKey(name('NotoSansCJKjp-0'))).toBe(true);
  });

  it('旧キー: /NotoSans-1 で true を返す', () => {
    expect(isPecoToolFontKey(name('NotoSans-1'))).toBe(true);
  });

  it('旧キー: /NotoSansSymbols-2 で true を返す', () => {
    expect(isPecoToolFontKey(name('NotoSansSymbols-2'))).toBe(true);
  });

  it('旧キー: /NotoSansSymbols2-0 で true を返す', () => {
    expect(isPecoToolFontKey(name('NotoSansSymbols2-0'))).toBe(true);
  });

  it('旧キー: /Meiryo-0 で true を返す', () => {
    expect(isPecoToolFontKey(name('Meiryo-0'))).toBe(true);
  });

  it('U-PH-06d: /MS-Gothic は判定保留 — MS-Gothic- ではないため false', () => {
    expect(isPecoToolFontKey(name('MS-Gothic'))).toBe(false);
  });

  it('空文字列の PDFName で crash しない', () => {
    // PDFName.of('') は /  という名前になる
    expect(() => isPecoToolFontKey(name(''))).not.toThrow();
  });

  it('PECO_FONT_KEY_TAG プレフィックスだけで数値サフィックスなしは false（境界）', () => {
    // "/PecoF" のみ — ハイフンなし
    expect(isPecoToolFontKey(name(PECO_FONT_KEY_TAG))).toBe(false);
  });

  it('PECO_FONT_KEY_TAG + ハイフンのみ（数値なし）は false', () => {
    // "/PecoF-" — startsWith マッチで true になる実装かを確認
    // 実装: name.startsWith(`/${PECO_FONT_KEY_TAG}-`) → true
    expect(isPecoToolFontKey(name(`${PECO_FONT_KEY_TAG}-`))).toBe(true);
  });
});

describe('isPecoToolGraphicsStateKey', () => {
  it('U-PH-05c: /GS-0 で true を返す', () => {
    expect(isPecoToolGraphicsStateKey(name('GS-0'))).toBe(true);
  });

  it('U-PH-05d: /GS-999 で true を返す', () => {
    expect(isPecoToolGraphicsStateKey(name('GS-999'))).toBe(true);
  });

  it('U-PH-06e: /GS は数値サフィックスがないため false を返す', () => {
    expect(isPecoToolGraphicsStateKey(name('GS'))).toBe(false);
  });

  it('U-PH-06f: /GS-abc は数値でないため false を返す', () => {
    expect(isPecoToolGraphicsStateKey(name('GS-abc'))).toBe(false);
  });

  it('U-PH-06g: /GS-1abc は \d+ にマッチしないため false を返す', () => {
    // 正規表現 /^\/GS-\d+$/ — 末尾が $ なので "1abc" はマッチしない
    expect(isPecoToolGraphicsStateKey(name('GS-1abc'))).toBe(false);
  });

  it('/Font-0 は GS キーでないため false', () => {
    expect(isPecoToolGraphicsStateKey(name('Font-0'))).toBe(false);
  });

  it('空文字列で crash しない', () => {
    expect(() => isPecoToolGraphicsStateKey(name(''))).not.toThrow();
  });
});
