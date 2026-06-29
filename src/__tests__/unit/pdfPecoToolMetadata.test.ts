/**
 * Unit tests for pdfPecoToolMetadata.ts
 * test gap fill wave 2
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { deflate } from 'pako';
import {
  readPecoToolBBoxMetaFromPdfDoc,
  readPecoToolBBoxMetaWithStatus,
  readPecoToolBBoxMetaWithStatusFromBytes,
  writePecoToolBBoxMetaToPdfDoc,
  hasLegacyPecoToolBBoxInfo,
  removeLegacyPecoToolBBoxInfo,
} from '../../utils/pdfPecoToolMetadata';

// ── ヘルパー ──────────────────────────────────────────────────────────────

/** deflate 圧縮せずに raw バイト列で stream を作り FlateDecode=true を騙す helper。
 * pdfDoc.context.stream() は Filter を付けないため、テスト内で dict を上書きする。
 */
async function makePdfDocWithInvalidFlateStream(): Promise<PDFDocument> {
  const pdfDoc = await PDFDocument.create();

  const context = pdfDoc.context as unknown as {
    register: (obj: unknown) => unknown;
    stream: (bytes: Uint8Array, dict: Record<string, unknown>) => unknown;
  };
  const catalog = pdfDoc.catalog as unknown as {
    set: (key: PDFName, value: unknown) => void;
    get: (key: PDFName) => unknown;
  };

  // 無効なバイト列 (deflate では絶対デコードできない乱数)
  const invalidBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);

  // stream を作り Filter=/FlateDecode を dict に追加する
  const rawStream = context.stream(invalidBytes, { Subtype: 'BBoxes' }) as {
    dict: { set: (k: PDFName, v: unknown) => void };
  };
  rawStream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  const streamRef = context.register(rawStream);

  const pecoToolDict = (pdfDoc.context as unknown as {
    obj: (d: Record<string, unknown>) => unknown;
  }).obj({ Version: 1, BBoxes: streamRef });

  catalog.set(PDFName.of('PecoTool'), pecoToolDict as never);

  return pdfDoc;
}

/** Filter を配列形式 [/FlateDecode] で持つ FlateDecode stream を作る helper。
 * Acrobat 等の最適化ツールが再保存時に単一 /Filter を配列へ正規化した形を再現する。
 * 本体は実際に deflate 圧縮されている（read 側が inflate できるべき）。
 */
async function makePdfDocWithArrayFilterFlateStream(
  meta: Record<string, unknown>
): Promise<PDFDocument> {
  const pdfDoc = await PDFDocument.create();

  const context = pdfDoc.context as unknown as {
    register: (obj: unknown) => unknown;
    stream: (bytes: Uint8Array, dict: Record<string, unknown>) => unknown;
    obj: (d: unknown) => unknown;
  };
  const catalog = pdfDoc.catalog as unknown as {
    set: (key: PDFName, value: unknown) => void;
  };

  const compressed = deflate(new TextEncoder().encode(JSON.stringify(meta)));
  const rawStream = context.stream(compressed, { Subtype: 'BBoxes' }) as {
    dict: { set: (k: PDFName, v: unknown) => void };
  };
  // 単一名ではなく配列形式の Filter にする（[/FlateDecode]）
  rawStream.dict.set(
    PDFName.of('Filter'),
    context.obj([PDFName.of('FlateDecode')]) as never
  );
  const streamRef = context.register(rawStream);

  const pecoToolDict = context.obj({ Version: 1, BBoxes: streamRef });
  catalog.set(PDFName.of('PecoTool'), pecoToolDict as never);

  return pdfDoc;
}

/** 現在 Catalog/PecoTool/BBoxes が指す PDFRawStream の生バイトを取り出す。
 * 破壊検知用: 書込前後で同一バイトなら既存 stream が温存されたことを意味する。 */
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

// ── テスト ────────────────────────────────────────────────────────────────

describe('pdfPecoToolMetadata — readPecoToolBBoxMetaFromPdfDoc', () => {
  // ── U-PM-01: 新形式 (Catalog/PecoTool/BBoxes stream) write → read RT ──

  it('U-PM-01: writePecoToolBBoxMetaToPdfDoc → readPecoToolBBoxMetaFromPdfDoc round-trip', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const meta = {
      version: 2,
      pages: {
        '0': [{ x: 10, y: 20, w: 100, h: 30, text: 'hello' }],
      },
    };

    writePecoToolBBoxMetaToPdfDoc(pdfDoc, meta);

    const readBack = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(readBack).toEqual(meta);
  });

  // ── U-PM-02: FlateDecode 失敗 → null (空オブジェクト) 返却 ────────────

  it('U-PM-02: FlateDecode stream with invalid bytes → returns empty object {}', async () => {
    const pdfDoc = await makePdfDocWithInvalidFlateStream();

    // FlateDecode が失敗するので readPrivateBBoxMeta → null、
    // legacy fallback も無いので {} を返す
    const result = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(result).toEqual({});
  });

  // ── U-PM-02b (#388 / PCT-158): 配列形式 /Filter [/FlateDecode] でも読める ──

  // 根拠: 外部ツール（Acrobat の最適化等）が再保存時に単一 /Filter を配列形式
  // [/FlateDecode] へ正規化すると、decodeRawStream が inflate せず null を返し、
  // BBox メタが空 {} に落ちて次回保存で全 OCR BBox を上書き消失する（データ損失）。
  it('U-PM-02b: array-form /Filter [/FlateDecode] でも inflate して meta を読める', async () => {
    const meta = {
      version: 2,
      pages: {
        '0': [{ x: 10, y: 20, w: 100, h: 30, text: 'array-filter' }],
      },
    };
    const pdfDoc = await makePdfDocWithArrayFilterFlateStream(meta);

    const readBack = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(readBack).toEqual(meta);
  });

  // ── U-PM-03: legacy /PecoToolBBoxes (Info dict) → 読み取り成功 ────────

  it('U-PM-03: legacy /PecoToolBBoxes in Info dict → read succeeds', async () => {
    const pdfDoc = await PDFDocument.create();

    const legacyMeta = { legacy: true, pages: { '0': [] } };
    const legacyJson = JSON.stringify(legacyMeta);

    // Info dict に PecoToolBBoxes として JSON を入れる (PDFString 相当)
    const context = pdfDoc.context as unknown as {
      obj: (d: Record<string, unknown>) => unknown;
      register: (obj: unknown) => unknown;
      trailerInfo?: Record<string, unknown>;
    };

    // Info dict を作り trailerInfo.Info に登録する
    // pdfDoc.getInfoDict() が返す dict に直接 set する
    const infoDictLike = {
      get(key: PDFName): unknown {
        if (key.asString() === '/PecoToolBBoxes') {
          // PDFString.fromText 相当のモック
          return {
            decodeText: () => legacyJson,
          };
        }
        return undefined;
      },
      delete: (_k: PDFName) => {},
    };

    // pdfDoc に getInfoDict をモックする (ダックタイプ差し込み)
    (pdfDoc as unknown as Record<string, unknown>).getInfoDict = () => infoDictLike;

    const result = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(result).toEqual(legacyMeta);
  });

  // ── U-PM-04: 新形式・legacy 両方なし → {} ────────────────────────────

  it('U-PM-04: no PecoTool meta at all → returns {}', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const result = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(result).toEqual({});
  });

  // ── U-PM-05: write → save → reload → read でメタが保持される ──────────

  it('U-PM-05: write → save bytes → reload from bytes → read meta preserved', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const meta = {
      version: 1,
      pages: {
        '0': [{ x: 0, y: 0, w: 50, h: 20, text: '保存テスト' }],
      },
    };

    writePecoToolBBoxMetaToPdfDoc(pdfDoc, meta);

    const savedBytes = await pdfDoc.save();
    const reloaded = await PDFDocument.load(savedBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });

    const readBack = readPecoToolBBoxMetaFromPdfDoc(reloaded);
    expect(readBack).toEqual(meta);
  });

  // ── U-PM-06: hasLegacyPecoToolBBoxInfo / removeLegacyPecoToolBBoxInfo ─

  it('U-PM-06: hasLegacyPecoToolBBoxInfo returns false when no legacy key', async () => {
    const pdfDoc = await PDFDocument.create();
    expect(hasLegacyPecoToolBBoxInfo(pdfDoc)).toBe(false);
  });

  it('U-PM-07: removeLegacyPecoToolBBoxInfo on doc with no legacy key does not throw', async () => {
    const pdfDoc = await PDFDocument.create();
    expect(() => removeLegacyPecoToolBBoxInfo(pdfDoc)).not.toThrow();
  });

  // ── U-PM-08: write がモック化された粗い context でガードを通過 ──────────

  it('U-PM-08: writePecoToolBBoxMetaToPdfDoc with incomplete context is a no-op (guard)', async () => {
    // context.flateStream が存在しない最低限のモック
    const mockDoc = {
      context: { register: () => {} },
      catalog: {},
      getInfoDict: () => ({ get: () => null, delete: () => {} }),
    } as unknown as import('@cantoo/pdf-lib').PDFDocument;

    expect(() => {
      writePecoToolBBoxMetaToPdfDoc(mockDoc, { test: 'value' });
    }).not.toThrow();
  });

  // ── U-PM-09: Catalog/PecoTool は indirect ref 経由でも読める ─────────

  it('U-PM-09: write then read via context.lookup (indirect ref) works', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const bigMeta: Record<string, unknown> = {};
    // 1000 件近いデータを含む大きな meta
    for (let i = 0; i < 20; i++) {
      bigMeta[`page_${i}`] = Array.from({ length: 10 }, (_, j) => ({
        x: j * 10,
        y: j * 5,
        w: 100,
        h: 20,
        text: `block_${i}_${j}`,
      }));
    }

    writePecoToolBBoxMetaToPdfDoc(pdfDoc, bigMeta);

    const readBack = readPecoToolBBoxMetaFromPdfDoc(pdfDoc);
    expect(Object.keys(readBack).length).toBe(20);
    expect((readBack as Record<string, unknown[]>)['page_0']).toHaveLength(10);
  });

  // ── U-PM-10: writePecoToolBBoxMetaToPdfDoc は legacy key を削除する ──

  it('U-PM-10: write new format removes legacy PecoToolBBoxes from Info dict', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    // legacy mock を差し込む
    let legacyDeleted = false;
    const infoDictMock = {
      get(key: PDFName): unknown {
        if (key.asString() === '/PecoToolBBoxes') {
          return { decodeText: () => '{"old":true}' };
        }
        return undefined;
      },
      delete(_k: PDFName) {
        legacyDeleted = true;
      },
    };
    (pdfDoc as unknown as Record<string, unknown>).getInfoDict = () => infoDictMock;

    writePecoToolBBoxMetaToPdfDoc(pdfDoc, { new: true });

    // removeLegacyPecoToolBBoxInfo が呼ばれて legacy key が削除されている
    expect(legacyDeleted).toBe(true);
  });

  // ── U-PM-11 (#392 / PCT-161): 空メタ書込で decode不能な既存 BBox stream を破壊しない ──
  //
  // 根拠: 既存 PecoTool BBox stream が decode 不能（多重フィルタ・破損 flate 等。#388 が
  // 塞いだのは配列形式 [/FlateDecode] の1ケースのみ）だと readPecoToolBBoxMetaFromPdfDoc が
  // {} を返し（U-PM-02 が実証）、保存時に空 {} で既存 stream を上書きして OCR BBox を
  // 恒久喪失する。安全側ガード: 新メタが空 かつ 既存 stream が present-but-undecodable の
  // ときは上書きしない（読めないだけで実データを含む可能性があり、空で潰さない）。
  it('U-PM-11: 空メタ書込は decode不能な既存 BBox stream を上書きしない（データ損失防止）', async () => {
    const pdfDoc = await makePdfDocWithInvalidFlateStream();
    // 既存 stream は decode 不能 → アプリ上は空に見える（= 救出できなかった状態）
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).toEqual({});
    const before = getPrivateBBoxRawBytes(pdfDoc);
    expect(before).not.toBeNull();

    // 「読めなかった結果として」空メタで保存される状況を再現
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, {});

    // ガード: decode不能な既存 stream は温存され、空 {} で潰されない
    const after = getPrivateBBoxRawBytes(pdfDoc);
    expect(after).not.toBeNull();
    expect(Array.from(after!)).toEqual(Array.from(before!));
  });

  // ── U-PM-12 (#392): 既存が decode可能なら空メタで正常上書き（全削除を尊重） ──
  it('U-PM-12: 既存が decode可能なら空メタ書込で上書きする（ユーザーの全削除は尊重）', async () => {
    const pdfDoc = await makePdfDocWithArrayFilterFlateStream({
      version: 2,
      pages: { '0': [{ x: 1, y: 2, w: 3, h: 4, text: 'real' }] },
    });
    // 既存は読める（アプリもブロックを表示できていた）
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).not.toEqual({});

    // ユーザーが全ブロックを削除 → 空メタ保存 → 上書きされるべき（読めていたので意図的操作）
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, {});
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).toEqual({});
  });

  // ── U-PM-13 (#392): 非空メタは decode不能既存があっても新メタで上書き（現状真実を優先） ──
  it('U-PM-13: 非空メタ書込は decode不能な既存があっても新メタで上書きする', async () => {
    const pdfDoc = await makePdfDocWithInvalidFlateStream();
    const newMeta = { version: 2, pages: { '0': [{ x: 5, y: 6, w: 7, h: 8, text: 'new' }] } };
    writePecoToolBBoxMetaToPdfDoc(pdfDoc, newMeta);
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).toEqual(newMeta);
  });

  // ── U-PM-14 (#392): decode可能な空 {} stream は status='ok'（undecodable と誤判定しない） ──
  // false-positive ガード: decode 成功した空メタは preserve 対象でなく、通常どおり上書きできる。
  it("U-PM-14: decode可能な空 '{}' stream は status='ok'（preserve 誤発火しない）", async () => {
    const pdfDoc = await makePdfDocWithArrayFilterFlateStream({});
    const read = readPecoToolBBoxMetaWithStatus(pdfDoc);
    expect(read.status).toBe('ok');
    expect(read.meta).toEqual({});
  });

  // ── U-PM-15 (#392): undecodable private + 読める legacy は status='ok' で legacy を返す ──
  // 旧 readPecoToolBBoxMetaFromPdfDoc の `private ?? legacy ?? {}` フォールバックを温存する回帰。
  it("U-PM-15: undecodable private + 読める legacy → status='ok' で legacy を返す", async () => {
    const pdfDoc = await makePdfDocWithInvalidFlateStream(); // private は decode 不能
    const legacyMeta = { legacy: true, pages: { '0': [] } };
    (pdfDoc as unknown as Record<string, unknown>).getInfoDict = () => ({
      get(key: PDFName): unknown {
        return key.asString() === '/PecoToolBBoxes'
          ? { decodeText: () => JSON.stringify(legacyMeta) }
          : undefined;
      },
      delete: (_k: PDFName) => {},
    });
    const read = readPecoToolBBoxMetaWithStatus(pdfDoc);
    expect(read.status).toBe('ok');
    expect(read.meta).toEqual(legacyMeta);
    expect(readPecoToolBBoxMetaFromPdfDoc(pdfDoc)).toEqual(legacyMeta);
  });

  // ── U-PM-16 (#392): bytes 経路と pdfDoc 経路の undecodable 判定が一致する ──
  // load 検出は readPecoToolBBoxMetaWithStatusFromBytes(bytes)、save の byte-preserve は
  // readPecoToolBBoxMetaWithStatus(pdfDoc) を使う。両者が食い違うと「save は preserve するが
  // 警告フラグは立たない＝無警告 silent drop」になるため、同一内容で判定一致を固定する（御局指摘）。
  it('U-PM-16: bytes 経路（load）と pdfDoc 経路（save）の undecodable 判定が一致する', async () => {
    const pdfDoc = await makePdfDocWithInvalidFlateStream();
    // save パス相当（loaded pdfDoc から直接）
    expect(readPecoToolBBoxMetaWithStatus(pdfDoc).status).toBe('undecodable');
    // load パス相当（同一内容の bytes から）
    const bytes = await pdfDoc.save({ useObjectStreams: false });
    const fromBytes = await readPecoToolBBoxMetaWithStatusFromBytes(bytes);
    expect(fromBytes.status).toBe('undecodable');
  });
});
