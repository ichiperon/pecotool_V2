/**
 * #392 / PCT-161: decode 不能な既存 PecoTool BBox stream は、編集保存（非空 partial メタ）でも
 * 破壊的に上書きされず温存される、という回帰を固定する。
 *
 * 背景（御局レビューで判明した主経路）:
 *   既存 PecoTool BBox stream が本バージョンで decode 不能（多重フィルタ・破損 flate 等。
 *   #388 が塞いだのは配列 [/FlateDecode] の1ケースのみ）だと readPecoToolBBoxMetaFromPdfDoc が
 *   {} を返す。ユーザーが1ページだけ編集すると bboxMeta は非空 partial（編集ページのみ）になり、
 *   write の空メタガード（Object.keys===0）を素通りして既存 stream を上書き → 読めなかった
 *   他ページの OCR BBox を silent 喪失する。
 *
 * 対応（read 境界 first-class + preserve flag）:
 *   readPecoToolBBoxMetaWithStatus が 'undecodable' を 'empty' と区別し、pdfSaverCore は
 *   status==='undecodable' のとき preserveExistingPrivateStream として破壊的上書きを行わない
 *   （既存 stream を据え置く）。新規編集は保存に反映されないが、それは UI 警告で透明化する。
 *
 * テスト構成:
 *   入力 PDF に「多重フィルタ [/FlateDecode /FlateDecode]」の BBox stream を仕込む（バイトは
 *   単一 deflate の正規データだが、本バージョンは多重チェーンを未対応＝decode 不能と扱う）。
 *   この PDF に編集ブロックを1件足して保存し、保存後の PecoTool BBox stream の生バイトが
 *   入力時と同一（温存）であることを assert する。旧コードは編集ページのメタで上書きするため赤。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { deflate } from 'pako';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn(),
  openPDF: vi.fn(),
  openFreshPdfDoc: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(),
  getAllTemporaryPageData: vi.fn(),
  clearTemporaryChanges: vi.fn(),
  clearTemporaryChangesForPages: vi.fn(),
  deleteTemporaryPageKeys: vi.fn(),
  clearCachedPages: vi.fn(),
}));

import { buildPdfDocument } from '../../utils/pdfSaver';
import {
  readPecoToolBBoxMetaWithStatus,
  readPecoToolBBoxMetaFromPdfDoc,
} from '../../utils/pdfPecoToolMetadata';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
} from './helpers/goldenCorpus';
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types';

const PAGE_W = 595;
const PAGE_H = 842;

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

/** 入力 PDF に「多重フィルタ [/FlateDecode /FlateDecode]」の PecoTool BBox stream を仕込む。
 * バイトは実 OCR メタを1回 deflate した正規データだが、本バージョンの decodeRawStream は
 * 多重チェーンを未対応として null を返す＝undecodable。返り値に生バイトも返す（温存検証用）。 */
async function makeInputWithUndecodableStream(): Promise<{ bytes: Uint8Array; rawContents: Uint8Array }> {
  const pdf = await PDFDocument.create();
  pdf.addPage([PAGE_W, PAGE_H]);
  const ctx = pdf.context as unknown as {
    register: (obj: unknown) => unknown;
    stream: (bytes: Uint8Array, dict: Record<string, unknown>) => { dict: { set: (k: PDFName, v: unknown) => void } };
    obj: (d: unknown) => unknown;
  };
  const catalog = pdf.catalog as unknown as { set: (k: PDFName, v: unknown) => void };

  // 読めれば pages 0/1 の OCR を含む「実データ」（= 喪失したら困るもの）
  const realMeta = JSON.stringify({
    '0': [{ x: 10, y: 20, w: 100, h: 30, text: '不能ページ0の実OCR' }],
    '1': [{ x: 40, y: 50, w: 120, h: 24, text: '不能ページ1の実OCR' }],
  });
  const compressed = deflate(new TextEncoder().encode(realMeta));

  const rawStream = ctx.stream(compressed, { Subtype: 'BBoxes' });
  // 多重フィルタチェーン（本バージョン未対応 → decode 不能）
  rawStream.dict.set(
    PDFName.of('Filter'),
    ctx.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')]) as never,
  );
  const streamRef = ctx.register(rawStream);
  catalog.set(PDFName.of('PecoTool'), ctx.obj({ Version: 1, BBoxes: streamRef }) as never);

  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  return { bytes, rawContents: compressed };
}

/** 現在 Catalog/PecoTool/BBoxes が指す PDFRawStream の生バイトを取り出す。 */
function getPrivateBBoxRawBytes(pdfDoc: PDFDocument): Uint8Array | null {
  const catalog = pdfDoc.catalog as unknown as { get: (k: PDFName) => unknown };
  const pecoToolValue = catalog.get(PDFName.of('PecoTool'));
  if (!pecoToolValue) return null;
  const ctx = pdfDoc.context as unknown as { lookup: (v: unknown) => unknown };
  const dict = ctx.lookup(pecoToolValue) as { get?: (k: PDFName) => unknown } | undefined;
  const bboxesValue = dict?.get?.(PDFName.of('BBoxes'));
  if (!bboxesValue) return null;
  const stream = ctx.lookup(bboxesValue);
  return stream instanceof PDFRawStream ? stream.getContents() : null;
}

/** 編集ブロックを1件持つ PecoDocument（保存時に metaChanged=true → write 発火） */
function makeEditedDoc(): PecoDocument {
  const block: TextBlock = {
    id: 'p0-edit',
    text: 'ユーザーが追加/編集した1ブロック',
    originalText: 'ユーザーが追加/編集した1ブロック',
    bbox: { x: 50, y: 60, width: 150, height: 22 },
    writingMode: 'horizontal' as WritingMode,
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: PAGE_W,
    height: PAGE_H,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
    isTextExtracted: true,
  };
  return {
    filePath: 'undecodable.pdf',
    fileName: 'undecodable.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map<number, PageData>([[0, page]]),
  };
}

describe('#392: decode不能な既存BBox stream の保存時温存', () => {
  it('入力の BBox stream は本バージョンで undecodable と判定される（前提）', async () => {
    const { bytes } = await makeInputWithUndecodableStream();
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const read = readPecoToolBBoxMetaWithStatus(pdfDoc);
    expect(read.status).toBe('undecodable');
    expect(read.meta).toEqual({});
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).toEqual({});
  });

  it('編集保存は完全 byte-preserve（meta も content も無改変・原本バイトと同一）', async () => {
    const { bytes, rawContents } = await makeInputWithUndecodableStream();
    const doc = makeEditedDoc();

    const saved = await buildPdfDocument(bytes, doc, fontBytes);

    // 完全 byte-preserve: meta だけ温存して content を再描画する「半端」を排除し、
    // 保存バイト全体が原本と同一であること（= meta/content 乖離が構造的に起きない）を固定する。
    // （御局レビュー: preserve が meta write のみをゲートすると dirty ページの content 再描画で
    //  旧 OCR レンダ層が strip され meta と乖離する。原本バイトをそのまま返すことで根絶する。）
    expect(saved.byteLength).toBe(bytes.byteLength);
    expect(Array.from(saved)).toEqual(Array.from(bytes));

    const reloaded = await PDFDocument.load(saved, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    // 既存 stream は依然 undecodable のまま温存（編集ページの partial メタで潰されない）
    expect(readPecoToolBBoxMetaWithStatus(reloaded).status).toBe('undecodable');
    const after = getPrivateBBoxRawBytes(reloaded);
    expect(after).not.toBeNull();
    expect(Array.from(after!)).toEqual(Array.from(rawContents));
  }, 30_000);

  it('decode可能な通常 PDF は preserve が誤発火せず編集が保存に反映される（過剰温存なし）', async () => {
    // 既存メタが読める（status='ok'）通常 PDF を編集保存 → 原本据置でなく新メタが書かれる。
    // preserve が undecodable 以外で誤発火しないことの回帰（いろは指摘の false-positive ガード）。
    const pdf = await PDFDocument.create();
    pdf.addPage([PAGE_W, PAGE_H]);
    const input = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
    const doc = makeEditedDoc();

    const saved = await buildPdfDocument(input, doc, fontBytes);

    const reloaded = await PDFDocument.load(saved, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const read = readPecoToolBBoxMetaWithStatus(reloaded);
    expect(read.status).toBe('ok');
    // 編集ブロックがメタに反映されている（preserve で据え置かれていない）
    expect(Object.keys(read.meta).length).toBeGreaterThan(0);
  }, 30_000);
});
