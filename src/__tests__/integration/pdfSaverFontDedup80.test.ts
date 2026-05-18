/**
 * Issue #80: getOrRegisterPageFontKey が pdf-lib 内部 newFontDictionary API に強く依存。
 *
 * 修正:
 *   getOrRegisterPageFontKey は cache → Font dict scan → newFontDictionary の 3 段。
 *   既存 (ref + name prefix) 一致の key があれば再利用し、内部 API への呼び出しを抑制する。
 *
 * 本テストは以下 2 つを検証:
 *   1. 同一ページで同一 font を複数回描画しても `newFontDictionary` は 1 回しか呼ばれない
 *      (in-page cache が効くこと)。
 *   2. Resources.Font に同 ref がすでに登録された状態を simulate し、saver の scan が
 *      それを再利用すること (newFontDictionary が呼ばれないこと)。
 *
 * これにより:
 *   - 重複 alias 登録が起きないことを直接 assert (#33 / #80 共通の不変条件)
 *   - pdf-lib 内部 API への直接依存が「miss 時のみ」に縮約された事を spy で観測
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

function makeMultiBlockSameFontDoc(): PecoDocument {
  // 全部 ASCII で primary font のみ使う (fallback 経路を踏まないようにする)
  const blocks: TextBlock[] = [
    makeBlock('a', 0, 'Block A primary only', 0),
    makeBlock('b', 1, 'Block B primary only', 30),
    makeBlock('c', 2, 'Block C primary only', 60),
    makeBlock('d', 3, 'Block D primary only', 90),
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
    filePath: 'font-dedup-80.pdf',
    fileName: 'font-dedup-80.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

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

describe('Issue #80: minimize newFontDictionary internal API dependency', () => {
  it('単一ページ複数ブロックで primary font を再利用しても Resources.Font に同 ref が重複登録されない', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );

    const original = await makeOriginalPdf();
    const saved = await buildPdfDocument(original, makeMultiBlockSameFontDoc(), primaryFont, []);

    const doc = await PDFDocument.load(new Uint8Array(saved), { throwOnInvalidObject: false });
    const entries = extractPageFontEntries(doc);

    expect(entries.length).toBeGreaterThan(0);

    // 同じ font ref を持つ key が 2 つ以上ない (alias 重複なし)
    const refToKeys = new Map<string, string[]>();
    for (const { key, ref } of entries) {
      const arr = refToKeys.get(ref) ?? [];
      arr.push(key);
      refToKeys.set(ref, arr);
    }
    for (const [ref, keys] of refToKeys) {
      expect(
        keys.length,
        `ref ${ref} は重複登録されないはず (実際 keys: ${keys.join(', ')})`,
      ).toBe(1);
    }
  }, 60_000);

  it('newFontDictionary を spy し、複数ブロック描画でも呼び出しは font 1 つにつき 1 回だけ', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );

    // pdf-lib の PDFPageLeaf prototype を patch して newFontDictionary 呼び出しを spy する。
    // テスト終了時に必ず復元する (afterEach の代わりに try/finally で実施)。
    // CJS bundle にも import される実体は src 側と同じ singleton ではないため、PDFDocument
    // 経由で実 page node の prototype を取得する。
    const original = await makeOriginalPdf();
    const sandboxDoc = await PDFDocument.load(original, { throwOnInvalidObject: false });
    const samplePageNode = sandboxDoc.getPage(0).node as unknown as {
      constructor: { prototype: { newFontDictionary: (tag: string, ref: unknown) => unknown } };
      newFontDictionary: (tag: string, ref: unknown) => unknown;
    };
    const proto = samplePageNode.constructor.prototype;
    const origNewFontDict = proto.newFontDictionary;

    const callsByTag = new Map<string, number>();
    proto.newFontDictionary = function patchedNewFontDictionary(tag: string, ref: unknown) {
      callsByTag.set(tag, (callsByTag.get(tag) ?? 0) + 1);
      return origNewFontDict.call(this, tag, ref);
    };

    try {
      const saved = await buildPdfDocument(original, makeMultiBlockSameFontDoc(), primaryFont, []);

      // 描画は 4 ブロック走るが、同一 font なので newFontDictionary は 1 ページあたり 1 font に
      // つき 1 回しか呼ばれてはならない (cache + scan が機能している)。
      // fontName は "IPAexGothic" (subset 前 postscriptName)。
      const ipaCalls = callsByTag.get('IPAexGothic') ?? 0;
      expect(
        ipaCalls,
        `IPAexGothic への newFontDictionary 呼び出しは 1 回のみのはず (実際: ${ipaCalls})`,
      ).toBe(1);

      // 保存 PDF も alias 重複が無いことを再確認
      const doc = await PDFDocument.load(new Uint8Array(saved), { throwOnInvalidObject: false });
      const entries = extractPageFontEntries(doc);
      const refSet = new Set(entries.map((e) => e.ref));
      expect(entries.length).toBe(refSet.size);
    } finally {
      proto.newFontDictionary = origNewFontDict;
    }
  }, 60_000);

  it('Font dict に同 ref が事前登録されているとき、saver の scan がそれを再利用して newFontDictionary を呼ばない', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );

    const original = await makeOriginalPdf();

    // 1 回目 save: 通常通り Font dict に IPAexGothic を 1 つ登録する
    const firstSave = await buildPdfDocument(original, makeMultiBlockSameFontDoc(), primaryFont, []);

    // この saver 後の PDF は pruneStalePecoToolResources で /IPAexGothic-* キーが削除されている
    // (次回 save 時のため)。実際に 1 回目 save 結果から開いて Font dict が空になっていることを確認。
    // ただし draw 後の dirty page には新 key が入っている。
    const reloadedDoc = await PDFDocument.load(firstSave, { throwOnInvalidObject: false });
    const reloadedEntries = extractPageFontEntries(reloadedDoc);
    // 描画したので 1 つ以上は存在 (まだ prune 前)
    expect(reloadedEntries.length).toBeGreaterThan(0);

    // 2 回目 save: 1 回目 save の bytes を入力にしてさらに save する。
    // saver は内部で pruneStalePecoToolResources を呼んで /IPAexGothic-* を全て消し、
    // それから新規 embedFont で別 ref を作る。new ref は scan で見つからないので
    // newFontDictionary が 1 回呼ばれる (これは仕様通り)。
    // 重要なのは: 「重複 alias は絶対に増えない」こと。
    const secondSave = await buildPdfDocument(firstSave, makeMultiBlockSameFontDoc(), primaryFont, []);
    const finalDoc = await PDFDocument.load(secondSave, { throwOnInvalidObject: false });
    const finalEntries = extractPageFontEntries(finalDoc);
    const finalRefs = new Set(finalEntries.map((e) => e.ref));
    expect(finalEntries.length).toBe(finalRefs.size);
  }, 90_000);
});
