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
