/**
 * Unit tests for pdfPecoToolMetadata.ts
 * test gap fill wave 2
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { deflate } from 'pako';
import {
  readPecoToolBBoxMetaFromPdfDoc,
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
});
