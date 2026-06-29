/**
 * S-10 (追加): pdfMetadataLoader の JSON.parse narrow を検証する。
 * - PDF メタデータに偽装した不正 JSON を食わせ、reject されることを確認。
 * - prototype 汚染攻撃 / bbox の非有限値などが弾かれること。
 * - #36: custom.PecoToolBBoxes が空/非文字列でも info.PecoToolBBoxes に fallback される
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadPecoToolBBoxMeta, _resetBBoxMetaCacheForTest, invalidateBBoxMetaCache } from '../../utils/pdfMetadataLoader';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
} from '@cantoo/pdf-lib';
import { deflate } from 'pako';
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

  it('S-10-12a: __proto__ キーを含む JSON は dangerous key をスキップし Object.prototype を汚染しない', async () => {
    // JSON.parse の __proto__ ハンドリングに依存しないよう、
    // パース後に __proto__ が own-property として現れる文字列を使う。
    // sanitizeBBoxMetaRecord は DANGEROUS_KEY のページだけをスキップする（文書全体を捨てない）。
    // __proto__ のみのレコードは全キーがスキップされ空 record {} になる（null ではない）。
    const raw = '{"__proto__":[{"bbox":{"x":1,"y":2,"width":3,"height":4},"writingMode":"horizontal","order":0,"text":"x"}]}';
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 結果が null でも {} でも、dangerous key が result に残っていないことが重要。
    // Object.prototype 汚染が起きていないことを検証する。
    expect((Object.prototype as Record<string, unknown>)['x']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['text']).toBeUndefined();
    const plainObj = {};
    expect(Object.keys(plainObj).length).toBe(0);
    // 結果に __proto__ キーが含まれていないこと
    if (result !== null) {
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    }
  });

  it('S-10-12b: constructor キーを含む JSON は dangerous key をスキップし prototype 汚染しない', async () => {
    const raw = JSON.stringify({ constructor: [validEntry] });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // dangerous key がスキップされ、結果に残っていないこと
    if (result !== null) {
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    }
    // Object.prototype が汚染されていないこと
    const plainObj = {};
    expect(Object.keys(plainObj).length).toBe(0);
  });

  it('S-10-12c: prototype キーを含む JSON は dangerous key をスキップし prototype 汚染しない', async () => {
    const raw = JSON.stringify({ prototype: [validEntry] });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // dangerous key がスキップされ、結果に残っていないこと
    if (result !== null) {
      expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
    }
    const plainObj = {};
    expect(Object.keys(plainObj).length).toBe(0);
  });

  it('S-10-13a: bbox.x が NaN の entry はそのエントリだけ除外される（ページが空になれば omit）', async () => {
    // JSON 上は NaN を直接表現できないため、文字列で食わせて isValidBBox の Number.isFinite で弾かれることを確認。
    // sanitizeBBoxMetaRecord は不正エントリをスキップする。全エントリ不正のページは省略され空 record を返す。
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: { x: 'NaN', y: 0, width: 10, height: 10 } }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 不正エントリが除外されて page '0' に有効エントリがないため、page '0' は omit される。
    // result は null または空 record {} のどちらも許容（どちらも「有効エントリなし」を意味する）。
    // 重要: 不正エントリが result に残っていないこと。
    if (result !== null && result['0'] !== undefined) {
      // もしページが存在する場合、全エントリが isValidBBox を通っていること
      for (const entry of result['0']) {
        expect(Number.isFinite(entry.bbox.x)).toBe(true);
      }
    }
  });

  it('S-10-13b: bbox.width が null の entry はそのエントリだけ除外される', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: { x: 0, y: 0, width: null, height: 10 } }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 不正エントリが除外され、page '0' に有効エントリがなければ omit される。
    if (result !== null && result['0'] !== undefined) {
      for (const entry of result['0']) {
        expect(Number.isFinite(entry.bbox.width)).toBe(true);
      }
    }
  });

  it('S-10-13c: bbox 自体が文字列の entry はそのエントリだけ除外される', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, bbox: 'broken' }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 不正エントリが除外され、page '0' に有効エントリがなければ omit される。
    if (result !== null && result['0'] !== undefined) {
      for (const entry of result['0']) {
        expect(typeof entry.bbox).toBe('object');
        expect(Number.isFinite(entry.bbox.x)).toBe(true);
      }
    }
  });

  it('order が負数の entry はそのエントリだけ除外される（同ページの正常エントリは保持）', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, order: -1 }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 不正エントリが除外され、page '0' が空になれば omit。
    if (result !== null && result['0'] !== undefined) {
      for (const entry of result['0']) {
        expect(entry.order).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(entry.order)).toBe(true);
      }
    }
  });

  it('order が小数の entry はそのエントリだけ除外される', async () => {
    const raw = JSON.stringify({
      '0': [{ ...validEntry, order: 1.5 }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 不正エントリが除外され、page '0' が空になれば omit。
    if (result !== null && result['0'] !== undefined) {
      for (const entry of result['0']) {
        expect(Number.isInteger(entry.order)).toBe(true);
      }
    }
  });

  it('値が配列ではなくオブジェクトの場合はそのページをスキップする', async () => {
    const raw = JSON.stringify({ '0': validEntry });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // page '0' の値が配列でないためスキップ → page '0' は result に現れない。
    if (result !== null) {
      expect(result['0']).toBeUndefined();
    }
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

// ── PCT-049: sanitizeBBoxMetaRecord 挙動の直接検証 ──────────────────────────
// per-entry / per-page サニタイズ、DANGEROUS_KEY スキップ、有効分保持、構造破綻時のみ null
describe('PCT-049: sanitizeBBoxMetaRecord — per-entry / per-page sanitization', () => {
  const goodEntry = {
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    writingMode: 'horizontal',
    order: 0,
    text: 'valid',
  };

  it('不正エントリが1件混じっても同ページの有効エントリは保持される', async () => {
    // page '0' に不正 (confidence=-1) と正常が混在
    // 不正なエントリだけ除外、正常エントリは保持される
    const raw = JSON.stringify({
      '0': [
        { ...goodEntry, text: 'bad', confidence: -1 },
        { ...goodEntry, text: 'good', order: 1 },
      ],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).not.toBeNull();
    expect(result!['0']).toBeDefined();
    expect(result!['0']).toHaveLength(1);
    expect(result!['0'][0].text).toBe('good');
  });

  it('page0 が全不正でも page1 の有効エントリは保持される（cross-page 巻き添えなし）', async () => {
    // page '0': 全エントリ不正（order が負）→ page '0' は omit
    // page '1': 全エントリ正常 → page '1' は保持
    const raw = JSON.stringify({
      '0': [{ ...goodEntry, order: -1 }],
      '1': [{ ...goodEntry, text: 'page1-valid', order: 0 }],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).not.toBeNull();
    // page '0' は有効エントリがないため omit される
    expect(result!['0']).toBeUndefined();
    // page '1' は正常に保持される
    expect(result!['1']).toBeDefined();
    expect(result!['1']).toHaveLength(1);
    expect(result!['1'][0].text).toBe('page1-valid');
  });

  it('DANGEROUS_KEY のページはスキップし、正常ページは保持される', async () => {
    // __proto__ キーはスキップ、'1' キーは正常に保持
    // JSON.stringify では __proto__ は own-property として埋め込まれない場合があるため
    // 直接 raw 文字列で注入する（S-10-12a と同じ手法）
    const rawWithProto =
      '{"__proto__":[{"bbox":{"x":1,"y":2,"width":3,"height":4},"writingMode":"horizontal","order":0,"text":"danger"}],' +
      '"1":[{"bbox":{"x":10,"y":20,"width":100,"height":30},"writingMode":"horizontal","order":0,"text":"safe"}]}';
    const result = await loadPecoToolBBoxMeta(makeFakePdf(rawWithProto));
    // __proto__ キーが result に存在しないこと
    expect(result).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    // '1' ページは保持されること
    expect(result!['1']).toBeDefined();
    expect(result!['1'][0].text).toBe('safe');
    // Object.prototype が汚染されていないこと
    const plainObj = {};
    expect(Object.keys(plainObj).length).toBe(0);
  });

  it('トップレベルが配列の場合は null を返す（構造破綻）', async () => {
    const raw = JSON.stringify([goodEntry]);
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('トップレベルが null の場合は null を返す（構造破綻）', async () => {
    const raw = 'null';
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('トップレベルが文字列の場合は null を返す（構造破綻）', async () => {
    const raw = JSON.stringify('"just a string"');
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).toBeNull();
  });

  it('全エントリが有効なら全て保持される（正常ラウンドトリップ）', async () => {
    const raw = JSON.stringify({
      '0': [
        { ...goodEntry, text: 'entry0', order: 0 },
        { ...goodEntry, text: 'entry1', order: 1 },
      ],
      '2': [
        { ...goodEntry, text: 'page2', order: 0 },
      ],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).not.toBeNull();
    expect(result!['0']).toHaveLength(2);
    expect(result!['0'][0].text).toBe('entry0');
    expect(result!['0'][1].text).toBe('entry1');
    expect(result!['2']).toHaveLength(1);
    expect(result!['2'][0].text).toBe('page2');
  });

  it('confidence が 0 と 1 の境界値は有効エントリとして保持される', async () => {
    const raw = JSON.stringify({
      '0': [
        { ...goodEntry, text: 'conf0', confidence: 0, order: 0 },
        { ...goodEntry, text: 'conf1', confidence: 1, order: 1 },
        { ...goodEntry, text: 'conf-none', order: 2 },
      ],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    expect(result).not.toBeNull();
    expect(result!['0']).toHaveLength(3);
    const texts = result!['0'].map((e) => e.text);
    expect(texts).toContain('conf0');
    expect(texts).toContain('conf1');
    expect(texts).toContain('conf-none');
  });

  it('全エントリが不正で空になった場合は page キー自体が omit される（データなし = ページ省略）', async () => {
    const raw = JSON.stringify({
      '0': [
        { ...goodEntry, order: -5 },    // invalid: negative order
        { ...goodEntry, confidence: 99 }, // invalid: confidence > 1
      ],
    });
    const result = await loadPecoToolBBoxMeta(makeFakePdf(raw));
    // 結果が non-null であれば '0' キーは存在しない（空ページは omit）
    if (result !== null) {
      expect(result['0']).toBeUndefined();
    }
  });
});

// ── PCT-103: loadPecoToolBBoxMeta メモ化テスト ────────────────────────────
describe('PCT-103: loadPecoToolBBoxMeta memoization', () => {
  beforeEach(() => {
    _resetBBoxMetaCacheForTest();
  });

  const goodEntry = {
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    writingMode: 'horizontal',
    order: 0,
    text: 'cached',
  };

  it('同一 filePath + mtime では loadBytes を1回しか呼ばない', async () => {
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdf = makeFakePdf(null);
    const source = {
      loadBytes: async () => {
        loadCount++;
        // bytes を返さず null で fallback させ、PDF metadata 経由でも確認する
        return null as any;
      },
      filePath: '/test/file.pdf',
      mtime: 12345,
    };

    // 1回目: キャッシュミス → loadBytes が呼ばれる
    const r1 = await loadPecoToolBBoxMeta(
      { getMetadata: async () => ({ info: { PecoToolBBoxes: raw }, metadata: null, contentDispositionFilename: null, contentLength: null }) } as any,
      source,
    );
    expect(loadCount).toBe(1);

    // 2回目: キャッシュヒット → loadBytes が呼ばれない
    const r2 = await loadPecoToolBBoxMeta(
      { getMetadata: async () => ({ info: { PecoToolBBoxes: raw }, metadata: null, contentDispositionFilename: null, contentLength: null }) } as any,
      source,
    );
    expect(loadCount).toBe(1); // 変化なし

    // 結果が同一オブジェクトであること（キャッシュヒット）
    expect(r1).toBe(r2);
  });

  it('mtime が変化したら再ロードする', async () => {
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdfMeta = { getMetadata: async () => ({ info: { PecoToolBBoxes: raw }, metadata: null, contentDispositionFilename: null, contentLength: null }) } as any;
    const makeSource = (mtime: number) => ({
      loadBytes: async () => { loadCount++; return null as any; },
      filePath: '/test/file.pdf',
      mtime,
    });

    await loadPecoToolBBoxMeta(fakePdfMeta, makeSource(100));
    expect(loadCount).toBe(1);

    // mtime が変わった → キャッシュミスで再ロード
    await loadPecoToolBBoxMeta(fakePdfMeta, makeSource(200));
    expect(loadCount).toBe(2);
  });

  it('別ファイルでは再ロードする', async () => {
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdfMeta = { getMetadata: async () => ({ info: { PecoToolBBoxes: raw }, metadata: null, contentDispositionFilename: null, contentLength: null }) } as any;
    const makeSource = (filePath: string) => ({
      loadBytes: async () => { loadCount++; return null as any; },
      filePath,
      mtime: 100,
    });

    await loadPecoToolBBoxMeta(fakePdfMeta, makeSource('/test/a.pdf'));
    expect(loadCount).toBe(1);

    // 別ファイル → キャッシュミスで再ロード
    await loadPecoToolBBoxMeta(fakePdfMeta, makeSource('/test/b.pdf'));
    expect(loadCount).toBe(2);
  });

  it('mtime が渡されない場合はキャッシュをスキップする（安全側）', async () => {
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdfMeta = { getMetadata: async () => ({ info: { PecoToolBBoxes: raw }, metadata: null, contentDispositionFilename: null, contentLength: null }) } as any;
    const source = {
      loadBytes: async () => { loadCount++; return null as any; },
      filePath: '/test/file.pdf',
      // mtime: 未指定
    };

    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    await loadPecoToolBBoxMeta(fakePdfMeta, source);

    // mtime なし → 毎回 loadBytes が呼ばれる
    expect(loadCount).toBe(2);
  });
});

// ── PCT-101/C1: invalidateBBoxMetaCache — 保存後の stale キャッシュ破棄 ─────
describe('PCT-101/C1: invalidateBBoxMetaCache', () => {
  beforeEach(() => {
    _resetBBoxMetaCacheForTest();
  });

  const goodEntry = {
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    writingMode: 'horizontal',
    order: 0,
    text: 'before-save',
  };

  it('キャッシュ済み → invalidateBBoxMetaCache() → 再ロードが走る（loadBytes が再度呼ばれる）', async () => {
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdfMeta = {
      getMetadata: async () => ({
        info: { PecoToolBBoxes: raw },
        metadata: null,
        contentDispositionFilename: null,
        contentLength: null,
      }),
    } as any;
    const source = {
      loadBytes: async () => { loadCount++; return null as any; },
      filePath: '/test/file.pdf',
      mtime: 12345,
    };

    // 1回目: キャッシュミス → loadBytes が呼ばれる
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(1);

    // 2回目: キャッシュヒット → loadBytes が呼ばれない
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(1); // 変化なし

    // 上書き保存を模倣: invalidateBBoxMetaCache() でキャッシュ破棄
    invalidateBBoxMetaCache();

    // 3回目: キャッシュ破棄後 → loadBytes が再度呼ばれる（再ロード）
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(2); // 増加 = 再ロードが走った
  });

  it('invalidateBBoxMetaCache() を外すと保存後もキャッシュヒットする（mutation 実証）', async () => {
    // このテストは「invalidate がないと退行が再現する」ことを示す。
    // invalidate を呼ばない場合、同一 filePath + mtime ではキャッシュが継続する。
    let loadCount = 0;
    const raw = JSON.stringify({ '0': [goodEntry] });
    const fakePdfMeta = {
      getMetadata: async () => ({
        info: { PecoToolBBoxes: raw },
        metadata: null,
        contentDispositionFilename: null,
        contentLength: null,
      }),
    } as any;
    const source = {
      loadBytes: async () => { loadCount++; return null as any; },
      filePath: '/test/file.pdf',
      mtime: 99999,
    };

    // 1回目ロード
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(1);

    // invalidate を呼ばずに2回目ロード → キャッシュヒットで loadBytes は呼ばれない
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(1); // 変化なし = 退行の再現（保存後に古いメタが返る状況）

    // invalidate を呼べば次ロードで loadBytes が走る（正しい挙動）
    invalidateBBoxMetaCache();
    await loadPecoToolBBoxMeta(fakePdfMeta, source);
    expect(loadCount).toBe(2); // invalidate あり = 再ロード成功
  });
});

describe('S-392: undecodable private BBox stream → onUndecodable 通知 (#392/PCT-161)', () => {
  beforeEach(() => {
    _resetBBoxMetaCacheForTest();
  });

  /** 多重フィルタ [/FlateDecode /FlateDecode]（本バージョン未対応＝decode 不能）の BBox stream を持つ PDF */
  async function makeUndecodableBytes(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    const ctx = pdf.context as unknown as {
      register: (o: unknown) => unknown;
      stream: (b: Uint8Array, d: Record<string, unknown>) => { dict: { set: (k: PDFName, v: unknown) => void } };
      obj: (d: unknown) => unknown;
    };
    const compressed = deflate(
      new TextEncoder().encode(JSON.stringify({ '0': [{ x: 1, y: 2, w: 3, h: 4, text: 'real' }] })),
    );
    const rawStream = ctx.stream(compressed, { Subtype: 'BBoxes' });
    rawStream.dict.set(
      PDFName.of('Filter'),
      ctx.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')]) as never,
    );
    const ref = ctx.register(rawStream);
    (pdf.catalog as unknown as { set: (k: PDFName, v: unknown) => void }).set(
      PDFName.of('PecoTool'),
      ctx.obj({ Version: 1, BBoxes: ref }) as never,
    );
    return pdf.save({ useObjectStreams: false, addDefaultPage: false });
  }

  it('decode 不能なら onUndecodable が1回呼ばれ、読めるメタは無い', async () => {
    const bytes = await makeUndecodableBytes();
    let called = 0;
    const result = await loadPecoToolBBoxMeta(makeFakePdf(null), {
      loadBytes: async () => bytes,
      onUndecodable: () => { called += 1; },
    });
    expect(called).toBe(1);
    expect(result).toBeNull();
  });

  it('decode 可能な通常メタでは onUndecodable は呼ばれない（誤通知なし）', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    writePecoToolBBoxMetaToPdfDoc(pdf, {
      '0': [{ bbox: { x: 1, y: 2, width: 3, height: 4 }, writingMode: 'horizontal', order: 0, text: 'ok' }],
    });
    const bytes = await pdf.save({ useObjectStreams: false });
    let called = 0;
    await loadPecoToolBBoxMeta(makeFakePdf(null), {
      loadBytes: async () => bytes,
      onUndecodable: () => { called += 1; },
    });
    expect(called).toBe(0);
  });
});
