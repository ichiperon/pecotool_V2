/**
 * Unit tests for src/utils/pdfTrailerId.ts
 *
 * 検証項目:
 *  (A1) extractTrailerId: 通常 PDF / 無 /ID / 複数 trailer / 大文字小文字混在 / 空 / malformed
 *  (A2) overwriteTrailerId: byte-equivalent in-place 置換 / 結果の round-trip 一致 /
 *                           /ID 無し no-op / hex 長 mismatch 時 no-op
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PDFDocument, PDFHexString } from '@cantoo/pdf-lib';
import { extractTrailerId, overwriteTrailerId } from '../../utils/pdfTrailerId';

const enc = new TextEncoder();

/** ASCII 文字列 → Uint8Array (PDF binary surgery 用) */
function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

/**
 * pdf-lib で /ID 付きの最小 PDF を合成する。
 * pdf-lib は trailerInfo.ID が未設定だと /ID を一切出力しないため明示的にセット。
 */
async function makeMinimalPdfWithId(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawText('hi', { x: 10, y: 50, size: 12 });
  doc.context.trailerInfo.ID = doc.context.obj([
    PDFHexString.of('aabbccddeeff00112233445566778899'),
    PDFHexString.of('99887766554433221100ffeeddccbbaa'),
  ]);
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

describe('pdfTrailerId / extractTrailerId', () => {
  it('pdf-lib 由来 PDF の trailer から /ID を hex 抽出できる', async () => {
    const pdf = await makeMinimalPdfWithId();
    const id = extractTrailerId(pdf);
    expect(id).not.toBeNull();
    expect(id!.id0Hex.length).toBeGreaterThan(0);
    expect(id!.id1Hex.length).toBeGreaterThan(0);
    // pdf-lib は MD5 = 16 byte = 32 hex で出力するのが一般的
    expect(id!.id0Hex).toMatch(/^[0-9a-fA-F]+$/);
    expect(id!.id1Hex).toMatch(/^[0-9a-fA-F]+$/);
  });

  it('/ID を含まない PDF は null を返す', () => {
    const fake = bytes(
      '%PDF-1.6\n1 0 obj<<>>endobj\nxref\n0 1\n0000000000 65535 f\ntrailer<</Size 1>>\nstartxref\n9\n%%EOF',
    );
    expect(extractTrailerId(fake)).toBeNull();
  });

  it('複数 trailer (increment update) では最後の /ID を返す', () => {
    const fake = bytes(
      [
        '%PDF-1.6',
        '%dummy',
        'trailer<</Size 5/ID [<11111111111111111111111111111111><22222222222222222222222222222222>]>>',
        'startxref 100',
        '%%EOF',
        'trailer<</Size 6/ID [<aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa><bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb>]>>',
        'startxref 200',
        '%%EOF',
      ].join('\n'),
    );
    const id = extractTrailerId(fake);
    expect(id).not.toBeNull();
    expect(id!.id0Hex.toLowerCase()).toBe('a'.repeat(32));
    expect(id!.id1Hex.toLowerCase()).toBe('b'.repeat(32));
  });

  it('hex の大文字小文字混在を許容する', () => {
    const fake = bytes(
      '%PDF-1.6\ntrailer<</Size 1/ID [<DeadBeef00112233> <CAFEbabe44556677>]>>\nstartxref 10\n%%EOF',
    );
    const id = extractTrailerId(fake);
    expect(id).not.toBeNull();
    expect(id!.id0Hex).toBe('DeadBeef00112233');
    expect(id!.id1Hex).toBe('CAFEbabe44556677');
  });

  it('空 Uint8Array は null', () => {
    expect(extractTrailerId(new Uint8Array(0))).toBeNull();
  });

  it('malformed /ID (1 要素のみ / 不正トークン) は null', () => {
    // 1 要素のみ → 配列形状不一致でマッチしない
    const oneEntry = bytes('trailer<</ID [<deadbeef>]>>');
    expect(extractTrailerId(oneEntry)).toBeNull();
    // 完全に壊れた文字列
    const garbage = bytes('not a pdf at all');
    expect(extractTrailerId(garbage)).toBeNull();
  });

  it('/ID [<> <>] (空 hex × 2) は両 hex が空文字列で返る (現実装の仕様)', () => {
    // 規定: hex 文字数は 0+ なので 空配列は空文字列 hex として match する。
    // overwriteTrailerId 側で長さ照合があるため byte-equivalent の保護は維持される。
    const fake = bytes('trailer<</ID [<> <>]>>\nstartxref 5\n%%EOF');
    const id = extractTrailerId(fake);
    expect(id).not.toBeNull();
    expect(id!.id0Hex).toBe('');
    expect(id!.id1Hex).toBe('');
  });
});

describe('pdfTrailerId / overwriteTrailerId', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('同じ hex 長で書くと byte length は不変 (xref offset 安全)', async () => {
    const pdf = await makeMinimalPdfWithId();
    const original = extractTrailerId(pdf);
    expect(original).not.toBeNull();
    // 同じ長さの hex で上書きする
    const replacement = {
      id0Hex: 'a'.repeat(original!.id0Hex.length),
      id1Hex: 'b'.repeat(original!.id1Hex.length),
    };
    const out = overwriteTrailerId(pdf, replacement);
    expect(out.byteLength).toBe(pdf.byteLength);
  });

  it('上書き後 extractTrailerId が新 ID を返す (round-trip 一致)', async () => {
    const pdf = await makeMinimalPdfWithId();
    const original = extractTrailerId(pdf)!;
    const replacement = {
      id0Hex: '0'.repeat(original.id0Hex.length),
      id1Hex: 'f'.repeat(original.id1Hex.length),
    };
    const out = overwriteTrailerId(pdf, replacement);
    const after = extractTrailerId(out);
    expect(after).not.toBeNull();
    expect(after!.id0Hex.toLowerCase()).toBe(replacement.id0Hex);
    expect(after!.id1Hex.toLowerCase()).toBe(replacement.id1Hex);
  });

  it('/ID を含まない PDF を渡すと bytes はそのまま返る (no-op)', () => {
    const fake = bytes(
      '%PDF-1.6\ntrailer<</Size 1>>\nstartxref 10\n%%EOF',
    );
    const out = overwriteTrailerId(fake, { id0Hex: 'aa', id1Hex: 'bb' });
    expect(out).toBe(fake); // 同一参照を返す実装契約
  });

  it('hex 長 mismatch のケースでは bytes をそのまま返す (xref 破壊回避)', async () => {
    const pdf = await makeMinimalPdfWithId();
    const original = extractTrailerId(pdf)!;
    // 1 文字だけ短い hex を渡す → 長さ不一致
    const shortReplacement = {
      id0Hex: original.id0Hex.slice(0, -2),
      id1Hex: original.id1Hex,
    };
    const out = overwriteTrailerId(pdf, shortReplacement);
    expect(out).toBe(pdf);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('入力 PDF の /ID が変更されていない (out は input bytes と byte 等価 / mismatch 時)', async () => {
    const pdf = await makeMinimalPdfWithId();
    const original = extractTrailerId(pdf)!;
    const out = overwriteTrailerId(pdf, {
      id0Hex: original.id0Hex + 'ff',
      id1Hex: original.id1Hex,
    });
    expect(out.byteLength).toBe(pdf.byteLength);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(pdf))).toBe(0);
  });
});
