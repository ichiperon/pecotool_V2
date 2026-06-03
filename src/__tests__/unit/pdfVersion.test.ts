/**
 * Unit tests for src/utils/pdfVersion.ts
 *
 * U-PH-07: PDF 1.4 の version を正しく取得する
 * U-PH-08: version ヘッダーがない PDF で null を返す
 * Extra: BOM 許容、restorePdfVersion、stripCatalogVersion
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
  extractPdfVersion,
  restorePdfVersion,
  stripCatalogVersion,
} from '../../utils/pdfVersion';

const enc = new TextEncoder();

function makeBytes(header: string, padTo = 64): Uint8Array {
  const headerBytes = enc.encode(header);
  const buf = new Uint8Array(Math.max(headerBytes.length, padTo));
  buf.set(headerBytes);
  return buf;
}

describe('extractPdfVersion', () => {
  it('U-PH-07: %PDF-1.4 ヘッダから "1.4" を返す', () => {
    const bytes = makeBytes('%PDF-1.4\n%rest of pdf...');
    expect(extractPdfVersion(bytes)).toBe('1.4');
  });

  it('U-PH-07b: %PDF-1.7 ヘッダから "1.7" を返す', () => {
    const bytes = makeBytes('%PDF-1.7\nsome content');
    expect(extractPdfVersion(bytes)).toBe('1.7');
  });

  it('U-PH-07c: %PDF-2.0 ヘッダから "2.0" を返す', () => {
    const bytes = makeBytes('%PDF-2.0\n');
    expect(extractPdfVersion(bytes)).toBe('2.0');
  });

  it('U-PH-08: %PDF- がない場合に null を返す', () => {
    const bytes = makeBytes('not a pdf at all');
    expect(extractPdfVersion(bytes)).toBeNull();
  });

  it('U-PH-08b: 空の Uint8Array で null を返す', () => {
    expect(extractPdfVersion(new Uint8Array(0))).toBeNull();
  });

  it('U-PH-08c: ヘッダが途中で切れた不完全バイト列で null を返す', () => {
    const bytes = makeBytes('%PDF');
    expect(extractPdfVersion(bytes)).toBeNull();
  });

  it('BOM (EF BB BF) が先頭にある PDF でも version を取得できる', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = enc.encode('%PDF-1.6\nrest');
    const combined = new Uint8Array(bom.length + body.length + 64);
    combined.set(bom, 0);
    combined.set(body, bom.length);
    expect(extractPdfVersion(combined)).toBe('1.6');
  });

  it('1024 byte 以内に %PDF- がある場合は取得できる', () => {
    // 1000 byte のパディング後に %PDF-1.5
    const padding = new Uint8Array(1000).fill(0x20);
    const header = enc.encode('%PDF-1.5\n');
    const combined = new Uint8Array(padding.length + header.length + 64);
    combined.set(padding, 0);
    combined.set(header, padding.length);
    expect(extractPdfVersion(combined)).toBe('1.5');
  });
});

describe('restorePdfVersion', () => {
  it('保存後の %PDF-1.7 を %PDF-1.4 に書き換える', () => {
    const saved = makeBytes('%PDF-1.7\nrest content here padding', 64);
    restorePdfVersion(saved, '1.4');
    const head = new TextDecoder('latin1').decode(saved.slice(0, 16));
    expect(head.startsWith('%PDF-1.4')).toBe(true);
  });

  it('既に目的バージョンと一致している場合は no-op（バイト変化なし）', () => {
    const saved = makeBytes('%PDF-1.6\nrest', 64);
    const copy = new Uint8Array(saved);
    restorePdfVersion(saved, '1.6');
    expect(saved).toEqual(copy);
  });

  it('%PDF- ヘッダがない場合は crash しない', () => {
    const bytes = makeBytes('not a valid pdf', 64);
    expect(() => restorePdfVersion(bytes, '1.4')).not.toThrow();
  });

  it('空 Uint8Array でも crash しない', () => {
    expect(() => restorePdfVersion(new Uint8Array(0), '1.4')).not.toThrow();
  });

  it('元バージョンより短いバージョン文字列でも crash しない', () => {
    const saved = makeBytes('%PDF-1.10\nrest', 64);
    // 1.10 (5 chars) → 1.4 (3 chars) — patch length < m[0].length → 一部のみ書き換え
    expect(() => restorePdfVersion(saved, '1.4')).not.toThrow();
  });
});

describe('stripCatalogVersion', () => {
  it('originalVersion >= catalogVersion のとき Catalog/Version を削除する', async () => {
    const pdfDoc = await PDFDocument.create();
    // pdf-lib の catalog に /Version /1.7 を埋め込む
    const { PDFName } = await import('@cantoo/pdf-lib');
    pdfDoc.catalog.set(PDFName.of('Version'), PDFName.of('1.7'));

    stripCatalogVersion(pdfDoc, '1.7');

    const remaining = pdfDoc.catalog.lookup(PDFName.of('Version'));
    expect(remaining).toBeUndefined();
  });

  it('originalVersion が null のとき Catalog/Version を触らない', async () => {
    const pdfDoc = await PDFDocument.create();
    const { PDFName } = await import('@cantoo/pdf-lib');
    pdfDoc.catalog.set(PDFName.of('Version'), PDFName.of('1.7'));

    stripCatalogVersion(pdfDoc, null);

    const remaining = pdfDoc.catalog.lookup(PDFName.of('Version'));
    expect(remaining).not.toBeUndefined();
  });

  it('Catalog に /Version がない場合は no-op（crash しない）', async () => {
    const pdfDoc = await PDFDocument.create();
    expect(() => stripCatalogVersion(pdfDoc, '1.6')).not.toThrow();
  });

  it('originalVersion < catalogVersion のとき削除しない（降格防止）', async () => {
    const pdfDoc = await PDFDocument.create();
    const { PDFName } = await import('@cantoo/pdf-lib');
    // Catalog/Version = 1.7, originalVersion = 1.4 → 削除すると降格なので保持
    pdfDoc.catalog.set(PDFName.of('Version'), PDFName.of('1.7'));

    stripCatalogVersion(pdfDoc, '1.4');

    const remaining = pdfDoc.catalog.lookup(PDFName.of('Version'));
    expect(remaining).not.toBeUndefined();
  });
});
