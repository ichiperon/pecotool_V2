/**
 * Issue #33: 同一ページで複数フォントを切り替えても Resources の Font 辞書に
 * 同じ font ref が複数の alias 名で重複登録されないことを検証。
 *
 * 修正前は setPageFontWithStableKey() が Map cache 経路と pageLike state 経路を
 * 同じ関数内で混在させており、fallback 経路で pdf-lib 内の setFont() が
 * newFontDictionary を二重に呼んでしまう余地があった。
 *
 * シナリオ:
 *   - primary font (IPAexGothic) のみ含む block A
 *   - fallback font (NotoSans) のみ含む block B
 *   - 再び primary font のみ含む block C
 *   を 1 ページに配置 → 保存後 Resources.Font dict のユニーク ref 数が <= 2 であること
 *   (primary + fallback 各 1 つずつ、合計 2 つ以下)。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFRef } from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeOriginalPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeBlock(id: string, order: number, text: string, yOffset: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 50, y: 100 + yOffset, width: 480, height: 24 },
    writingMode: 'horizontal',
    order,
    isNew: true,
    isDirty: true,
  };
}

function makeMixedFontDoc(): PecoDocument {
  // block A/C: primary でカバーされる ASCII / かな
  // block B: fallback でしかカバーされない記号 (Ⓡ, ☑) を含む
  const blocks: TextBlock[] = [
    makeBlock('a', 0, 'Block A primary', 0),
    makeBlock('b', 1, 'Block B Ⓡ ☑ fallback', 30),
    makeBlock('c', 2, 'Block C primary again', 60),
  ];
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'font-alias.pdf',
    fileName: 'font-alias.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/** ページの Resources.Font dict から (key → font ref string) の Map を抽出 */
function extractPageFontEntries(doc: PDFDocument): Array<{ key: string; ref: string }> {
  const page = doc.getPage(0);
  const resources = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fontDict) return [];
  const entries: Array<{ key: string; ref: string }> = [];
  for (const [key, value] of fontDict.entries()) {
    entries.push({
      key: key.toString(),
      ref: value instanceof PDFRef ? value.toString() : `<inline:${value.constructor.name}>`,
    });
  }
  return entries;
}

describe('Issue #33: per-page font alias dedup', () => {
  it('同一ページで primary ⇄ fallback を切り替えても Resources.Font に同 ref が重複登録されない', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );
    const fallbackFonts = [
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSans-Regular.ttf')),
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSansSymbols-Regular.ttf')),
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSansSymbols2-Regular.ttf')),
    ];

    const original = await makeOriginalPdf();
    const saved = await buildPdfDocument(original, makeMixedFontDoc(), primaryFont, fallbackFonts);

    const doc = await PDFDocument.load(new Uint8Array(saved), { throwOnInvalidObject: false });
    const entries = extractPageFontEntries(doc);

    // 1 つ以上は登録されている (描画されたフォント)
    expect(entries.length).toBeGreaterThan(0);

    // 同じ font ref が複数 key で登録されていない (alias 重複なし)
    const refToKeys = new Map<string, string[]>();
    for (const { key, ref } of entries) {
      const arr = refToKeys.get(ref) ?? [];
      arr.push(key);
      refToKeys.set(ref, arr);
    }
    for (const [ref, keys] of refToKeys) {
      expect(
        keys.length,
        `font ref ${ref} は 1 つの key にしか登録されないはず (実際: ${keys.join(', ')})`,
      ).toBe(1);
    }
  }, 60_000);
});
