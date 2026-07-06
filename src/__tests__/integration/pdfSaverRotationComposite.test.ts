/**
 * Regression tests for #352 / #367 (PCT-129 / PCT-144):
 *   ユーザー回転×保存で、元 PDF が既に /Rotate を持つページ（スキャナ出力等）を
 *   壊さず正しく合成すること。
 *
 * 背景 (#352):
 *   旧実装は `page.setRotation(degrees(userRotation))` で /Rotate を絶対値上書きし、
 *   かつ cm 構築を setRotation 後の getRotation() フレームで行っていた。
 *   元 /Rotate が 0 でないページに userRotation を適用すると:
 *     (a) /Rotate が「元 + user」ではなく userRotation の値そのものに置き換わり、
 *         元の向き情報が無音で消失する。
 *     (b) cm フレームが合成後の値になり、bbox 捕捉フレーム (元 /Rotate) とズレて
 *         テキスト層がページ内の誤った位置に描画される。
 *
 * 修正後の期待値:
 *   - /Rotate は「元 /Rotate + userRotation」の合成値になる。
 *   - cm は bbox 捕捉フレーム (= 元 /Rotate, setRotation 前の getRotation()) を使う。
 *     bbox は「元 /Rotate で見た viewport 座標」を表しているため、cm もそのフレームで
 *     構築しないと描画位置がドリフトする。
 *
 * 検証方法:
 *   pdfSaverRotateOcr.test.ts と同じ手法 (content stream から cm 演算子を抽出して
 *   合成し、原点 (0,0) が着地する PDF user-space 座標を計算) で、
 *   「正しい着地点 = viewportToUserSpace(bbox, 元Rotate, ...)」であり、
 *   「誤った着地点 (旧バグ) = viewportToUserSpace(bbox, 合成Rotate, ...)」とは
 *   明確に異なることを固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName, PDFNumber, degrees } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { remapBboxForRotation } from '../../utils/pdfSaverCore';
import { readPecoToolBBoxMetaFromPdfDoc } from '../../utils/pdfPecoToolMetadata';
import { usePecoStore } from '../../store/pecoStore';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
// pecoStore.ts は utils/pdfLoader.ts を静的 import する。pdfLoader.ts はモジュール先頭で
// `import * as pdfjsLib from 'pdfjs-dist'` (非 legacy ビルド) しており、jsdom には無い
// DOMMatrix 等を要求するため、モジュール解決自体をモックして実体の読み込みを回避する
// (pecoStore.test.ts と同じ理由・同じモック)。resetDirty は同期的な純粋な set() のみで
// これらの IDB ヘルパを呼ばないため、スタブで問題ない。
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// helpers (pdfSaverRotateOcr.test.ts と同型)
// ---------------------------------------------------------------------------

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** /Rotate 指定で 1 ページ PDF を作る。PDF user-space dims = pageW × pageH。 */
async function makeRotatedPdf(pageW: number, pageH: number, rotation: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pageW, pageH]);
  if (rotation !== 0) {
    page.setRotation(degrees(rotation));
  }
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function readRotateDegrees(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const rotateEntry = page.node.get(PDFName.of('Rotate'));
  if (rotateEntry instanceof PDFNumber) return rotateEntry.asNumber();
  return 0;
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

function applyMatrix(
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number, y: number,
): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function composeMatrices(
  mats: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }>,
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  let acc = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (const m of mats) {
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

/** viewport(x_v, y_v) を rotation+pageW+pageH に基づき PDF user space に変換 (pdfjs と同じ式)。 */
function viewportToUserSpace(x_v: number, y_v: number, rotation: number, pageW: number, pageH: number): [number, number] {
  switch (rotation) {
    case 0: return [x_v, pageH - y_v];
    case 90: return [y_v, x_v];
    case 180: return [pageW - x_v, y_v];
    case 270: return [pageW - y_v, pageH - x_v];
    default: return [x_v, pageH - y_v];
  }
}

function makeDoc(
  bboxV: { x: number; y: number; width: number; height: number },
  pageW: number,
  pageH: number,
  userRotation: 0 | 90 | 180 | 270,
): PecoDocument {
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
    rotation: userRotation,
  };
  return {
    filePath: 'rotated-composite.pdf',
    fileName: 'rotated-composite.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

const PAGE_W = 595;
const PAGE_H = 842;
const BBOX_V = { x: 100, y: 100, width: 200, height: 20 };

describe('#352/#367 (PCT-129/PCT-144): 元 /Rotate を持つページへの userRotation 合成', () => {
  it('元 /Rotate=90 のページに userRotation=90 を適用すると /Rotate=180 (合成値) になる', async () => {
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 90);
    const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H, 90);
    const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const saved = await buildPdfDocument(original, doc, fontBytes);

    const savedRotate = await readRotateDegrees(saved);
    expect(savedRotate).toBe(180);
  }, 60_000);

  it('テキスト層の cm は捕捉フレーム (元 /Rotate=90) を使い、合成後フレーム (180) へドリフトしない', async () => {
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 90);
    const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H, 90);
    const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const saved = await buildPdfDocument(original, doc, fontBytes);

    const contentText = await decodePage0ContentText(saved);
    const cms = extractCmOperands(contentText);
    // R≠0 のため rotationCm + translate + scale = 3 個
    expect(cms.length).toBe(3);

    const composed = composeMatrices(cms);
    const [drawnUserX, drawnUserY] = applyMatrix(composed, 0, 0);

    // 正しい着地点: bbox は元 /Rotate=90 の viewport で捕捉された座標なので、
    // cm もそのフレームで構築されているはず。
    const [correctX, correctY] = viewportToUserSpace(BBOX_V.x, BBOX_V.y, 90, PAGE_W, PAGE_H);
    // 旧バグの着地点: cm を合成後フレーム (180) で構築してしまうと、この座標になる。
    const [buggyX, buggyY] = viewportToUserSpace(BBOX_V.x, BBOX_V.y, 180, PAGE_W, PAGE_H);

    // ベースライン補正 (フォント差) を許容して 50pt 以内で正しい着地点に一致することを確認。
    expect(Math.abs(drawnUserX - correctX)).toBeLessThan(50);
    expect(Math.abs(drawnUserY - correctY)).toBeLessThan(50);

    // 旧バグの着地点とは明確に異なる (ドリフトしていないことの直接反証)。
    const distToBuggy = Math.hypot(drawnUserX - buggyX, drawnUserY - buggyY);
    expect(distToBuggy).toBeGreaterThan(100);
  }, 60_000);

  it('userRotation 未設定 (回転操作なし) なら元 /Rotate=90 がそのまま保持される (既存挙動の保証)', async () => {
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 90);
    const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H, 90);
    // rotation フィールドを未設定に上書き (回転操作なしのケースを模す)
    doc.pages.get(0)!.rotation = undefined;
    const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const saved = await buildPdfDocument(original, doc, fontBytes);

    const savedRotate = await readRotateDegrees(saved);
    expect(savedRotate).toBe(90);
  }, 60_000);

  it('bboxMeta も合成後フレーム (180) へリマップされ、再ロード後の BB 位置が画像とズレない', async () => {
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 90);
    const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H, 90);
    const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const saved = await buildPdfDocument(original, doc, fontBytes);

    const savedDoc = await PDFDocument.load(saved, { throwOnInvalidObject: false });
    const meta = readPecoToolBBoxMetaFromPdfDoc(savedDoc);
    const blocks = meta['0'] as Array<{ bbox: { x: number; y: number; width: number; height: number } }>;
    expect(blocks).toBeDefined();

    // 期待値は remapBboxForRotation(originalRotation=90, finalRotation=180) の直接計算と一致する。
    const expected = remapBboxForRotation(BBOX_V, 90, 180, PAGE_W, PAGE_H);
    expect(blocks[0].bbox.x).toBeCloseTo(expected.x, 5);
    expect(blocks[0].bbox.y).toBeCloseTo(expected.y, 5);
    expect(blocks[0].bbox.width).toBeCloseTo(expected.width, 5);
    expect(blocks[0].bbox.height).toBeCloseTo(expected.height, 5);

    // 恒等 (delta=0) ではないことも確認 (リマップが実際に効いていることの直接証拠)。
    expect(blocks[0].bbox.x).not.toBeCloseTo(BBOX_V.x, 5);
  }, 60_000);

  // ── #367 (PCT-144) 本体: 多段保存の冪等性 ──────────────────────────
  //
  // 「userRotation=90 で保存 → 保存済みバイトを次回のベースとして再編集(re-dirty) →
  //   再保存」で /Rotate が 90 のまま保たれ (180 へドリフトしない)、bbox も二重に
  // リマップされないことを検証する。
  //
  // ドリフト経路 (修正前):
  //   useFileOperations.ts の setOriginalBytesCache で保存済みバイトが次回保存の
  //   ベースになる (焼き込み /Rotate = 元 + user 済み)。しかし store 側の
  //   page.rotation (ユーザー差分) が保存後もクリアされないと、再保存時に
  //   「新originalRotation(=旧合成値=90) + stale rotation(=旧userRotation=90)」が
  //   再度合成され /Rotate=180 にドリフトする。
  //
  // 修正 (pecoStore.ts resetDirty): 保存スナップショットと参照一致するページの
  // rotation をクリアし、in-memory bbox/width/height を remapBboxForRotation で
  // 合成後フレームへリベースする。これにより次回保存では userRotation=undefined
  // (delta=0) となり、/Rotate は据え置き・bbox は再リマップされない。
  it('#367: userRotation=90 で保存→resetDirty で store をリベース→再保存しても /Rotate=90 のまま・bbox が二重リマップされない', async () => {
    const fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));

    // 1回目の保存: 元 /Rotate=0、userRotation=90
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
    const doc = makeDoc(BBOX_V, PAGE_W, PAGE_H, 90);
    const livePage = doc.pages.get(0)!;
    const saved1 = await buildPdfDocument(original, doc, fontBytes);
    expect(await readRotateDegrees(saved1)).toBe(90);

    // resetDirty によるリベース: savedPageSnapshots は「保存スナップショット」として
    // 実運用と同じくオブジェクト参照の一致で判定される (useFileOperations.ts の
    // savedPageSnapshots 構築と同型)。
    usePecoStore.setState({
      document: doc,
      pageOrder: [0],
      currentPageIndex: 0,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    const savedPageSnapshots = new Map<number, PageData>([[0, livePage]]);
    usePecoStore.getState().resetDirty(savedPageSnapshots);

    const rebasedPage = usePecoStore.getState().document!.pages.get(0)!;
    // (a) rotation はクリアされている (次回保存で二重合成させない)
    expect(rebasedPage.rotation).toBeUndefined();
    // (b) bbox は合成後フレーム (0→90) へリベース済み。pdfSaverCore が書いた
    //     bboxMeta と同じ値になっているはず (remapBboxForRotation(bbox, 0, 90, ...))。
    const expectedRebasedBbox = remapBboxForRotation(BBOX_V, 0, 90, PAGE_W, PAGE_H);
    expect(rebasedPage.textBlocks[0].bbox).toEqual(expectedRebasedBbox);
    // width/height も swap 済み (R=90 は viewport 寸法が入れ替わる)
    expect(rebasedPage.width).toBe(PAGE_H);
    expect(rebasedPage.height).toBe(PAGE_W);

    // 再編集 (re-dirty): 回転操作は行わない (rotation は undefined のまま) —
    // ユーザーがテキストを少し触っただけ、というシナリオを模す。
    const reditedPage: PageData = { ...rebasedPage, isDirty: true };
    const doc2: PecoDocument = {
      ...doc,
      pages: new Map([[0, reditedPage]]),
    };

    // 2回目の保存: 入力は 1回目の保存済みバイト (=次回の "元" PDF)
    const saved2 = await buildPdfDocument(saved1, doc2, fontBytes);

    // /Rotate は 90 のまま (180 へドリフトしない)
    expect(await readRotateDegrees(saved2)).toBe(90);

    // bboxMeta も二重リマップされず、リベース済みの値と同一 (delta=0 で恒等のはず)
    const saved2Doc = await PDFDocument.load(saved2, { throwOnInvalidObject: false });
    const meta2 = readPecoToolBBoxMetaFromPdfDoc(saved2Doc);
    const blocks2 = meta2['0'] as Array<{ bbox: { x: number; y: number; width: number; height: number } }>;
    expect(blocks2[0].bbox.x).toBeCloseTo(expectedRebasedBbox.x, 5);
    expect(blocks2[0].bbox.y).toBeCloseTo(expectedRebasedBbox.y, 5);
    expect(blocks2[0].bbox.width).toBeCloseTo(expectedRebasedBbox.width, 5);
    expect(blocks2[0].bbox.height).toBeCloseTo(expectedRebasedBbox.height, 5);
  }, 60_000);
});

describe('remapBboxForRotation: 単体不変条件', () => {
  const bbox = { x: 100, y: 100, width: 200, height: 20 };

  it('delta=0 (originalRotation===finalRotation) は恒等', () => {
    expect(remapBboxForRotation(bbox, 90, 90, PAGE_W, PAGE_H)).toEqual(bbox);
    expect(remapBboxForRotation(bbox, 0, 0, PAGE_W, PAGE_H)).toEqual(bbox);
  });

  it('90/180/270/360 を1周させると元の bbox に戻る (ラウンドトリップ不変条件)', () => {
    let cur = bbox;
    let rot = 0;
    for (const step of [90, 90, 90, 90] as const) {
      const next = normalizeAngle(rot + step);
      cur = remapBboxForRotation(cur, rot, next, PAGE_W, PAGE_H);
      rot = next;
    }
    expect(cur.x).toBeCloseTo(bbox.x, 5);
    expect(cur.y).toBeCloseTo(bbox.y, 5);
    expect(cur.width).toBeCloseTo(bbox.width, 5);
    expect(cur.height).toBeCloseTo(bbox.height, 5);
  });

  function normalizeAngle(angle: number): number {
    return ((angle % 360) + 360) % 360;
  }
});
