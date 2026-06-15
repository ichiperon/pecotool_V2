import {
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
} from '@cantoo/pdf-lib';
import type { PDFFont, PDFName, PDFOperator } from '@cantoo/pdf-lib';
import type { CurveDefinition } from '../types';
import { layoutTextOnCurve } from './curveGlyphLayout';

/**
 * issue #187: curve TextBlock を per-glyph Tm/Tj operator 列に展開する。
 *
 * 戻り値: 1 ブロック分の `BT ... ET` 形式 operator 配列 (rotation cm はこの外で push する想定)。
 * 各 glyph は以下のシーケンスで描画される:
 *   /F1 size Tf
 *   3 Tr                       % invisible (OCR-style)
 *   cos sin -sin cos x y Tm
 *   <hex> Tj
 *
 * フォントは `font.encodeText(char)` で PDFHexString に変換するため、subset/ToUnicode を
 * 自動生成する pdf-lib embedFont(subset=true) と組み合わせれば Acrobat でのコピーが
 * 正しい文字列になる。
 *
 * @param text 描画文字列
 * @param curve  arc / polyline 定義 (viewport y-down)
 * @param font  primary font (subset embed 済み)
 * @param fontKey  Resources.Font dict 内のキー (例: /PecoF-XXXX)。setPageFontWithStableKey で取得済み
 * @param fontSize  文字サイズ (point)
 * @param pageHeight  PDF 座標系 (y-up) flip 用ページ高さ — getViewportSize(...).vh を渡す
 */
export function buildCurveGlyphOperators(
  text: string,
  curve: CurveDefinition,
  font: PDFFont,
  fontKey: PDFName,
  fontSize: number,
  pageHeight: number,
): PDFOperator[] {
  const transforms = layoutTextOnCurve(text, curve, fontSize, pageHeight);
  if (transforms.length === 0) return [];

  const ops: PDFOperator[] = [
    beginText(),
    setFontAndSize(fontKey, fontSize),
    // 既存 axis-aligned 経路と同じ「invisible」モード。OCR-style 選択ハイライト用途。
    setTextRenderingMode(TextRenderingMode.Invisible),
  ];

  for (const g of transforms) {
    const cos = Math.cos(g.rotation);
    const sin = Math.sin(g.rotation);
    // PDF Tm: a b c d e f = cosθ sinθ -sinθ cosθ x y
    ops.push(setTextMatrix(cos, sin, -sin, cos, g.x, g.y));
    // pdf-lib encodeText は subset font の cid を hex 化した PDFHexString を返す。
    ops.push(showText(font.encodeText(g.char)));
  }

  // issue #1 (Ctrl+A copy): axis-aligned 経路 (issue #100) と同じく、BT...ET の末尾に
  // invisible U+0020 を 1 文字追加する。Acrobat の全選択テキスト抽出は座標ヒューリスティクス
  // で隣接 BT ブロックを連結するため、word-break スペースが無いと隣接ブロックの文字が結合され
  // 欠落や文字化けが発生する。最後の glyph と同じ Tm 位置でスペースを発行する（Acrobat 7 互換）。
  if (transforms.length > 0) {
    const last = transforms[transforms.length - 1];
    const cos = Math.cos(last.rotation);
    const sin = Math.sin(last.rotation);
    ops.push(setTextMatrix(cos, sin, -sin, cos, last.x, last.y));
    ops.push(showText(font.encodeText(' ')));
  }

  ops.push(endText());
  return ops;
}

/**
 * issue #187: curve TextBlock 描画用に「ページ回転 cm を含めた」operator 配列を生成する。
 *
 * 既存 axis-aligned 経路は per-block で push/pop GS + rotationCm を呼んでいるので、
 * curve 経路も同じく per-block で wrap する。rotationCm は viewport 座標 (R=0/90/180/270)
 * を user space に揃える役割。getRotationCm(rotation, pageW, pageH) と同等の output。
 */
export function buildPageRotationCm(
  rotation: number,
  pageW: number,
  pageH: number,
): PDFOperator[] {
  switch (rotation) {
    case 90:
      return [concatTransformationMatrix(0, 1, -1, 0, pageW, 0)];
    case 180:
      return [concatTransformationMatrix(-1, 0, 0, -1, pageW, pageH)];
    case 270:
      return [concatTransformationMatrix(0, -1, 1, 0, 0, pageH)];
    default:
      return [];
  }
}

/**
 * curve TextBlock 1 個分のフル operator: q + rotation cm + (offset cm) + BT...ET + Q
 *
 * offset は OCR テキスト層の表示オフセット (point)。viewport 表示座標系で平行移動する:
 * dx>0 で右、dy>0 で下。axis-aligned 経路の translate と同じく rotationCm の後に適用するため、
 * ページ回転に依らず「表示上の右/下」へ一様にずれる。未指定 (0,0) なら cm を発行しない。
 */
export function buildCurveBlockOperators(
  text: string,
  curve: CurveDefinition,
  font: PDFFont,
  fontKey: PDFName,
  fontSize: number,
  pageHeight: number,
  rotationCm: PDFOperator[],
  offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
): PDFOperator[] {
  // Empty text curve block is intentionally skipped — no operators to emit.
  if (!text) return [];
  const inner = buildCurveGlyphOperators(text, curve, font, fontKey, fontSize, pageHeight);
  if (inner.length === 0) return [];
  const offsetCm: PDFOperator[] =
    offset.dx === 0 && offset.dy === 0
      ? []
      : [concatTransformationMatrix(1, 0, 0, 1, offset.dx, -offset.dy)];
  return [pushGraphicsState(), ...rotationCm, ...offsetCm, ...inner, popGraphicsState()];
}
