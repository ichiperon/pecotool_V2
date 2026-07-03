/**
 * Regression test for issue #99:
 *   OCR-text-layer baseline drifted upward after 校正→保存→再読込.
 *
 * 背景 (THE BUG):
 *   #99 で baseline を pdf-lib の `heightAtSize(size, {descender:false})` から
 *   動的計算するようにした。しかし pdf-lib のこの API は unitsPerEm≠1000 の
 *   フォントで「未スケールの descent」を減算してしまうバグを持つ。
 *   IPAmjMincho / Meiryo (ともに unitsPerEm=2048) では descentRatio が約2倍に
 *   膨張し、OCR テキスト層の baseline が bbox 上端方向へずれて見えた。
 *
 * 修正 (THE FIX):
 *   pdfSaver.ts に `getFontDescentRatio(font, fontSize)` をエクスポート。
 *   `font.embedder.font` (fontkit が保持する生メトリクス) の ascent / descent から
 *   `|descent| / (ascent - descent)` を直接算出する。比なので unitsPerEm に依存しない。
 *
 * なぜ 0.1201 が正しく 0.246 がバグなのか:
 *   IPAmjMincho.ttf: unitsPerEm=2048, ascent=1802, descent=-246。
 *   正しい descentRatio = |−246| / (1802 − (−246)) = 246 / 2048 ≈ 0.12012。
 *   旧バグコード (unitsPerEm 非対応の heightAtSize) はこのフォントで ≈ 0.2460 を返した
 *   ── ちょうど約2倍。これが baseline を上方向へずらしていた。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getFontDescentRatio } from '../../utils/pdfSaver';

/**
 * public/fonts/ の TTF を ArrayBuffer として読む。
 * jsdom 上の pdf-lib `embedFont` は Node の `Buffer` を拒否し
 * (`string | Uint8Array | ArrayBuffer` のみ許可) するため、Buffer の中身を
 * 独立した ArrayBuffer にコピーして返す (integration テストと同じ手法)。
 */
function arrayBufferFromFile(fileName: string): ArrayBuffer {
  const buf = readFileSync(resolve(process.cwd(), 'public/fonts', fileName));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

describe('pdfSaver issue #99: getFontDescentRatio (unitsPerEm-aware descent 比)', () => {
  it('IPAmjMincho (unitsPerEm=2048) の descentRatio が正しく ≈0.1201 になる', async () => {
    // 実フォントを fontkit 経由で埋め込み、embedder.font に生メトリクスを持たせる。
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const ipaMjMinchoBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const font = await pdfDoc.embedFont(ipaMjMinchoBytes, { subset: true });

    const ratio = getFontDescentRatio(font, 100);

    // 正しい値: 246 / (1802 + 246) = 246 / 2048 ≈ 0.12012。
    // toBeCloseTo(x, 2) は |actual - x| < 0.5e-2 を要求するので 0.1201 と一致する。
    expect(ratio).toBeCloseTo(0.1201, 2);

    // #99 回帰ガード: 旧バグ値は ≈0.246 だった (unitsPerEm 非対応の
    // heightAtSize による約2倍の膨張)。0.18 を下回ることを要求して、
    // unitsPerEm を考慮しない heightAtSize ベース計算の再混入を検出する。
    expect(ratio).toBeLessThan(0.18);
  });
});

describe('PCT-092: descent 比の上限キャップ (0.12)', () => {
  // 背景: Meiryo の hhea メトリクスは行間設計込みで descent 比 ≈ 0.293 と深く、
  // baseline が bbox 下端から 29.3% に置かれてスキャン和文活字の実位置
  // (行下端から約 10〜12%) より上にずれ、Acrobat の選択ハイライトが
  // 「左上に寄って」見えた (v2.0.15 実機報告)。0.12 で打ち切る。
  const mockFont = (ascent: number, descent: number) =>
    ({ embedder: { font: { ascent, descent } } }) as unknown as Parameters<typeof getFontDescentRatio>[0];

  it('Meiryo 相当 (ascent=1060, descent=-440, 生比≈0.293) は 0.12 に丸められる', () => {
    expect(getFontDescentRatio(mockFont(1060, -440), 12)).toBe(0.12);
  });

  it('descent の浅いフォント (生比≈0.0526) は実値のまま返る', () => {
    expect(getFontDescentRatio(mockFont(1800, -100), 12)).toBeCloseTo(100 / 1900, 4);
  });

  it('メトリクス欠如時のフォールバック既定値もキャップ値に揃う', () => {
    const broken = { embedder: {}, heightAtSize: () => 0 } as unknown as Parameters<typeof getFontDescentRatio>[0];
    expect(getFontDescentRatio(broken, 12)).toBe(0.12);
  });

  it('embedder スパン (ascent-descent) が 0 以下の異常フォントは heightAtSize ベースのフォールバックへ倒れる', () => {
    // descent > ascent という壊れたメトリクス (span<=0) は embedder ベース計算を
    // スキップし、heightAtSize(size)/heightAtSize(size,{descender:false}) の比較
    // フォールバックへ倒れる。
    const font = {
      embedder: { font: { ascent: 100, descent: 200 } }, // span = 100-200 = -100 <= 0
      heightAtSize: (_size: number, opts?: { descender?: boolean }) =>
        opts?.descender === false ? 8 : 10,
    } as unknown as Parameters<typeof getFontDescentRatio>[0];
    // フォールバック生比: (10-8)/10 = 0.2 → 0.12 にキャップされる
    expect(getFontDescentRatio(font, 12)).toBe(0.12);
  });
});
