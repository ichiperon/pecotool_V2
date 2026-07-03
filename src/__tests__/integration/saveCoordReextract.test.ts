/**
 * N-4: 保存座標の再抽出回帰（横書き × /Rotate 0/90/180/270）
 *
 * ねらい:
 *   buildPdfDocument が描いた本文ランの「始点座標」が、保存→pdfjs 再抽出で
 *   期待座標に一致することを transform[4]/[5]（＝text matrix Tm の平行移動成分）
 *   レベルで固定する。reloadBBoxMetaViaPdfjs は永続 JSON を verbatim 読むだけで
 *   cm/baseline のバグを素通しするため（realPdfFixtures.ts:366 loadPecoToolBBoxMeta,
 *   pdfSaverCore.ts:1254 entry.bbox=b.bbox）、ここでは「描画→抽出」経路で座標を縛る。
 *
 * Acrobat 仕様根拠:
 *   Acrobat の Ctrl+A（テキスト選択ハイライト）が読むのは各グリフラン先頭の
 *   Tm（text matrix）× CTM の合成で決まるユーザ空間座標。pdfjs の
 *   getTextContent().items[].transform[4]/[5] は同じ Tm×CTM 合成の平行移動成分を
 *   返す（同源）。よって本テストが transform を固定すれば、Acrobat 上の選択範囲位置も
 *   同時に固定される。
 *
 * 座標モデル根拠（file:line）:
 *   - 描画フレーム合成順 pushGraphicsState → rotationCm → translate(bbox.x, baselineY) → scale
 *       … pdfSaverCore.ts:1449-1454
 *   - baselineY = vh - bbox.y - textHeight*sy*(1-descentRatio)、textHeight*sy==bbox.height
 *       → baselineY = vh - bbox.y - bbox.height*(1-dr)  … pdfSaverCore.ts:1447, 1431-1432
 *   - 回転 cm（点 (X,Y) の写像）: R=90→(pageW-Y, X), R=180→(pageW-X, pageH-Y),
 *       R=270→(Y, pageH-X)  … getRotationCm pdfSaverCore.ts:566-583
 *   - viewport 寸法 vh: R=90/270 で vh=pageW, R=0/180 で vh=pageH … getViewportSize:594-598
 *   - descentRatio は DESCENT_RATIO_CAP=0.12 でキャップ。IPAexGothic raw≈0.1201,
 *       NotoSans raw>0.12 いずれも実効 dr=0.12 → shift = bbox.height*(1-0.12) = 0.88*h
 *       … getFontDescentRatio pdfSaverCore.ts:736-753
 *
 * pdfjs は /Rotate を transform に適用しない（PDF user space・原点左下、回転前）。
 * 実測（一時テストで取得）: x100 y100 w200 h20, W595 H842 で
 *   R=0   t4=100.00 t5=724.40 w=200
 *   R=90  t4=117.60 t5=100.00 w=200
 *   R=180 t4=495.00 t5=117.60 w=200
 *   R=270 t4=477.40 t5=742.00 w=200
 * これは上式に dr=0.12（shift=17.6）を入れた値に一致する。
 *
 * house-style: goldenMaster.test.ts:22（worker mock）, :61-69（env/seed）,
 *   helpers/goldenCorpus.ts:30/118/140, helpers/realPdfFixtures.ts。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
} from './helpers/goldenCorpus';
import type { PecoDocument, PageData } from '../../types';

// 全 integration テスト同様、worker URL import を空文字にモック（goldenMaster.test.ts:22）
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// --- 固定パラメータ（実測の取得条件と一致させる）---
const W = 595;
const H = 842;
const X = 100;
const Y = 100;
const BW = 200; // bbox.width
const BH = 20; // bbox.height
const DR = 0.12; // DESCENT_RATIO_CAP（pdfSaverCore.ts:736）
const SHIFT = BH * (1 - DR); // = 17.6（baseline シフト量）

// 許容: shift 非依存軸は厳密（±0.5）、shift 依存軸は font/丸め吸収で ±1.0
const TOL_TIGHT = 0.5;
const TOL_SHIFT = 1.0;
const TOL_WIDTH = 0.5;

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

/** 横書き1ブロックのみを持つ /Rotate=R の入力PDF＋PecoDocument を作る */
async function buildSingleHBlockInput(rotation: 0 | 90 | 180 | 270): Promise<{
  inputBytes: Uint8Array;
  doc: PecoDocument;
}> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([W, H]);
  if (rotation !== 0) page.setRotation(degrees(rotation));
  const inputBytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });

  // viewport 寸法（R=90/270 で swap）— PageData.width/height は viewport 空間
  const vw = rotation === 90 || rotation === 270 ? H : W;
  const vh = rotation === 90 || rotation === 270 ? W : H;

  const pageData: PageData = {
    pageIndex: 0,
    width: vw,
    height: vh,
    textBlocks: [
      {
        id: 'p0-b0',
        text: 'ABCDEFG',
        originalText: 'ABCDEFG',
        bbox: { x: X, y: Y, width: BW, height: BH },
        writingMode: 'horizontal',
        order: 0,
        isNew: false,
        isDirty: true,
      },
    ],
    isDirty: true,
    thumbnail: null,
    isTextExtracted: true,
  };

  const doc: PecoDocument = {
    filePath: `rot${rotation}.pdf`,
    fileName: `rot${rotation}.pdf`,
    totalPages: 1,
    metadata: {},
    pages: new Map<number, PageData>([[0, pageData]]),
  };

  return { inputBytes, doc };
}

/** 保存済み PDF をpdfjsで開き、ページ0の本文ラン（空白以外の先頭 item）の transform/width を返す */
async function readFirstTextItem(savedBytes: Uint8Array): Promise<{
  transform: number[];
  width: number;
  str: string;
}> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const copy = new Uint8Array(savedBytes.byteLength);
  copy.set(savedBytes);
  const task = pdfjsLib.getDocument({ data: copy, disableWorker: true, disableFontFace: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    // 区切り用 invisible U+0020 は別 BT...ET の別 item として出る（str.trim()==''）。
    // 本文ランは空白以外の先頭 item（buildPecoDocumentFromRealPdf:192-194 と同じフィルタ）。
    const items = (content.items as Array<any>).filter(
      (it) => typeof it.str === 'string' && it.str.trim() !== '',
    );
    if (items.length === 0) throw new Error('no text item extracted from saved PDF');
    const it = items[0];
    return { transform: it.transform as number[], width: it.width as number, str: it.str as string };
  } finally {
    try { await doc.cleanup(); } catch { /* ignore */ }
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

interface RotCase {
  R: 0 | 90 | 180 | 270;
  t4: number; // 期待 transform[4]（PDF_x）
  t5: number; // 期待 transform[5]（PDF_y）
  t4Shift: boolean; // t4 に baseline shift 項が含まれるか（→ TOL_SHIFT を使う）
  t5Shift: boolean;
}

// A-1 表（pdfSaverCore.ts:566-583 の cm 写像 × baselineY:1447 から導出）
const CASES: RotCase[] = [
  // R=0:   t4 = x,            t5 = H - y - shift
  { R: 0, t4: X, t5: H - Y - SHIFT, t4Shift: false, t5Shift: true },
  // R=90:  t4 = y + shift,    t5 = x         （advance は +PDF_y = t5 方向、t4 は一定）
  { R: 90, t4: Y + SHIFT, t5: X, t4Shift: true, t5Shift: false },
  // R=180: t4 = W - x,        t5 = y + shift
  { R: 180, t4: W - X, t5: Y + SHIFT, t4Shift: false, t5Shift: true },
  // R=270: t4 = W - y - shift, t5 = H - x   （advance は -PDF_y = t5 方向）
  { R: 270, t4: W - Y - SHIFT, t5: H - X, t4Shift: true, t5Shift: false },
];

describe('N-4: 保存座標の再抽出（横書き × 回転）', () => {
  it.each(CASES)(
    '/Rotate=$R で本文ランの transform[4]/[5] が期待座標に一致する',
    async ({ R, t4, t5, t4Shift, t5Shift }) => {
      const { inputBytes, doc } = await buildSingleHBlockInput(R);
      const saved = await buildPdfDocument(inputBytes, doc, fontBytes);

      const { transform, width, str } = await readFirstTextItem(saved);

      // 本文ランの文字列が壊れていないこと（抽出健全性）
      expect(str).toBe('ABCDEFG');

      // transform[4] (PDF_x)
      expect(Math.abs(transform[4] - t4)).toBeLessThanOrEqual(t4Shift ? TOL_SHIFT : TOL_TIGHT);
      // transform[5] (PDF_y)
      expect(Math.abs(transform[5] - t5)).toBeLessThanOrEqual(t5Shift ? TOL_SHIFT : TOL_TIGHT);

      // ラン送り幅 = bbox.width（sx = bbox.width/textWidth により厳密にスケール）
      expect(width).toBeCloseTo(BW, 0);
      expect(Math.abs(width - BW)).toBeLessThanOrEqual(TOL_WIDTH);
    },
    30_000,
  );
});
