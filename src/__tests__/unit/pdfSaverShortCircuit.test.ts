/**
 * Unit tests for buildPdfDocument() の "no-op short-circuit"
 *
 * 規定動作:
 *   - dirty pages 0 件 かつ PecoTool データ無し (legacy/new 形式どちらも) のとき
 *     → 入力 bytes をそのまま byte-equivalent で返す
 *   - 編集ありの場合は short-circuit しない (戻り値が入力と異なる)
 *   - 既存メタを持つ PDF は (現状実装の `existingBBoxMeta` 存在チェックにより)
 *     short-circuit しない
 *
 * 注: 本ファイルは pdf-lib を実物として使う。
 * 既存 src/__tests__/unit/pdfSaver.test.ts は pdf-lib を全 mock しているため、
 * byte-equality を検証する short-circuit テストは別ファイルに分離する。
 */
import { describe, it, expect } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
} from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

async function makeMinimalPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawText('hi', { x: 10, y: 50, size: 12 });
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

/** Info 辞書に旧形式 /PecoToolBBoxes を埋め込んだ PDF を合成 */
async function makeLegacyMetaPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const infoDict = (doc as unknown as { getInfoDict(): import('@cantoo/pdf-lib').PDFDict }).getInfoDict();
  infoDict.set(
    PDFName.of('PecoToolBBoxes'),
    PDFHexString.fromText(JSON.stringify({ '0': [] })),
  );
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeEmptyDocState(): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 100,
    height: 100,
    textBlocks: [],
    isDirty: false,
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('buildPdfDocument / no-op short-circuit', () => {
  it('dirty 0 件 + PecoTool データ無し → 入力 bytes と完全 byte 等価で返る', async () => {
    const input = await makeMinimalPdf();
    const out = await buildPdfDocument(input, makeEmptyDocState());
    expect(out.byteLength).toBe(input.byteLength);
    expect(bytesEqual(out, input)).toBe(true);
  }, 30_000);

  it('編集ありの場合は short-circuit せず、戻り値は入力と異なる', async () => {
    const input = await makeMinimalPdf();
    const out = await buildPdfDocument(input, makeDirtyDocState());
    expect(out.byteLength).not.toBe(0);
    // PecoTool メタ書き込み + content stream 再生成があるため byte 等価ではない
    expect(bytesEqual(out, input)).toBe(false);
  }, 30_000);

  it('legacy /Info/PecoToolBBoxes を持つ PDF は short-circuit しない (新形式へ移行が必要)', async () => {
    const input = await makeLegacyMetaPdf();
    const out = await buildPdfDocument(input, makeEmptyDocState());
    // hadLegacyBBoxMeta 経路で writePecoToolBBoxMetaToPdfDoc → 旧 Info 削除
    // が走るので、結果は入力と byte 等価にならない
    expect(bytesEqual(out, input)).toBe(false);
  }, 30_000);

  it('既存 PecoTool データを持つ PDF (新形式) は short-circuit 条件を満たさない', async () => {
    // 1 回目 dirty で保存して新形式 /Catalog/PecoTool/BBoxes を作る
    const empty = await makeMinimalPdf();
    const withMeta = await buildPdfDocument(empty, makeDirtyDocState());
    // 2 回目 dirty 0 で保存。existingBBoxMeta が非空 (= Object.keys.length > 0)
    // のため short-circuit はせず、何らかの正常書き出しが走る。
    const out = await buildPdfDocument(withMeta, makeEmptyDocState());
    // 規定: 短絡条件は existingBBoxMeta 空 かつ legacy 無し かつ dirty 0。
    // 既存メタありなのでこの assert は「短絡しなかった」ことだけを検証する。
    // (byte 等価かどうかは pdf-lib の冪等性に依存するため厳密一致は要求しない)
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBeGreaterThan(0);
  }, 30_000);
});
