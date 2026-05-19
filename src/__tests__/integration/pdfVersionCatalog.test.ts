/**
 * Issue #30: 保存後 PDF の Catalog から /Version キーが完全に消えていることを検証。
 *
 * 背景:
 *   Acrobat 7 は header %PDF-1.6 のみサポート。pdf-lib は書き換え時に Catalog
 *   へ /Version /1.7 を埋め込むことがあり、Acrobat は header と Catalog の最大値
 *   を実効バージョンとして採用するため、header だけ 1.6 に戻しても Acrobat 7 で
 *   開けない (PDF 1.7 だと解釈される)。
 *
 * 修正:
 *   pdfDoc.save() 前に `pdfDoc.catalog.delete(PDFName.of('Version'))` を呼ぶ。
 *   このテストは保存結果の Catalog から /Version 参照が完全に消えていることを確認する。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
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
 * %PDF-1.6 ヘッダ + Catalog /Version /1.7 を強制的に埋め込んだ原本 PDF を作る。
 * 通常の pdf-lib output には自動で Version は入らないため、明示的に set する。
 */
async function makeOriginalWithCatalogVersion(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  // Catalog に /Version /1.7 を埋め込む (Acrobat はこちらを優先する)
  doc.catalog.set(PDFName.of('Version'), PDFName.of('1.7'));
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  // header を %PDF-1.6 に書き換え (pdf-lib は header を直接制御できないため)
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 10));
  if (!head.startsWith('%PDF-1.6')) {
    const patched = new Uint8Array(bytes);
    const enc = new TextEncoder().encode('%PDF-1.6');
    for (let i = 0; i < enc.length; i++) patched[i] = enc[i];
    return patched;
  }
  return bytes;
}

function makeDoc(text: string): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text,
    originalText: text,
    bbox: { x: 50, y: 100, width: 480, height: 24 },
    writingMode: 'horizontal',
    order: 0,
    isNew: true,
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
    filePath: 'version-catalog.pdf',
    fileName: 'version-catalog.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

describe('Issue #30: Catalog /Version removal on save', () => {
  it('原本 Catalog に /Version /1.7 があっても保存後 PDF の Catalog から消える', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );
    const original = await makeOriginalWithCatalogVersion();

    // 原本に Version が含まれることを sanity check
    const originalDoc = await PDFDocument.load(new Uint8Array(original), {
      throwOnInvalidObject: false,
    });
    expect(originalDoc.catalog.get(PDFName.of('Version'))).toBeDefined();

    // 保存
    const saved = await buildPdfDocument(original, makeDoc('Hello issue #30'), primaryFont);

    // 保存後 PDF の Catalog から /Version が消えていること
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false,
    });
    expect(savedDoc.catalog.get(PDFName.of('Version'))).toBeUndefined();

    // header は %PDF-1.6 のまま (restorePdfVersion で復元)
    const head = new TextDecoder('latin1').decode(saved.slice(0, 10));
    expect(head.startsWith('%PDF-1.6')).toBe(true);
  }, 60_000);
});
