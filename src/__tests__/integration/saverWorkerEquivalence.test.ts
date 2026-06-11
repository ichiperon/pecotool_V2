/**
 * PCT-097: pdfSaver/worker 出力等価性テスト
 *
 * pdfSaver.ts (main-thread 経路: buildPdfDocument) と
 * pdf.worker.ts (Worker 経路: __handleSavePdfForTest) が同一入力に対して
 * 同等の出力を生成することを検証する。
 *
 * PCT-052 (confidence)・PCT-053 (getRotation optional chaining)・PCT-096 (setRotation 欠落)
 * のような「二重実装の漏れ」を機械的に検出するための回帰ガード。
 *
 * 等価性の検証対象:
 *   1. /Rotate — ユーザー指定ページ回転が両経路で PDF に反映されること (PCT-096)
 *   2. bboxMeta の confidence — OCR 信頼度が両経路で永続化されること (PCT-052)
 *   3. bboxMeta のテキスト — テキストブロックが両経路で同一内容で保存されること
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFNumber } from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { __handleSavePdfForTest } from '../../utils/pdf.worker';
import { readPecoToolBBoxMetaFromPdfDoc } from '../../utils/pdfPecoToolMetadata';
import type { PageData, PecoDocument, TextBlock } from '../../types';
import type { SerializedPageData } from '../../utils/pdfWorkerTypes';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** /Rotate 指定で 1 ページ PDF を生成する */
async function makeRotatedPdf(pageW: number, pageH: number, pdfRotation: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pageW, pageH]);
  if (pdfRotation !== 0) {
    const { degrees } = await import('@cantoo/pdf-lib');
    page.setRotation(degrees(pdfRotation));
  }
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** 保存済み PDF から page 0 の /Rotate 値 (数値) を返す。未設定は 0。 */
async function readRotateDegrees(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const rotateEntry = page.node.get(PDFName.of('Rotate'));
  if (rotateEntry instanceof PDFNumber) return rotateEntry.asNumber();
  return 0;
}

/** PecoDocument から Worker 用の serialized pages Record を生成する */
function serializePages(doc: PecoDocument): Record<number, SerializedPageData> {
  const result: Record<number, SerializedPageData> = {};
  for (const [idx, page] of doc.pages.entries()) {
    const { thumbnail: _t, ...pageWithoutThumbnail } = page;
    result[idx] = pageWithoutThumbnail;
  }
  return result;
}

/**
 * ページに OCR テキストブロック + rotation を持つ PecoDocument を作成する。
 */
function makeDocument(
  pageW: number,
  pageH: number,
  userRotation?: 0 | 90 | 180 | 270,
  confidence?: number,
): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text: 'Hello',
    originalText: 'Hello',
    bbox: { x: 100, y: 100, width: 200, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
    confidence,
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
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PAGE_W = 595;
const PAGE_H = 842;
const FONT_BYTES = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));

describe('PCT-097: pdfSaver / Worker 出力等価性', () => {
  describe('/Rotate の等価性 (PCT-096)', () => {
    for (const userRotation of [0, 90, 180, 270] as const) {
      it(`userRotation=${userRotation}: 両経路で /Rotate=${userRotation} が保存される`, async () => {
        const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
        const doc = makeDocument(PAGE_W, PAGE_H, userRotation);
        const serializedPages = serializePages(doc);

        // main-thread 経路
        const mainBytes = await buildPdfDocument(originalPdf, doc, FONT_BYTES);
        const mainRotate = await readRotateDegrees(mainBytes);

        // Worker 経路
        const { savedBytes: workerBytes } = await __handleSavePdfForTest(
          originalPdf,
          { ...doc, pages: serializedPages },
          FONT_BYTES,
          [],
        );
        const workerRotate = await readRotateDegrees(workerBytes);

        expect(mainRotate).toBe(userRotation);
        expect(workerRotate).toBe(userRotation);
        expect(workerRotate).toBe(mainRotate);
      }, 60_000);
    }

    it('PCT-096 回帰: rotation=90 を設定した場合、Worker 経路の /Rotate が 90 になる', async () => {
      // このテストは PCT-096 修正 (Worker に setRotation 追加) が無いと fail する。
      // 修正前は Worker 経路で /Rotate が元の PDF のまま (0) になっていた。
      const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 0); // PDF /Rotate=0 から出発
      const doc = makeDocument(PAGE_W, PAGE_H, 90); // userRotation=90 を指定
      const serializedPages = serializePages(doc);

      const { savedBytes: workerBytes } = await __handleSavePdfForTest(
        originalPdf,
        { ...doc, pages: serializedPages },
        FONT_BYTES,
        [],
      );
      const workerRotate = await readRotateDegrees(workerBytes);

      // PCT-096 修正有り: /Rotate=90 が書き込まれる
      // PCT-096 修正無し: /Rotate=0 のまま → expect(0).toBe(90) で fail する
      expect(workerRotate).toBe(90);
    }, 60_000);
  });

  describe('bboxMeta confidence の等価性 (PCT-052)', () => {
    it('confidence=0.85 のブロックが両経路で bboxMeta に保持される', async () => {
      const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
      const doc = makeDocument(PAGE_W, PAGE_H, undefined, 0.85);
      const serializedPages = serializePages(doc);

      // main-thread 経路
      const mainBytes = await buildPdfDocument(originalPdf, doc, FONT_BYTES);
      const mainDoc = await PDFDocument.load(mainBytes, { throwOnInvalidObject: false });
      const mainMeta = readPecoToolBBoxMetaFromPdfDoc(mainDoc);

      // Worker 経路
      const { savedBytes: workerBytes } = await __handleSavePdfForTest(
        originalPdf,
        { ...doc, pages: serializedPages },
        FONT_BYTES,
        [],
      );
      const workerDoc = await PDFDocument.load(workerBytes, { throwOnInvalidObject: false });
      const workerMeta = readPecoToolBBoxMetaFromPdfDoc(workerDoc);

      // page 0 のブロック配列を取得して confidence を比較
      const mainBlocks = mainMeta['0'] as Array<{ confidence?: number; text?: string }>;
      const workerBlocks = workerMeta['0'] as Array<{ confidence?: number; text?: string }>;

      expect(Array.isArray(mainBlocks)).toBe(true);
      expect(Array.isArray(workerBlocks)).toBe(true);

      // 両経路とも confidence=0.85 が保存される
      expect(mainBlocks[0].confidence).toBeCloseTo(0.85, 5);
      expect(workerBlocks[0].confidence).toBeCloseTo(0.85, 5);
      expect(workerBlocks[0].confidence).toBeCloseTo(mainBlocks[0].confidence!, 5);
    }, 60_000);
  });

  describe('bboxMeta テキスト内容の等価性', () => {
    it('テキストブロックが両経路で同一の text で bboxMeta に保存される', async () => {
      const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
      const doc = makeDocument(PAGE_W, PAGE_H);
      const serializedPages = serializePages(doc);

      // main-thread 経路
      const mainBytes = await buildPdfDocument(originalPdf, doc, FONT_BYTES);
      const mainDoc = await PDFDocument.load(mainBytes, { throwOnInvalidObject: false });
      const mainMeta = readPecoToolBBoxMetaFromPdfDoc(mainDoc);

      // Worker 経路
      const { savedBytes: workerBytes } = await __handleSavePdfForTest(
        originalPdf,
        { ...doc, pages: serializedPages },
        FONT_BYTES,
        [],
      );
      const workerDoc = await PDFDocument.load(workerBytes, { throwOnInvalidObject: false });
      const workerMeta = readPecoToolBBoxMetaFromPdfDoc(workerDoc);

      const mainBlocks = mainMeta['0'] as Array<{ text?: string }>;
      const workerBlocks = workerMeta['0'] as Array<{ text?: string }>;

      expect(mainBlocks[0].text).toBe('Hello');
      expect(workerBlocks[0].text).toBe('Hello');
    }, 60_000);
  });

  describe('rotation なしページ (既存挙動が壊れていないことの保証)', () => {
    it('rotation 未設定ページは両経路とも /Rotate=0 (変更なし) になる', async () => {
      const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
      const doc = makeDocument(PAGE_W, PAGE_H, undefined); // rotation 未設定
      const serializedPages = serializePages(doc);

      const mainBytes = await buildPdfDocument(originalPdf, doc, FONT_BYTES);
      const mainRotate = await readRotateDegrees(mainBytes);

      const { savedBytes: workerBytes } = await __handleSavePdfForTest(
        originalPdf,
        { ...doc, pages: serializedPages },
        FONT_BYTES,
        [],
      );
      const workerRotate = await readRotateDegrees(workerBytes);

      expect(mainRotate).toBe(0);
      expect(workerRotate).toBe(0);
    }, 60_000);

    it('元の PDF が /Rotate=90 の場合、userRotation 未設定では両経路とも /Rotate=90 を保持する', async () => {
      const originalPdf = await makeRotatedPdf(PAGE_W, PAGE_H, 90); // PDF 自体が R=90
      const doc = makeDocument(PAGE_W, PAGE_H, undefined); // userRotation は未設定
      const serializedPages = serializePages(doc);

      const mainBytes = await buildPdfDocument(originalPdf, doc, FONT_BYTES);
      const mainRotate = await readRotateDegrees(mainBytes);

      const { savedBytes: workerBytes } = await __handleSavePdfForTest(
        originalPdf,
        { ...doc, pages: serializedPages },
        FONT_BYTES,
        [],
      );
      const workerRotate = await readRotateDegrees(workerBytes);

      // userRotation が未設定なので元の /Rotate=90 はそのまま保持される
      expect(mainRotate).toBe(90);
      expect(workerRotate).toBe(90);
      expect(workerRotate).toBe(mainRotate);
    }, 60_000);
  });
});
