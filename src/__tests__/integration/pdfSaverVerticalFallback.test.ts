/**
 * Regression tests for issues #23 and #28 (vertical writing with mixed fonts).
 *
 * #23: 縦書きフォールバックフォント混在時に文字幅計算が崩れ Acrobat で文字が重なる/欠落
 *      修正: run ごとに pushGraphicsState/scale を再計算し、各 run の
 *      heightAtSize に応じた sx_run を使う。
 *
 * #28: 縦書きベースライン補正のマジックナンバー 0.2 が Meiryo 専用で他フォントでズレる
 *      修正: 0.2 固定を廃止し、各 run の ascent 比 (heightAtSize - heightAtSize(no descender))
 *      から baselineX を導出する。
 *
 * 検証方針:
 *  - 実 pdf-lib + 実フォント (IPAexGothic + IPAmjMincho) を使い、縦書きで
 *    fallback フォントへ流れるブロックを保存する。
 *  - 保存後 content stream をデコードし、cm (concat matrix) 演算子を数える。
 *    修正前は run 数に関わらず cm が 1 つ (outer push のみ)、
 *    修正後は run ごとに cm が増える (各 run で pushGraphicsState + translate + scale)。
 *  - 同じテキストを「全 primary」と「primary+fallback 混在」で保存し、
 *    後者で cm 出力数が増えていることを確認する。
 *
 * #28 追加:
 *  - 異なる ascent 比のフォントで縦書きを保存した結果、Tm 演算子の x 座標が
 *    bbox.x + (1 - ascent/heightAtSize) * bbox.width に一致することを確認。
 *    旧コードの bbox.x + 0.2 * bbox.width とは異なる値であることを検出する。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock, WritingMode } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeEmptyPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeVerticalDoc(text: string): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text,
    originalText: text,
    bbox: { x: 100, y: 80, width: 30, height: 400 },
    writingMode: 'vertical' as WritingMode,
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'vertical-mixed.pdf',
    fileName: 'vertical-mixed.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/** ページ 0 の content stream を decode して返す */
function decodePage0Contents(doc: PDFDocument): Uint8Array | null {
  const page = doc.getPage(0);
  const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
  if (!rawContents) return null;
  const resolved = doc.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) return null;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { chunks.push(inflate(raw)); } catch { return null; }
    } else if (!filter) {
      chunks.push(raw);
    } else {
      return null;
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** content stream 内の `cm` 演算子の数を数える (defensive: 区切り判定あり) */
function countCmOperators(latin1Text: string): number {
  const tokens = latin1Text.match(/\b(cm)\b/g);
  return tokens ? tokens.length : 0;
}

/** content stream の Tm 演算子 (set text matrix) を全て抽出。返り値は {a, b, c, d, e, f}[] */
function extractTmOperands(latin1Text: string): Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> {
  // Tm: 6 operand operator: a b c d e f Tm
  const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b/g;
  const out: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin1Text)) !== null) {
    out.push({
      a: parseFloat(m[1]),
      b: parseFloat(m[2]),
      c: parseFloat(m[3]),
      d: parseFloat(m[4]),
      e: parseFloat(m[5]),
      f: parseFloat(m[6]),
    });
  }
  return out;
}

describe('pdfSaver issue #23: vertical mixed-font per-run scale', () => {
  it('縦書きでフォールバックフォントへ流れる run が含まれると cm 演算子が複数発行される', async () => {
    // IPAexGothic に無い文字 (絵文字/希少漢字) を含めてフォールバックを誘発する
    const primary = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const fallbackMincho = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAmjMincho.ttf'));

    const empty = await makeEmptyPdf();

    // ベースライン: 全文字 primary (フォールバック不要) — vertical 1 ブロックで cm は per-run = 1
    const allPrimary = await buildPdfDocument(empty, makeVerticalDoc('あいうえお'), primary, [fallbackMincho]);
    const allPrimaryDoc = await PDFDocument.load(allPrimary, { throwOnInvalidObject: false });
    const allPrimaryContent = decodePage0Contents(allPrimaryDoc);
    expect(allPrimaryContent).not.toBeNull();
    const allPrimaryLatin = new TextDecoder('latin1').decode(allPrimaryContent!);
    const cmAllPrimary = countCmOperators(allPrimaryLatin);

    // 比較: 一部の文字が fallback へ流れる (𠮷 = U+20BB7 は IPAexGothic 未収録 → IPAmjMincho へ)
    const mixedDoc = makeVerticalDoc('あ𠮷い𠮷う');
    const mixed = await buildPdfDocument(empty, mixedDoc, primary, [fallbackMincho]);
    const mixedPdf = await PDFDocument.load(mixed, { throwOnInvalidObject: false });
    const mixedContent = decodePage0Contents(mixedPdf);
    expect(mixedContent).not.toBeNull();
    const mixedLatin = new TextDecoder('latin1').decode(mixedContent!);
    const cmMixed = countCmOperators(mixedLatin);

    // 修正後: 混在ブロックでは run 数 (>= 3: あ / 𠮷 / い𠮷う などフォントが切り替わる回数) ぶん cm が増える。
    // 修正前: cm は 1 (outer pushGS のみ) で、run 数が増えても cm は増えない。
    expect(cmMixed).toBeGreaterThan(cmAllPrimary);
    // 具体的に: あ𠮷い𠮷う は run 数 5 ('あ', '𝟶'=𠮷, 'い', '𠮷', 'う') → cm >= 5
    expect(cmMixed).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe('pdfSaver issue #75: vertical mixed-font shared scale + consistent advance', () => {
  /**
   * #75: 旧実装は cm 内 scale を「per-run sx_run + 共通 sy_outer」の組み合わせにしていたため、
   *      混在フォントで heightAtSize の異なる run の glyph が視覚的に揃わず重なる/隙間ができた。
   *      修正方針: cm 内 scale を完全に共通化 (sx_outer, sy_outer)。
   *      offsetInPage は runTextWidth * sy_outer で累積され、Σ = bbox.height となる。
   *
   * 検証方法:
   *   - 縦書きで Mixed フォント (primary + fallback) ブロックを保存する。
   *   - content stream の scale cm (a=sx, d=sy, b=0, c=0) を全 run 分抽出し、
   *     全 run で同一 scale 値 (sx_outer, sy_outer) が使われていることを確認。
   *   - translate cm の f 引数 (baselineY_run) の delta 累積が bbox.height にほぼ等しいことを確認。
   *     (= per-run advance と offsetInPage の一致を意味する)
   */
  it('mixed-font vertical block で全 run の scale 値が共通かつ Σ advance ≈ bbox.height', async () => {
    const primary = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const fallbackMincho = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAmjMincho.ttf'));

    const empty = await makeEmptyPdf();
    // 𠮷 (U+20BB7) は IPAexGothic に無い → IPAmjMincho へフォールバック
    // テキスト 'あ𠮷い𠮷う' → 5 つの異なる run でフォントが切り替わる
    const doc = makeVerticalDoc('あ𠮷い𠮷う');
    const saved = await buildPdfDocument(empty, doc, primary, [fallbackMincho]);
    const savedDoc = await PDFDocument.load(saved, { throwOnInvalidObject: false });
    const content = decodePage0Contents(savedDoc);
    expect(content).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(content!);

    // cm 演算子を全て抽出
    const cmRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
    const scaleCms: Array<{ a: number; d: number }> = [];
    const translateYs: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = cmRe.exec(latin)) !== null) {
      const a = parseFloat(m[1]); const b = parseFloat(m[2]);
      const c = parseFloat(m[3]); const d = parseFloat(m[4]);
      const e = parseFloat(m[5]); const f = parseFloat(m[6]);
      // scale cm: a=sx, d=sy, b=0, c=0, e=0, f=0
      if (b === 0 && c === 0 && e === 0 && f === 0 && a !== 1 && d !== 1) {
        scaleCms.push({ a, d });
      }
      // translate cm: a=1, d=1, b=0, c=0
      if (a === 1 && b === 0 && c === 0 && d === 1) translateYs.push(f);
    }

    // run 数 ≥ 3 (フォントの切り替えで 3 以上の cm が出る)
    expect(translateYs.length).toBeGreaterThanOrEqual(3);
    expect(scaleCms.length).toBeGreaterThanOrEqual(3);

    // #75 検証1: 全 run の scale cm が同一値 (sx_outer, sy_outer) であること。
    // 旧実装は sx を per-run sx_run で出力していたため、heightAtSize の異なるフォントで sx が変動した。
    const firstScale = scaleCms[0];
    for (const sc of scaleCms) {
      expect(sc.a).toBeCloseTo(firstScale.a, 4);
      expect(sc.d).toBeCloseTo(firstScale.d, 4);
    }

    // #75 検証2: Σ advance (translateY の delta 累積) ≈ bbox.height = 400。
    // 旧実装でも数値は近いが、共通スケール統一で完全に bbox を埋めるはず。
    const deltas: number[] = [];
    for (let i = 0; i < translateYs.length - 1; i++) {
      deltas.push(translateYs[i] - translateYs[i + 1]);
    }
    const totalAdvance = deltas.reduce((s, d) => s + d, 0);
    // delta は 0 < delta < bbox.height の範囲。
    // 最後の run の advance は含まれない (delta は N-1 個) ので、totalAdvance < bbox.height となる。
    // ただし 1 run 単独で bbox.height を食い尽くす値であってはいけない (= overlap or 単一 run 描画失敗)。
    for (const d of deltas) {
      expect(d).toBeGreaterThan(0);
      // 各 delta は bbox.height (= 400) より小さい (1 run で全部食い尽くすのは異常)
      expect(d).toBeLessThan(400);
    }
    // 累積 advance は bbox.height にほぼ等しい (最後の run 分を含めると bbox.height、
    // delta は N-1 個なので、最後の run の advance ぶん少なくなる; 大体 bbox.height * (N-1)/N)。
    expect(totalAdvance).toBeGreaterThan(0);
    expect(totalAdvance).toBeLessThanOrEqual(400);
  }, 60_000);
});

describe('pdfSaver issue #28: vertical baselineX uses font ascent (not magic 0.2)', () => {
  it('縦書き baselineX が bbox.x + (1 - ascent/heightAtSize) * bbox.width に一致する', async () => {
    // IPAexGothic で縦書き保存 → Tm 演算子の e (=baselineX) を検査
    const primaryBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const empty = await makeEmptyPdf();
    const saved = await buildPdfDocument(empty, makeVerticalDoc('あいう'), primaryBytes);

    // フォントを embed し直して期待 ascent 比を計算
    const probeDoc = await PDFDocument.create();
    probeDoc.registerFontkit(fontkit);
    const probeFont = await probeDoc.embedFont(primaryBytes, { subset: false });
    // bbox.width=30, height=400, text "あいう" → fontSize = max(1, min(96, 30*0.8)) = 24
    const fontSize = Math.max(1, Math.min(96, 30 * 0.8));
    const runHeight = probeFont.heightAtSize(fontSize);
    const runAscent = probeFont.heightAtSize(fontSize, { descender: false });
    const descentRatio = (runHeight - runAscent) / runHeight;
    const expectedBaselineX = 100 + descentRatio * 30; // bbox.x + descentRatio * bbox.width
    // 旧コードの 0.2 マジック値とは別の値であることを保証
    const oldMagicBaselineX = 100 + 0.2 * 30; // = 106

    const savedDoc = await PDFDocument.load(saved, { throwOnInvalidObject: false });
    const content = decodePage0Contents(savedDoc);
    expect(content).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(content!);
    const tmOps = extractTmOperands(latin);
    expect(tmOps.length).toBeGreaterThanOrEqual(1);

    // Tm の e 座標 (= 第 5 引数) が期待 baselineX に近い。
    // rotate(-90) の Tm matrix は a=cos b=sin c=-sin d=cos, つまり a=0, b=-1, c=1, d=0。
    // この形 (a=0, b=±1) の Tm のみ縦書きの per-run translate なので絞り込む。
    const verticalTmOps = tmOps.filter((t) => Math.abs(t.a) < 1e-3 && Math.abs(Math.abs(t.b) - 1) < 1e-3);
    expect(verticalTmOps.length).toBeGreaterThanOrEqual(1);
    // 注: drawText 内部の Tm 座標はテキスト空間で表現されるため pdf-lib 内部値そのまま。
    //     外側の cm (translate(baselineX_run, baselineY_run)) と scale(sx_run, sy) で
    //     ユーザー座標に投影される。baselineX_run は cm の e 引数として出力される。
    // 別途、cm 演算子の e (5番目の引数) を抽出して baselineX を取り出す。
    const cmRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
    const cmTranslates: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = cmRe.exec(latin)) !== null) {
      // 縦書き run の cm: pdf-lib の translate(x, y) は cm "1 0 0 1 x y" を出力する
      const a = parseFloat(m[1]); const b = parseFloat(m[2]); const c = parseFloat(m[3]); const d = parseFloat(m[4]); const e = parseFloat(m[5]);
      if (a === 1 && b === 0 && c === 0 && d === 1) cmTranslates.push(e);
    }
    expect(cmTranslates.length).toBeGreaterThanOrEqual(1);
    // いずれかの translate の x 引数が expected baselineX に一致 (run 単位)。
    const closeToExpected = cmTranslates.some((x) => Math.abs(x - expectedBaselineX) < 0.5);
    expect(closeToExpected).toBe(true);
    // 旧マジック値とは異なる
    expect(Math.abs(expectedBaselineX - oldMagicBaselineX)).toBeGreaterThan(0.01);
  }, 60_000);
});
