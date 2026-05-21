/**
 * Issue #30 / #85: 保存後 PDF の Catalog /Version キーの扱いを検証。
 *
 * 背景:
 *   Acrobat は PDF 1.7 §7.5.2 に従い header の %PDF-x.x と Catalog の /Version の
 *   **最大値** を実効バージョンとして採用する。pdf-lib は書き換え時に Catalog へ
 *   /Version を埋め込むことがあり、header だけ古いバージョンに戻しても Catalog 側が
 *   優先されて古いビューア (Acrobat 7 等) で開けないことがある。
 *
 * 修正 (#30 → #85 で精緻化):
 *   pdfDoc.save() 前に Catalog /Version を削除する。ただし #85 で条件付きに変更:
 *   原本 header (originalVersion) >= Catalog /Version のときだけ削除する。
 *   Catalog の方が高い場合に削除すると実効バージョンが降格してページ内容が壊れる
 *   恐れがあるため、その場合は保持する。
 *
 * 本テストは 2 ケースを検証する:
 *   1. header >= Catalog /Version → 保存後 Catalog から /Version が消える
 *   2. header <  Catalog /Version → #85 ガードにより /Version は保持される
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
 * 指定した header バージョン + Catalog /Version を埋め込んだ原本 PDF を作る。
 * pdf-lib の通常 output には自動で Catalog /Version は入らないため明示的に set する。
 * pdf-lib は header を直接制御できないため、生成後に header を書き換える。
 *
 * @param headerVersion  header の %PDF-x.x に書き込むバージョン文字列 (例 '1.7')
 * @param catalogVersion Catalog /Version に埋め込むバージョン文字列 (例 '1.7')
 */
async function makeOriginalWithCatalogVersion(
  headerVersion: string,
  catalogVersion: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.catalog.set(PDFName.of('Version'), PDFName.of(catalogVersion));
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const wantHeader = `%PDF-${headerVersion}`;
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  if (!head.startsWith(wantHeader)) {
    const patched = new Uint8Array(bytes);
    const enc = new TextEncoder().encode(wantHeader);
    // 既存 header (`%PDF-1.7` など) と同じ長さなので先頭バイトを上書きするだけで良い
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

describe('Issue #30 / #85: Catalog /Version removal on save', () => {
  it('header >= Catalog /Version のとき、保存後 PDF の Catalog から /Version が消える', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );
    // header %PDF-1.7 + Catalog /Version /1.7 → header >= catalog なので削除対象。
    const original = await makeOriginalWithCatalogVersion('1.7', '1.7');

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

    // header は %PDF-1.7 のまま (restorePdfVersion で原本 header を復元)
    const head = new TextDecoder('latin1').decode(saved.slice(0, 16));
    expect(head.startsWith('%PDF-1.7')).toBe(true);
  }, 60_000);

  it('#85: header < Catalog /Version のとき、降格を避けるため /Version は保持される', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );
    // header %PDF-1.6 + Catalog /Version /1.7 → Catalog の方が高い。
    // ここで /Version を削除すると実効バージョンが 1.7 → 1.6 へ降格し、
    // PDF 1.7 機能を使うページ内容が壊れる恐れがあるため #85 で保持に変更された。
    const original = await makeOriginalWithCatalogVersion('1.6', '1.7');

    const originalDoc = await PDFDocument.load(new Uint8Array(original), {
      throwOnInvalidObject: false,
    });
    expect(originalDoc.catalog.get(PDFName.of('Version'))).toBeDefined();

    const saved = await buildPdfDocument(original, makeDoc('Hello issue #85'), primaryFont);

    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false,
    });
    // #85 ガード: header(1.6) < Catalog(1.7) なので /Version は削除されず残る
    expect(savedDoc.catalog.get(PDFName.of('Version'))).toBeDefined();
    expect(savedDoc.catalog.get(PDFName.of('Version'))!.toString()).toBe('/1.7');

    // header は %PDF-1.6 のまま (restorePdfVersion で原本 header を復元)
    const head = new TextDecoder('latin1').decode(saved.slice(0, 16));
    expect(head.startsWith('%PDF-1.6')).toBe(true);
  }, 60_000);
});
