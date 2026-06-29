/**
 * N-4: 縦書き × 回転（/Rotate）回帰
 *
 * 目的:
 *   writingMode='vertical' のブロックを /Rotate=90（および 270）ページに保存したとき、
 *   保存後 PDF を pdfjs で開き直して得る「再抽出座標（item.transform[4]/[5]）」が
 *   保存パスの座標モデルに一致することを固定し、回転×縦書きの座標退行を検知する。
 *
 * 座標モデルの根拠（すべて現行コード由来・file:line）:
 *   - 縦書き合成式: src/utils/pdfSaverCore.ts:1368-1392
 *       sx_outer = bbox.width / textHeight                (1368)
 *       sy_outer = bbox.height / textWidth                (1369)
 *       baselineX_run = bbox.x + descentRatio*bbox.width  (1384)
 *       baselineY_run = vh - bbox.y - offsetInPage        (1385, offsetInPage は advance 累積=1402)
 *       合成: pushGraphicsState, ...rotationCm,
 *             translate(baselineX_run, baselineY_run), scale(sx_outer, sy_outer)  (1387-1392)
 *       描画は drawText(rotate=degrees(-90))               (1394)
 *   - 回転 cm（点 (X,Y) を (a·X+c·Y+e, b·X+d·Y+f) へ写す）: getRotationCm src/utils/pdfSaverCore.ts:566-583
 *       R=90 : cm(0,1,-1,0,pageW,0) → (pageW−Y, X)
 *       R=270: cm(0,-1,1,0,0,pageH) → (Y, pageH−X)
 *   - viewport 寸法: getViewportSize src/utils/pdfSaverCore.ts:595-598（R=90/270 で vh=pageW）
 *   - rotation 取得元: page.getRotation()（入力 PDF の /Rotate）src/utils/pdfSaverCore.ts:1286
 *   - descentRatio キャップ: getFontDescentRatio src/utils/pdfSaverCore.ts:736
 *       DESCENT_RATIO_CAP=0.12。IPAexGothic raw≈0.1201 → 実効 dr=0.12。
 *
 * 期待値の導出（pageW=595, pageH=842, /Rotate=R, viewport=(842,595), dr=0.12）:
 *   各 run の glyph 原点（translate 点）を rotationCm で PDF user space に写したものが
 *   pdfjs item.transform[4]/[5]（PDF user space・/Rotate 適用前。pdfjs は回転を適用しない）。
 *
 *   R=90 縦書き: vh=pageW=595。translate点=(bbox.x+dr·w, 595−bbox.y)。
 *     R=90 写像 (X,Y)→(595−Y, X):
 *       t4(PDF_x) = 595 − (595−bbox.y)            = bbox.y                  … advance で増加
 *       t5(PDF_y) = bbox.x + dr·w                  ≈ 一定（縦方向 advance に不変）
 *     ⇒ 縦書き×R=90 の advance は **+PDF_x**、PDF_y は列位置 bbox.x+dr·w で一定。
 *
 *   R=270 縦書き: vh=pageW=595。translate点=(bbox.x+dr·w, 595−bbox.y)。
 *     R=270 写像 (X,Y)→(Y, 842−X):
 *       t4(PDF_x) = 595 − bbox.y                   … advance で減少
 *       t5(PDF_y) = 842 − (bbox.x+dr·w)            ≈ 一定
 *
 * 危険回避（誤仕様固定の防止）:
 *   - 計画の「PDF_y reduce（縦 advance で PDF_y 減少）」は誤り。本テストは PDF_y を **一定**
 *     （列位置=bbox.x+dr·w）として固定し、"PDF_y reduce" は assert しない。advance に連動して
 *     動くのは PDF_x 側（R=90 は増加）。根拠は getRotationCm 線形部 src/utils/pdfSaverCore.ts:575,579。
 *   - reloadBBoxMetaViaPdfjs は永続 JSON を verbatim 返すだけ（src/.../helpers/realPdfFixtures.ts:353-375,
 *     書込元 pdfSaverCore.ts:1254 付近）なので cm/baseline バグを素通しする。座標モデルの検証には
 *     pdfjs item.transform（描画→抽出経路）を必ず併用する。meta は lossless 確認にのみ使う。
 *   - 縦長 bbox（height>width）が回転往復後も保持されることは goldenMaster.test.ts:405 と同型で確認。
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import type { PecoDocument, PageData, TextBlock } from '../../types';
import { buildPdfDocument } from '../../utils/pdfSaver';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
} from './helpers/goldenCorpus';
import {
  reloadBBoxMetaViaPdfjs,
  buildPecoDocumentFromRealPdf,
} from './helpers/realPdfFixtures';

// 全 integration テスト先頭で必須（goldenMaster.test.ts:22）
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const PAGE_W = 595;
const PAGE_H = 842;
const DR = 0.12; // 実効 descentRatio（IPAexGothic raw≈0.1201 → cap 0.12, pdfSaverCore.ts:736）

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** /Rotate=R を持つ 1 ページ（595×842）の空 PDF を返す。 */
async function makeRotatedBlankPdf(rotate: 0 | 90 | 180 | 270): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  if (rotate !== 0) page.setRotation(degrees(rotate));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/**
 * 縦書きブロック 1 つを持つ PecoDocument を組む。
 * R=90/270 のとき viewport 寸法は (pageH, pageW)=(842,595)（getViewportSize 準拠）なので
 * PageData の width/height はその viewport 寸法で与える。
 */
function makeVerticalDoc(
  rotate: 0 | 90 | 180 | 270,
  bbox: { x: number; y: number; width: number; height: number },
  text: string,
): PecoDocument {
  const swap = rotate === 90 || rotate === 270;
  const vw = swap ? PAGE_H : PAGE_W;
  const vh = swap ? PAGE_W : PAGE_H;
  const block: TextBlock = {
    id: 'vblock-0',
    text,
    originalText: text,
    bbox,
    writingMode: 'vertical',
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: vw,
    height: vh,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
    isTextExtracted: true,
  };
  // rotation は PageData では指定しない（入力 PDF の /Rotate を採用させる: pdfSaverCore.ts:1286）
  return {
    filePath: 'vert.pdf',
    fileName: 'vert.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map<number, PageData>([[0, page]]),
  };
}

/** 保存済み PDF をページ 0 の非空テキスト item 群（順序維持）として返す。 */
async function extractTextItems(savedBytes: Uint8Array): Promise<Array<{ str: string; transform: number[] }>> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const copy = new Uint8Array(savedBytes.byteLength);
  copy.set(savedBytes);
  const doc = await pdfjsLib.getDocument({ data: copy, disableWorker: true, disableFontFace: true }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = (content.items as Array<any>)
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => ({ str: it.str as string, transform: it.transform as number[] }));
  try { await doc.cleanup(); } catch { /* ignore */ }
  try { await doc.destroy(); } catch { /* ignore */ }
  return items;
}

// ---------------------------------------------------------------------------
// N-4(a): 縦書き × R=90 — 再抽出 transform が座標モデルに一致
// ---------------------------------------------------------------------------

describe('N-4 縦書き×回転回帰: /Rotate=90', () => {
  const bbox = { x: 100, y: 120, width: 24, height: 200 };
  const text = 'アイウエオ';

  it('(a) reloadメタは入力 bbox/writingMode を lossless 保持', async () => {
    const input = await makeRotatedBlankPdf(90);
    const saved = await buildPdfDocument(input, makeVerticalDoc(90, bbox, text), fontBytes);
    const { meta } = await reloadBBoxMetaViaPdfjs(saved);
    expect(meta, 'meta should not be null').not.toBeNull();
    const entry = meta!['0'][0];
    expect(entry.writingMode).toBe('vertical');
    expect(entry.bbox).toEqual(bbox); // verbatim（pdfSaverCore.ts:1254 付近）
    // 縦長 bbox（height>width）保持（goldenMaster.test.ts:405 と同型）
    expect(entry.bbox.height).toBeGreaterThan(entry.bbox.width);
  }, 30_000);

  it('(b) 再抽出 transform: PDF_x≈bbox.y(始点)・PDF_y≈bbox.x+dr·w(一定)', async () => {
    const input = await makeRotatedBlankPdf(90);
    const saved = await buildPdfDocument(input, makeVerticalDoc(90, bbox, text), fontBytes);
    const items = await extractTextItems(saved);

    expect(items.length).toBeGreaterThan(0);
    const expectedT4Start = bbox.y;                 // = 120
    const expectedT5 = bbox.x + DR * bbox.width;     // = 100 + 0.12*24 = 102.88

    // pdfjs は縦書き run を 1 item に束ねる（ground-truth C.5）。始点 item（glyph 原点）を固定。
    const start = items[0].transform;
    expect(start[4]).toBeCloseTo(expectedT4Start, 0); // PDF_x 始点 ≈ bbox.y
    expect(start[5]).toBeCloseTo(expectedT5, 0);      // PDF_y ≈ 列位置（縦 advance に不変）
  }, 30_000);

  it('(b2) advance=+PDF_x / PDF_y 一定: 縦方向(viewport-y増)で PDF_x のみ増加し PDF_y は不変', async () => {
    // 縦書きの advance 方向 = viewport-y の増加（列が下へ伸びる）。同一列(x 同一)で
    // viewport-y を増やした 2 ブロックを置き、PDF_x が増加・PDF_y は一定であることを実測で固定。
    // これにより計画の "PDF_y reduce"（advance で PDF_y 減少）を反証する。根拠: getRotationCm:575。
    const input = await makeRotatedBlankPdf(90);
    const upper = { x: 100, y: 120, width: 24, height: 120 }; // viewport-y 小
    const lower = { x: 100, y: 300, width: 24, height: 120 }; // viewport-y 大（advance 進行側）
    const doc = makeVerticalDoc(90, upper, 'アイ');
    // 同ページに 2 ブロック目（lower）を追加
    const page = doc.pages.get(0)!;
    page.textBlocks.push({
      id: 'vblock-1',
      text: 'カキ',
      originalText: 'カキ',
      bbox: lower,
      writingMode: 'vertical',
      order: 1,
      isNew: false,
      isDirty: true,
    });
    const saved = await buildPdfDocument(input, doc, fontBytes);
    const items = await extractTextItems(saved);

    const a = items.find((i) => i.str.includes('アイ'));
    const b = items.find((i) => i.str.includes('カキ'));
    expect(a, 'upper item found').toBeTruthy();
    expect(b, 'lower item found').toBeTruthy();

    const expectedT5 = 100 + DR * 24; // 列位置（両ブロック同一 x）= 102.88
    // PDF_x: viewport-y 増（120→300）で増加（advance=+PDF_x）
    expect(a!.transform[4]).toBeCloseTo(120, 0);
    expect(b!.transform[4]).toBeCloseTo(300, 0);
    expect(b!.transform[4]).toBeGreaterThan(a!.transform[4]);
    // PDF_y: advance に依らず一定（"PDF_y reduce" の反証）
    expect(a!.transform[5]).toBeCloseTo(expectedT5, 0);
    expect(b!.transform[5]).toBeCloseTo(expectedT5, 0);
    expect(Math.abs(b!.transform[5] - a!.transform[5])).toBeLessThan(0.5);
  }, 30_000);

  it('(c) buildPecoDocumentFromRealPdf 再抽出で vertical/縦長 bbox を維持', async () => {
    const input = await makeRotatedBlankPdf(90);
    const saved = await buildPdfDocument(input, makeVerticalDoc(90, bbox, text), fontBytes);
    const re = await buildPecoDocumentFromRealPdf(saved, 'vert.pdf');
    const rb = re.doc.pages.get(0)!.textBlocks[0];
    expect(rb.writingMode).toBe('vertical');
    expect(rb.bbox.height).toBeGreaterThan(rb.bbox.width);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// N-4(d): 縦書き × R=270 — 回転対称の座標モデル
// ---------------------------------------------------------------------------

describe('N-4 縦書き×回転回帰: /Rotate=270', () => {
  const bbox = { x: 100, y: 120, width: 24, height: 200 };
  const text = 'アイウエオ';

  it('(d) 再抽出 transform: PDF_x≈595−bbox.y(始点)・PDF_y≈842−bbox.x−dr·w(一定)', async () => {
    const input = await makeRotatedBlankPdf(270);
    const saved = await buildPdfDocument(input, makeVerticalDoc(270, bbox, text), fontBytes);
    const items = await extractTextItems(saved);

    expect(items.length).toBeGreaterThan(0);
    const expectedT4Start = PAGE_W - bbox.y;                  // 595 - 120 = 475
    const expectedT5 = PAGE_H - bbox.x - DR * bbox.width;     // 842 - 100 - 2.88 = 739.12

    const start = items[0].transform;
    expect(start[4]).toBeCloseTo(expectedT4Start, 0);
    expect(start[5]).toBeCloseTo(expectedT5, 0);

    // R=270 縦書きの advance は -PDF_x（PDF_x 減少）・PDF_y 一定
    const t4s = items.map((i) => i.transform[4]);
    const t5s = items.map((i) => i.transform[5]);
    for (let k = 1; k < items.length; k++) {
      expect(t4s[k]).toBeLessThan(t4s[k - 1] + 0.01); // 非増加
    }
    for (const t5 of t5s) {
      expect(Math.abs(t5 - expectedT5)).toBeLessThan(2);
    }
  }, 30_000);
});
