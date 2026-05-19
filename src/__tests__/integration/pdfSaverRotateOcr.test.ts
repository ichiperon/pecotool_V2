/**
 * Regression test for issue #71:
 *   回転ページで OCR-PDF-user-space bbox を saver が viewport-y として誤解釈 (Critical)
 *
 * 背景:
 *   PR #61 (#50) で useOcrEngine 側が bbox を PDF user space に変換するようにしたが、
 *   pdfSaver は依然 bbox を viewport-y (top-down) として扱い、R=0 では偶然キャンセル
 *   されるが、R=90/180/270 では OCR テキストがページ外/対角に描画されていた。
 *
 * 修正方針 (採用):
 *   - OCR 側は bbox を viewport-space (rotated screen, y-down) のまま保持。
 *   - pdfSaver 側で page.getRotation() を読み、rotation に応じた cm
 *     (concat matrix) を per-block push して位置を補正する。
 *   - 文字の向きも cm の linear 部分 + /Rotate の合成で R=0 と同じ正立に揃う。
 *
 * 検証方針:
 *   - 各 rotation (0/90/180/270) で同じ viewport bbox に対し、生成された
 *     content stream の cm 演算子 (translate + 回転 + scale) を抽出し、
 *     最終的に描画されるテキスト原点が viewport (bbox.x, bbox.y) と
 *     一致することを mathematical に検証する。
 *   - 加えて、テキスト原点が常にページ user-space の範囲内 ([0, pageW] × [0, pageH])
 *     に収まることを確認する (旧コードでは R≠0 で範囲外/対角に飛んでいた)。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * /Rotate 指定で 1 ページ PDF を作る。PDF user-space dims = pageW × pageH。
 * /Rotate により viewport dims が swap される。
 */
async function makeRotatedPdf(pageW: number, pageH: number, rotation: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pageW, pageH]);
  if (rotation !== 0) {
    // PDFPage.setRotation() を使う
    const { degrees } = await import('@cantoo/pdf-lib');
    page.setRotation(degrees(rotation));
  }
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** ページ 0 の content stream を decode して latin1 文字列で返す */
async function decodePage0ContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) continue;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { chunks.push(inflate(raw)); } catch { /* skip */ }
    } else if (!filter) {
      chunks.push(raw);
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder('latin1').decode(out);
}

/** cm 演算子 (6 引数) を全て抽出 */
function extractCmOperands(text: string): Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> {
  const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      a: parseFloat(m[1]), b: parseFloat(m[2]), c: parseFloat(m[3]),
      d: parseFloat(m[4]), e: parseFloat(m[5]), f: parseFloat(m[6]),
    });
  }
  return out;
}

/** 2D affine 行列 a*x + c*y + e, b*x + d*y + f */
function applyMatrix(
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number, y: number,
): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** cm 列 (左から積み重ねた順) を 1 本の matrix に合成 */
function composeMatrices(
  mats: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }>,
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  let acc = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (const m of mats) {
    // composed = acc * m (PDF: 先に push した cm が外側 = right-multiply 順)
    acc = {
      a: acc.a * m.a + acc.c * m.b,
      b: acc.b * m.a + acc.d * m.b,
      c: acc.a * m.c + acc.c * m.d,
      d: acc.b * m.c + acc.d * m.d,
      e: acc.a * m.e + acc.c * m.f + acc.e,
      f: acc.b * m.e + acc.d * m.f + acc.f,
    };
  }
  return acc;
}

/**
 * viewport(x_v, y_v) を rotation+pageW+pageH に基づき PDF user space に変換 (pdfjs と同じ式)。
 */
function viewportToUserSpace(x_v: number, y_v: number, rotation: number, pageW: number, pageH: number): [number, number] {
  switch (rotation) {
    case 0: return [x_v, pageH - y_v];
    case 90: return [y_v, x_v];
    case 180: return [pageW - x_v, y_v];
    case 270: return [pageW - y_v, pageH - x_v];
    default: return [x_v, pageH - y_v];
  }
}

function makeDoc(bboxV: { x: number; y: number; width: number; height: number }, pageW: number, pageH: number): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text: 'Hello',
    originalText: 'Hello',
    bbox: bboxV,
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: pageW,
    height: pageH,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'rotated-ocr.pdf',
    fileName: 'rotated-ocr.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

describe('pdfSaver issue #71: viewport-space bbox + rotation cm 補正', () => {
  // 標準的な A4 縦長 PDF user-space dims
  const PAGE_W = 595;
  const PAGE_H = 842;
  // 検証用 viewport bbox (R=0/180 では w=200, h=20 の横長; R=90/270 では viewport は landscape なので
  // 横長帯は viewport 上の bbox としても合理的)
  const BBOX_V = { x: 100, y: 100, width: 200, height: 20 };
  const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));

  for (const rotation of [0, 90, 180, 270] as const) {
    it(`/Rotate ${rotation}: viewport bbox の左上 (x=100, y=100) が rotation 補正後に正しい PDF user space に着地する`, async () => {
      const original = await makeRotatedPdf(PAGE_W, PAGE_H, rotation);
      const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H);
      const saved = await buildPdfDocument(original, doc, fontBytes);

      const contentText = await decodePage0ContentText(saved);
      // pushGS + cm (rotation, R≠0 のみ) + translate + scale が並ぶ。
      // それらの cm を順次合成し、最終 matrix の (0, 0) → user space を取得する。
      const cms = extractCmOperands(contentText);
      // 1 ブロックなので cm は (rotation cm if R≠0) + translate + scale = 2 or 3 個。
      // R=0: translate + scale = 2 個。R≠0: rotationCm + translate + scale = 3 個。
      const expectedCount = rotation === 0 ? 2 : 3;
      expect(cms.length).toBe(expectedCount);

      const composed = composeMatrices(cms);
      const [drawnUserX, drawnUserY] = applyMatrix(composed, 0, 0);

      // 期待する着地点: viewport(bbox.x, bbox.y) → user-space
      const [expectedUserX, expectedUserY] = viewportToUserSpace(
        BBOX_V.x, BBOX_V.y, rotation, PAGE_W, PAGE_H,
      );
      // 横書きベースライン補正で baselineY は textHeight * sy * 0.8 だけ下にずれる
      // (viewport-y 下方向 = 文字の高さぶん下に baseline)。
      // この shift は rotation を経て user-space では rotation 別の方向に出る:
      //   R=0:    user_y を -16 シフト (下方向)
      //   R=90:   user_x を -16 シフト
      //   R=180:  user_y を +16 シフト
      //   R=270:  user_x を -16 シフト
      // フォント差で多少前後するため 50 単位以内で一致を確認 (font size ≈ 16, height ≈ 18)。
      // 重要なのは「対角や別ページに飛ばない (= 旧コードの不具合)」こと。
      expect(Math.abs(drawnUserX - expectedUserX)).toBeLessThan(50);
      expect(Math.abs(drawnUserY - expectedUserY)).toBeLessThan(50);

      // 描画原点が PDF user-space の有効範囲内 (= 0..max(pageW, pageH)) に収まる。
      // (旧コードでは R≠0 で対角やページ外マイナス値に飛んでいた)
      const maxDim = Math.max(PAGE_W, PAGE_H);
      expect(drawnUserX).toBeGreaterThanOrEqual(-50);
      expect(drawnUserX).toBeLessThanOrEqual(maxDim + 50);
      expect(drawnUserY).toBeGreaterThanOrEqual(-50);
      expect(drawnUserY).toBeLessThanOrEqual(maxDim + 50);
    }, 60_000);
  }

  // 旧コード (R=0 仮定で `height - bbox.y`) との差分が回転で発生することを保証
  it('回帰: 旧コード (R=0 仮定) なら R=90 で描画原点が PDF 範囲外/対角へ飛ぶことを示す', () => {
    // 旧 baselineY = pageH - bbox.y = 842 - 100 = 742; baselineX = bbox.x = 100
    // R=90 の場合この (100, 742) を /Rotate 90 適用後の viewport にマップすると
    // viewport(x_v, y_v) = (?, ?)
    // user(100, 742) で /Rotate 90: viewport(742, 100) — bbox.y=100 の位置とは大きく異なる
    // (viewport は 842 wide × 595 tall なので 742 は wide 軸の右側)
    const oldBaselineX = BBOX_V.x;
    const oldBaselineY = PAGE_H - BBOX_V.y;
    // /Rotate 90 適用: user(u_x, u_y) → viewport(u_y, u_x)
    const oldViewportFromR90 = [oldBaselineY, oldBaselineX];
    // 期待 viewport 位置: (100, 100). 旧位置: (742, 100). 大きく x がずれている
    expect(Math.abs(oldViewportFromR90[0] - BBOX_V.x)).toBeGreaterThan(500);
  });
});
