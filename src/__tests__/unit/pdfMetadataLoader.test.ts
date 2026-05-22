/**
 * S-10 (追加): pdfMetadataLoader の JSON.parse narrow を検証する。
 * - PDF メタデータに偽装した不正 JSON を食わせ、reject されることを確認。
 * - prototype 汚染攻撃 / bbox の非有限値などが弾かれること。
 * - #36: custom.PecoToolBBoxes が空/非文字列でも info.PecoToolBBoxes に fallback される
 */
import { describe, it, expect } from 'vitest';
import { loadPecoToolBBoxMeta } from '../../utils/pdfMetadataLoader';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
} from '@cantoo/pdf-lib';
import { writePecoToolBBoxMetaToPdfDoc } from '../../utils/pdfPecoToolMetadata';

/** PDFDocumentProxy.getMetadata() を最小限スタブ化する */
function makeFakePdf(rawMeta: string | null) {
  return {
    getMetadata: async () => ({
      info: rawMeta === null ? {} : { PecoToolBBoxes: rawMeta },
      metadata: null,
      contentDispositionFilename: null,
      contentLength: null,
    }),
  } as any;
}

/** custom / info の両方を独立に指定するスタブ */
function makeFakePdfWithCustom(opts: {
  customRaw?: unknown;
  infoRaw?: unknown;
}) {
  const info: Record<string, unknown> = {};
  if (opts.customRaw !== undefined) {
    info.Custom = { PecoToolBBoxes: opts.customRaw };
  }
  if (opts.infoRaw !== undefined) {
    info.PecoToolBBoxes = opts.infoRaw;
  }
  return {
    getMetadata: async () => ({
      info,
      metadata: null,
      contentDispositionFilename: null,
      contentLength: null,
    }),
  } as any;
}

const validEntry = {
  bbox: { x: 10, y: 20, width: 100, height: 30 },
  writingMode: 'horizontal',
  order: 0,
  text: 'hello',
};

describe('loadPecoToolBBoxMeta', () => {
  it('S-10-11: 正常な PecoToolBBoxes JSON はパース成功', async () => {
    const raw = JSON.stringify({ '0': [validEntry] });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).not.toBeNull();
    expect(result?.['0']).toHaveLength(1);
    expect(result?.['0'][0].text).toBe('hello');
  });

  it('S-10-12a: __proto__ キーを含む JSON は reject (null)', async () => {
    // JSON.parse の __proto__ ハンドリングに依存しないよう、
    // パース後に __proto__ が own-property として現れる文字列を使う。
    const raw = '{"__proto__":[{"bbox":{"x":1,"y":2,"width":3,"height":4},"writingMode":"horizontal","order":0,"text":"x"}]}';
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('S-10-12b: constructor キーを含む JSON は reject', async () => {
    const raw = JSON.stringify({ constructor: [validEntry] });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('S-10-12c: prototype キーを含む JSON は reject', async () => {
    const raw = JSON.stringify({ prototype: [validEntry] });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('S-10-13a: bbox.x が NaN の entry は reject', async () => {
    // JSON 上は NaN を直接表現できないため、文字列で食わせて isValidBBox の Number.isFinite で弾かれることを確認。
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: { x: 'NaN', y: 0, width: 10, height: 10 } }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('S-10-13b: bbox.width が null の entry は reject', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: { x: 0, y: 0, width: null, height: 10 } }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('S-10-13c: bbox 自体が文字列の entry は reject', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: 'broken' }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('order が負数の entry は reject', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, order: -1 }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('order が小数の entry は reject', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, order: 1.5 }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('値が配列ではなくオブジェクトの場合 reject', async () => {
    const raw = JSON.stringify({ '0': validEntry });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('JSON.parse が失敗する不正文字列は null を返す (例外を投げない)', async () => {
    const raw = '{not-json';
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('PecoToolBBoxes が存在しない場合は null を返す', async () => {
    const result = await loadPecoToolBBoxMeta(makeFakePdf(null));
    expect(result).toBeNull();
  });

  // ── #36: empty-string / non-string fallback regression ──────────────────────
  it('#36: custom.PecoToolBBoxes が空文字でも info.PecoToolBBoxes (有効 JSON) に fallback', async () => {
    const validJson = JSON.stringify({ '0': [validEntry] });
    const result = await loadPecoToolBBoxMeta(
      makeFakePdfWithCustom({ customRaw: '', infoRaw: validJson }),
    );
    expect(result).not.toBeNull();
    expect(result?.['0']).toHaveLength(1);
    expect(result?.['0'][0].text).toBe('hello');
  });

  it('#36: custom.PecoToolBBoxes が非文字列 (object) でも info に fallback', async () => {
    // 旧 `||` は object 値を truthy として採用してしまい typeof チェックで null 返却していた。
    const validJson = JSON.stringify({ '0': [validEntry] });
    const result = await loadPecoToolBBoxMeta(
      makeFakePdfWithCustom({ customRaw: { unexpected: true }, infoRaw: validJson }),
    );
    expect(result).not.toBeNull();
    expect(result?.['0']).toHaveLength(1);
  });

  it('#36: custom.PecoToolBBoxes が数値 0 でも info に fallback', async () => {
    const validJson = JSON.stringify({ '0': [validEntry] });
    const result = await loadPecoToolBBoxMeta(
      makeFakePdfWithCustom({ customRaw: 0, infoRaw: validJson }),
    );
    expect(result).not.toBeNull();
  });

  it('#36: custom と info 両方が空文字なら null を返す', async () => {
    const result = await loadPecoToolBBoxMeta(
      makeFakePdfWithCustom({ customRaw: '', infoRaw: '' }),
    );
    expect(result).toBeNull();
  });

  it('#36: custom が有効 JSON / info が空文字なら custom を採用', async () => {
    const validJson = JSON.stringify({ '0': [validEntry] });
    const result = await loadPecoToolBBoxMeta(
      makeFakePdfWithCustom({ customRaw: validJson, infoRaw: '' }),
    );
    expect(result).not.toBeNull();
    expect(result?.['0'][0].text).toBe('hello');
  });

  it('新形式の private stream を source bytes から優先して読む', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    writePecoToolBBoxMetaToPdfDoc(pdf, { '0': [validEntry] });
    const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });

    const result = await loadPecoToolBBoxMeta(makeFakePdf(null), { bytes: new Uint8Array(bytes) });

    expect(result).not.toBeNull();
    expect(result?.['0']).toHaveLength(1);
    expect(result?.['0'][0].text).toBe('hello');
  });

  it('新形式保存時は旧 Info の PecoToolBBoxes を削除する', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const infoDict = (pdf as unknown as { getInfoDict(): { get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => void } }).getInfoDict();
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify({ '0': [validEntry] })));

    writePecoToolBBoxMetaToPdfDoc(pdf, { '0': [{ ...validEntry, text: 'private' }] });
    const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const reloadedInfo = (reloaded as unknown as { getInfoDict(): { get: (k: unknown) => unknown } }).getInfoDict();

    expect(reloadedInfo.get(PDFName.of('PecoToolBBoxes'))).toBeUndefined();
    const result = await loadPecoToolBBoxMeta(makeFakePdf(null), { bytes: new Uint8Array(bytes) });
    expect(result?.['0'][0].text).toBe('private');
  });
});
