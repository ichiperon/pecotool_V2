/**
 * Regression test for issue #25:
 *   編集していないページにも PecoToolBBoxes メタを再書き込みして原本のメタを破壊する
 *
 * シナリオ:
 *   1. 空 PDF を作成 → block を含む dirty document で 1 回目 savePDF
 *      → PecoToolBBoxes メタを含む PDF が生成される (saved1)
 *   2. saved1 を入力に、全ページ isDirty=false の document を渡して再保存 (saved2)
 *   3. saved1 と saved2 の page 0 の content stream バイト列が完全一致することを検証
 *   4. saved2 の PecoToolBBoxes メタが silent drop していないことを検証
 *
 * 修正前は、existingBBoxMeta のページがすべて pagesToWrite に登録されていたため、
 * 未編集ページに対しても content stream の strip + redraw が走り、フォント
 * subset state や演算子順序の差で content stream バイト列が変動していた。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFDocument,
  PDFArray,
  PDFRawStream,
  PDFName,
  PDFHexString,
  PDFString,
} from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { safeDecodePdfText } from '../../utils/pdfLibSafeDecode';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeEmptyPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeDoc(text: string, isDirty: boolean): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text,
    originalText: text,
    bbox: { x: 50, y: 100, width: 480, height: 24 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [block],
    isDirty,
    thumbnail: null,
  };
  return {
    filePath: 'non-dirty-meta.pdf',
    fileName: 'non-dirty-meta.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/** ページの content stream を decode して返す (FlateDecode のみ対応) */
function decodePage0Contents(doc: PDFDocument): Uint8Array | null {
  const page = doc.getPage(0);
  const contentsKey = PDFName.of('Contents');
  const rawContents = page.node.get(contentsKey) ?? page.node.Contents?.();
  if (!rawContents) return null;
  const resolved = doc.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) return null;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { chunks.push(inflate(raw)); } catch { return null; }
    } else if (!filter) {
      chunks.push(raw);
    } else {
      return null;
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function readMetaCount(doc: PDFDocument): number {
  const infoDict = (doc as unknown as { getInfoDict(): { get: (k: PDFName) => unknown } | undefined }).getInfoDict();
  if (!infoDict) return 0;
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (!(v instanceof PDFHexString) && !(v instanceof PDFString)) return 0;
  try {
    const parsed = JSON.parse(safeDecodePdfText(v)) as Record<string, unknown[]>;
    let count = 0;
    for (const arr of Object.values(parsed)) count += Array.isArray(arr) ? arr.length : 0;
    return count;
  } catch {
    return 0;
  }
}

describe('pdfSaver issue #25: non-dirty page meta preservation', () => {
  it('既存メタ付き PDF を全ページ isDirty=false で再保存しても page0 content stream が完全一致する', async () => {
    const primaryFont = arrayBufferFromFile(
      resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'),
    );

    // 1 回目: dirty=true で保存 → PecoToolBBoxes メタが書かれる
    const empty = await makeEmptyPdf();
    const saved1 = await buildPdfDocument(empty, makeDoc('Hello issue #25', true), primaryFont);

    // saved1 のメタ件数を確認 (1 block 期待)
    const saved1Doc = await PDFDocument.load(new Uint8Array(saved1), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(readMetaCount(saved1Doc)).toBe(1);
    const saved1PageBytes = decodePage0Contents(saved1Doc);
    expect(saved1PageBytes).not.toBeNull();
    expect(saved1PageBytes!.byteLength).toBeGreaterThan(0);

    // 2 回目: 全ページ isDirty=false で再保存
    // 修正前は existingBBoxMeta から pagesToWrite が pre-populate され、
    // 全ページの content stream が re-strip + re-draw されてバイトが変動した。
    // 修正後は dirty が無いので content stream は触られない。
    const saved2 = await buildPdfDocument(
      new Uint8Array(saved1),
      makeDoc('Hello issue #25', false),
      primaryFont,
    );

    const saved2Doc = await PDFDocument.load(new Uint8Array(saved2), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const saved2PageBytes = decodePage0Contents(saved2Doc);
    expect(saved2PageBytes).not.toBeNull();

    // 期待: page 0 content stream バイト列が完全一致
    expect(saved2PageBytes!.byteLength).toBe(saved1PageBytes!.byteLength);
    expect(Buffer.compare(Buffer.from(saved2PageBytes!), Buffer.from(saved1PageBytes!))).toBe(0);

    // メタも silent drop していない
    expect(readMetaCount(saved2Doc)).toBe(1);
  }, 60_000);
});
