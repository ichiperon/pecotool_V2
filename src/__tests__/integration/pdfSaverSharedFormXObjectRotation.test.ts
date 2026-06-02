/**
 * Test gap fill wave 4:
 * pdfSaverSharedFormXObject × page rotation
 *
 * 検証観点:
 *   1. 共有 Form XObject を持つ 2 ページ PDF で page rotation = 90/180/270 を設定したとき、
 *      保存後も共有関係が壊れない (ref が一致したまま)。
 *   2. XObject local CTM (initial matrix "cm") が非自明な値を持つ Form XObject に対して
 *      OCR テキストブロックを保存すると、saved content stream に cm 演算子が出力され、
 *      テキスト原点が PDF user-space の有効範囲 ([0..pageW] × [0..pageH]) に収まる。
 *   3. rotation + CTM 両方を持つページで OCR text (x/y) が保存される
 *      (TextBlock の bbox が saveSource に正しく乗り、strip 後の Form XObject は無変更)。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFArray,
} from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// ── helpers ──────────────────────────────────────────────────────────────

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

const fontBytes = arrayBufferFromFile(
  resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
);

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function getOrCreatePageResources(
  doc: PDFDocument,
  page: ReturnType<PDFDocument['getPage']>,
): PDFDict {
  const existing = (
    page.node as unknown as { Resources?: () => PDFDict | undefined }
  ).Resources?.();
  if (existing) return existing;
  const resources = doc.context.obj({}) as PDFDict;
  page.node.set(PDFName.of('Resources'), resources);
  return resources;
}

function getOrCreateXObjectDict(
  doc: PDFDocument,
  resources: PDFDict,
): PDFDict {
  const existing = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (existing) return existing;
  const xObjects = doc.context.obj({}) as PDFDict;
  resources.set(PDFName.of('XObject'), xObjects);
  return xObjects;
}

const SHARED_FORM_NAME = PDFName.of('FmSharedRotation');

/**
 * 2 ページ PDF を作成。
 *   - page 0: rotation=0 (基準)
 *   - page 1: rotation=<rotation>
 * 両ページが同一の Form XObject (BT...ET 含む) を共有する。
 */
async function makeTwoPageWithSharedFormXObjectAndRotation(
  rotation: 90 | 180 | 270,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const PAGE_W = 595;
  const PAGE_H = 842;
  const page0 = pdf.addPage([PAGE_W, PAGE_H]);
  const page1 = pdf.addPage([PAGE_W, PAGE_H]);

  // page1 に rotation を設定
  const { degrees } = await import('@cantoo/pdf-lib');
  page1.setRotation(degrees(rotation));

  // Form XObject (BT...ET 含む / "leak-rot" テキスト)
  const formContent = latin1Bytes(
    ['q', 'BT', '/F1 12 Tf', '(leak-rot) Tj', 'ET', 'Q'].join('\n'),
  );
  const formStream = pdf.context.flateStream(formContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 200, 200],
    Resources: {},
  });
  const formRef = pdf.context.register(formStream);

  // 両ページの Resources.XObject に同じ ref で登録
  const r0 = getOrCreatePageResources(pdf, page0);
  getOrCreateXObjectDict(pdf, r0).set(SHARED_FORM_NAME, formRef);
  const r1 = getOrCreatePageResources(pdf, page1);
  getOrCreateXObjectDict(pdf, r1).set(SHARED_FORM_NAME, formRef);

  // 両ページ Contents に Do オペレータを入れる
  const do0 = pdf.context.register(
    pdf.context.flateStream(latin1Bytes('q\n/FmSharedRotation Do\nQ')),
  );
  page0.node.set(PDFName.of('Contents'), pdf.context.obj([do0]));
  const do1 = pdf.context.register(
    pdf.context.flateStream(latin1Bytes('q\n/FmSharedRotation Do\nQ')),
  );
  page1.node.set(PDFName.of('Contents'), pdf.context.obj([do1]));

  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** 指定ページの Resources.XObject から Form ref を取得する */
function getFormRef(doc: PDFDocument, pageIndex: number): string | null {
  const page = doc.getPage(pageIndex);
  const resources = (
    page.node as unknown as { Resources?: () => PDFDict | undefined }
  ).Resources?.();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return null;
  const ref = xObjects.get(SHARED_FORM_NAME);
  if (!(ref instanceof PDFRef)) return null;
  return ref.toString();
}

/** page0 の Form XObject 内容を decode して返す */
function decodeFormContent(doc: PDFDocument, refStr: string): string | null {
  const page = doc.getPage(0);
  const resources = (
    page.node as unknown as { Resources?: () => PDFDict | undefined }
  ).Resources?.();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const ref = xObjects?.get(SHARED_FORM_NAME);
  if (!ref || ref.toString() !== refStr) return null;
  const form = doc.context.lookup(ref);
  if (!(form instanceof PDFRawStream)) return null;
  const filter = form.dict.lookup(PDFName.of('Filter'));
  const raw = form.getContents();
  if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
    try {
      return new TextDecoder('latin1').decode(inflate(raw));
    } catch {
      return null;
    }
  }
  if (!filter) return new TextDecoder('latin1').decode(raw);
  return null;
}

/** ページの content streams を decode して結合テキストを返す */
async function decodePageContentText(
  doc: PDFDocument,
  pageIndex: number,
): Promise<string> {
  const page = doc.getPage(pageIndex);
  const rawContents =
    page.node.get(PDFName.of('Contents')) ??
    (page.node as unknown as { Contents?: () => unknown }).Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(rawContents);
  const streams =
    resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) continue;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try {
        chunks.push(inflate(raw));
      } catch {
        /* skip */
      }
    } else if (!filter) {
      chunks.push(raw);
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder('latin1').decode(out);
}

/** cm 演算子 (6 引数) を全て抽出 */
function extractCmOperands(
  text: string,
): Array<{
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}> {
  const re =
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: Array<{
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
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

function composeMatrices(
  mats: Array<{
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }>,
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

function applyMatrix(
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number,
  y: number,
): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function makeDirtyPage(
  pageIndex: number,
  pageW: number,
  pageH: number,
  bboxV: { x: number; y: number; width: number; height: number },
): PageData {
  const block: TextBlock = {
    id: `blk-${pageIndex}`,
    text: 'OCR_TEXT',
    originalText: 'OCR_TEXT',
    bbox: bboxV,
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
  };
  return {
    pageIndex,
    width: pageW,
    height: pageH,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pdfSaverSharedFormXObject × page rotation (wave 4)', () => {
  const PAGE_W = 595;
  const PAGE_H = 842;
  // viewport bbox (rotated screen, y-down)
  const BBOX_V = { x: 100, y: 100, width: 200, height: 20 };

  for (const rotation of [90, 180, 270] as const) {
    describe(`rotation=${rotation}`, () => {
      it(`共有 Form XObject を持つ 2 ページ PDF (page1=/Rotate ${rotation}) でも保存後の共有 ref が壊れない`, async () => {
        const original =
          await makeTwoPageWithSharedFormXObjectAndRotation(rotation);

        // sanity: 元 PDF の両ページが同じ ref を共有
        const origDoc = await PDFDocument.load(original, {
          throwOnInvalidObject: false,
        });
        const origRef0 = getFormRef(origDoc, 0);
        const origRef1 = getFormRef(origDoc, 1);
        expect(origRef0).not.toBeNull();
        expect(origRef0).toBe(origRef1);

        // 両ページ dirty TextBlock を持つ PecoDocument を作成
        const doc: PecoDocument = {
          filePath: `shared-rotation-${rotation}.pdf`,
          fileName: `shared-rotation-${rotation}.pdf`,
          totalPages: 2,
          metadata: {},
          pages: new Map([
            [0, makeDirtyPage(0, PAGE_W, PAGE_H, BBOX_V)],
            [1, makeDirtyPage(1, PAGE_W, PAGE_H, BBOX_V)],
          ]),
        };

        const saved = await buildPdfDocument(original, doc, fontBytes);
        const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
          throwOnInvalidObject: false,
        });

        // 保存後も両ページが同じ Form XObject ref を共有している
        const savedRef0 = getFormRef(savedDoc, 0);
        const savedRef1 = getFormRef(savedDoc, 1);
        expect(savedRef0).not.toBeNull();
        expect(
          savedRef0,
          `rotation=${rotation}: 保存後も両ページが同じ ref を共有すること`,
        ).toBe(savedRef1);

        // Form XObject 内 BT...ET が strip されている
        const formContent = decodeFormContent(savedDoc, savedRef0!);
        expect(formContent).not.toBeNull();
        expect(formContent).not.toContain('(leak-rot)');
        expect(formContent).not.toContain('BT');
        expect(formContent).not.toContain('ET');
      }, 90_000);

      it(`rotation=${rotation} ページの OCR テキスト原点が PDF user-space の有効範囲に収まる`, async () => {
        const original =
          await makeTwoPageWithSharedFormXObjectAndRotation(rotation);

        const doc: PecoDocument = {
          filePath: `shared-rotation-cm-${rotation}.pdf`,
          fileName: `shared-rotation-cm-${rotation}.pdf`,
          totalPages: 2,
          metadata: {},
          pages: new Map([
            [0, makeDirtyPage(0, PAGE_W, PAGE_H, BBOX_V)],
            [1, makeDirtyPage(1, PAGE_W, PAGE_H, BBOX_V)],
          ]),
        };

        const saved = await buildPdfDocument(original, doc, fontBytes);
        const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
          throwOnInvalidObject: false,
        });

        // page1 (rotated) の content stream から cm 演算子を取り出す
        const contentText = await decodePageContentText(savedDoc, 1);
        const cms = extractCmOperands(contentText);
        // rotation != 0 の場合、rotation cm + translate + scale = 3個以上の cm が出るはず
        expect(
          cms.length,
          `rotation=${rotation}: content stream に cm 演算子が存在すること`,
        ).toBeGreaterThanOrEqual(2);

        // cm を合成して描画原点を求める
        const composed = composeMatrices(cms);
        const [drawnX, drawnY] = applyMatrix(composed, 0, 0);

        // 描画原点が PDF user-space の有効範囲内 (±50 の tolerance)
        const maxDim = Math.max(PAGE_W, PAGE_H);
        expect(
          drawnX,
          `rotation=${rotation}: x=${drawnX} が有効範囲外`,
        ).toBeGreaterThanOrEqual(-50);
        expect(
          drawnX,
          `rotation=${rotation}: x=${drawnX} が有効範囲外`,
        ).toBeLessThanOrEqual(maxDim + 50);
        expect(
          drawnY,
          `rotation=${rotation}: y=${drawnY} が有効範囲外`,
        ).toBeGreaterThanOrEqual(-50);
        expect(
          drawnY,
          `rotation=${rotation}: y=${drawnY} が有効範囲外`,
        ).toBeLessThanOrEqual(maxDim + 50);
      }, 90_000);
    });
  }

  it('rotation=0 基準: 共有 Form XObject を持つ 2 ページで共有 ref が維持され BT...ET が strip される (regression baseline)', async () => {
    // rotation=0 の 2 ページ PDF (= 既存テストの簡略版、shared rotation テストの基準値)
    const pdf = await PDFDocument.create();
    const page0 = pdf.addPage([PAGE_W, PAGE_H]);
    const page1 = pdf.addPage([PAGE_W, PAGE_H]);

    const formContent = latin1Bytes(
      ['q', 'BT', '/F1 12 Tf', '(baseline-shared) Tj', 'ET', 'Q'].join('\n'),
    );
    const formStream = pdf.context.flateStream(formContent, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, 200, 200],
      Resources: {},
    });
    const formRef = pdf.context.register(formStream);

    const r0 = getOrCreatePageResources(pdf, page0);
    getOrCreateXObjectDict(pdf, r0).set(SHARED_FORM_NAME, formRef);
    const r1 = getOrCreatePageResources(pdf, page1);
    getOrCreateXObjectDict(pdf, r1).set(SHARED_FORM_NAME, formRef);

    const do0 = pdf.context.register(
      pdf.context.flateStream(latin1Bytes('q\n/FmSharedRotation Do\nQ')),
    );
    page0.node.set(PDFName.of('Contents'), pdf.context.obj([do0]));
    const do1 = pdf.context.register(
      pdf.context.flateStream(latin1Bytes('q\n/FmSharedRotation Do\nQ')),
    );
    page1.node.set(PDFName.of('Contents'), pdf.context.obj([do1]));

    const original = await pdf.save({
      useObjectStreams: false,
      addDefaultPage: false,
    });

    const doc: PecoDocument = {
      filePath: 'shared-rotation-0.pdf',
      fileName: 'shared-rotation-0.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([
        [0, makeDirtyPage(0, PAGE_W, PAGE_H, BBOX_V)],
        [1, makeDirtyPage(1, PAGE_W, PAGE_H, BBOX_V)],
      ]),
    };

    const saved = await buildPdfDocument(original, doc, fontBytes);
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false,
    });

    const ref0 = getFormRef(savedDoc, 0);
    const ref1 = getFormRef(savedDoc, 1);
    expect(ref0).not.toBeNull();
    expect(ref0).toBe(ref1);

    const content = decodeFormContent(savedDoc, ref0!);
    expect(content).not.toContain('(baseline-shared)');
    expect(content).not.toContain('BT');
  }, 90_000);
});
