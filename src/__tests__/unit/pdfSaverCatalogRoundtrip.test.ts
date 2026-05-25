/**
 * Unit tests for buildPdfDocument() の Catalog 任意キー round-trip
 *
 * 背景:
 *   Acrobat 7 は Catalog の任意キー (/MarkInfo, /Lang, /OpenAction, /PageLabels,
 *   /ViewerPreferences 等) を「文書同一性」判定に使うことがあり、保存後にこれらが
 *   欠落すると dirty 化 / 機能消失の原因になる。pdf-lib の load → save 経路は通常
 *   これらを保持するが、buildPdfDocument 内の追加処理 (sweepUnreachableObjects /
 *   compactIndirectObjectNumbers / stripCatalogVersion 等) で意図せず落ちる回帰が
 *   起きていないかを ガードする。
 *
 * 各ケースは dirty page 1 件を渡して short-circuit を回避し、Catalog の各キーが
 * 保存後 PDF を再 load した際にも残っていることを検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFBool,
  PDFString,
} from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

function makeDirtyDocState(): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text: 'Hello',
    originalText: '',
    bbox: { x: 10, y: 50, width: 80, height: 12 },
    writingMode: 'horizontal',
    order: 0,
    isNew: true,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 100,
    height: 100,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'in-memory.pdf',
    fileName: 'in-memory.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/**
 * 任意キーを Catalog に設定した最小 PDF を合成する。
 * mutate(doc) で各テストが必要なキーを足す。
 */
async function makePdfWithCatalogKeys(
  mutate: (doc: PDFDocument) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawText('hi', { x: 10, y: 50, size: 12 });
  mutate(doc);
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

async function loadSaved(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(bytes, { throwOnInvalidObject: false });
}

describe('buildPdfDocument / Catalog roundtrip', () => {
  it('/MarkInfo dict が保存後も残る', async () => {
    const input = await makePdfWithCatalogKeys((doc) => {
      const markInfo = doc.context.obj({ Marked: true }) as PDFDict;
      doc.catalog.set(PDFName.of('MarkInfo'), markInfo);
    });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    const markInfo = loaded.catalog.lookup(PDFName.of('MarkInfo'), PDFDict);
    expect(markInfo).toBeInstanceOf(PDFDict);
    const marked = markInfo!.lookup(PDFName.of('Marked'));
    expect(marked).toBeInstanceOf(PDFBool);
    expect((marked as PDFBool).asBoolean()).toBe(true);
  }, 30_000);

  it('/Lang string が保存後も残る', async () => {
    const input = await makePdfWithCatalogKeys((doc) => {
      doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'));
    });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    const lang = loaded.catalog.lookup(PDFName.of('Lang'));
    expect(lang).toBeDefined();
    const decoded = lang instanceof PDFString ? lang.decodeText() : String(lang);
    expect(decoded).toBe('en-US');
  }, 30_000);

  it('/OpenAction array が保存後も残る', async () => {
    const input = await makePdfWithCatalogKeys((doc) => {
      const pageRef = doc.context.getObjectRef(doc.getPage(0).node)!;
      const openAction = doc.context.obj([pageRef, PDFName.of('Fit')]) as PDFArray;
      doc.catalog.set(PDFName.of('OpenAction'), openAction);
    });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    const openAction = loaded.catalog.lookup(PDFName.of('OpenAction'), PDFArray);
    expect(openAction).toBeInstanceOf(PDFArray);
    const entries = openAction!.asArray();
    expect(entries.length).toBe(2);
    // 2 番目の要素は /Fit (PDFName) のはず
    const fit = openAction!.lookup(1);
    expect(fit).toBeInstanceOf(PDFName);
    expect((fit as PDFName).asString()).toBe('/Fit');
  }, 30_000);

  it('/PageLabels dict が保存後も残る (indirect ref 経由でも)', async () => {
    const input = await makePdfWithCatalogKeys((doc) => {
      const numsArray = doc.context.obj([
        0,
        doc.context.obj({ S: PDFName.of('D') }) as PDFDict,
      ]) as PDFArray;
      const pageLabels = doc.context.obj({ Nums: numsArray }) as PDFDict;
      const ref = doc.context.register(pageLabels);
      doc.catalog.set(PDFName.of('PageLabels'), ref);
    });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    const pageLabels = loaded.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
    expect(pageLabels).toBeInstanceOf(PDFDict);
    const nums = pageLabels!.lookup(PDFName.of('Nums'), PDFArray);
    expect(nums).toBeInstanceOf(PDFArray);
    expect(nums!.asArray().length).toBe(2);
  }, 30_000);

  it('/ViewerPreferences dict が保存後も残る', async () => {
    const input = await makePdfWithCatalogKeys((doc) => {
      const prefs = doc.context.obj({ DisplayDocTitle: true }) as PDFDict;
      doc.catalog.set(PDFName.of('ViewerPreferences'), prefs);
    });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    const prefs = loaded.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict);
    expect(prefs).toBeInstanceOf(PDFDict);
    const flag = prefs!.lookup(PDFName.of('DisplayDocTitle'));
    expect(flag).toBeInstanceOf(PDFBool);
    expect((flag as PDFBool).asBoolean()).toBe(true);
  }, 30_000);

  it('元 PDF に無かったキーは保存後 PDF にも追加されない (副作用なし)', async () => {
    const input = await makePdfWithCatalogKeys(() => { /* 何も足さない */ });
    const saved = await buildPdfDocument(input, makeDirtyDocState());
    const loaded = await loadSaved(saved);
    expect(loaded.catalog.get(PDFName.of('MarkInfo'))).toBeUndefined();
    expect(loaded.catalog.get(PDFName.of('Lang'))).toBeUndefined();
    expect(loaded.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
    expect(loaded.catalog.get(PDFName.of('PageLabels'))).toBeUndefined();
    expect(loaded.catalog.get(PDFName.of('ViewerPreferences'))).toBeUndefined();
  }, 30_000);
});
