/**
 * Regression test for issue #78:
 *   多重 content stream で 1 つ decode 失敗時に他 stream の元テキストが残る (High)
 *
 * 旧実装の問題:
 *   Contents が [A, B, C] 配列で B の decode が失敗すると、コードは B だけに
 *   cleanContentStream を呼んで return。A はすでに decodedStreams に積まれたが捨てられ、
 *   merge/strip しないので A と C の元テキストは残り、B のみ部分書換 → Double OCR が
 *   部分的に残る + 演算子順序破壊で Acrobat エラーが起きていた。
 *
 * 修正方針:
 *   - decode 失敗時は merge 経路を諦め、各 stream を個別 in-place で cleanContentStream する。
 *   - 成功 stream も merge せず in-place で strip。失敗 stream は cleanContentStream の中で
 *     再 decode を試みるがどうせ失敗するので元のまま残る。
 *   - 結果: A と C のテキスト断片は in-place strip で消える。B はそのまま残るが、
 *     B 単独では「他 stream の Tj が混入する」問題は無いので影響は限定的。
 *
 * 検証方法:
 *   - Contents = [A, B, C] の PDF を作る。
 *   - A と C は FlateDecode (decode 成功)、B は LZWDecode (saver の decode 不能)。
 *   - A と C に BT...ET ブロックを入れる。
 *   - 保存後、A と C の Tj/TJ が消えていることを確認する。
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { inflate, deflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

/**
 * Contents=[A, B, C] のページを持つ PDF を構築する。
 * - A: BT (legacyA) Tj ET — FlateDecode
 * - B: 何らかのバイト列 — LZWDecode (saver の decodeStreamContents が null を返す)
 * - C: BT (legacyC) Tj ET — FlateDecode
 */
async function makePdfWithMixedFilterStreams(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);

  const enc = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };

  // Stream A: FlateDecode で BT (legacyA) Tj ET を含む
  const aRaw = enc('q\nBT /F1 12 Tf (legacyA) Tj ET\nQ');
  const aCompressed = deflate(aRaw);
  const aStream = pdf.context.stream(aCompressed, {
    Filter: PDFName.of('FlateDecode'),
  });

  // Stream B: LZWDecode (saver の decodeStreamContents は handling 不能)
  // バイト列は実際の LZW 圧縮にする必要は無い (saver は filter 名だけ見て早期 return)
  const bRaw = enc('q\nBT /F1 12 Tf (legacyB) Tj ET\nQ');
  const bStream = pdf.context.stream(bRaw, {
    Filter: PDFName.of('LZWDecode'),
  });

  // Stream C: FlateDecode で BT (legacyC) Tj ET を含む
  const cRaw = enc('q\nBT /F1 12 Tf (legacyC) Tj ET\nQ');
  const cCompressed = deflate(cRaw);
  const cStream = pdf.context.stream(cCompressed, {
    Filter: PDFName.of('FlateDecode'),
  });

  const aRef = pdf.context.register(aStream);
  const bRef = pdf.context.register(bStream);
  const cRef = pdf.context.register(cStream);

  const contentsArray = pdf.context.obj([aRef, bRef, cRef]);
  page.node.set(PDFName.of('Contents'), contentsArray);

  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** ページ 0 の全 content stream を decode → 連結して latin1 文字列で返す */
async function decodeAllPage0Contents(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const dec = new TextDecoder('latin1');
  const parts: string[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) continue;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { parts.push(dec.decode(inflate(raw))); } catch { parts.push(dec.decode(raw)); }
    } else {
      // 非 FlateDecode (LZW など) はそのまま latin1 で展開
      parts.push(dec.decode(raw));
    }
  }
  return parts.join('\n---STREAM-BOUNDARY---\n');
}

function makeNonDirtyDoc(): PecoDocument {
  // textBlocks は空でも isDirty=true なら replacePageTextContentStreams は走る
  const block: TextBlock = {
    id: 'b0',
    text: '',
    originalText: '',
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'multi-stream-decode-fail.pdf',
    fileName: 'multi-stream-decode-fail.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

describe('pdfSaver issue #78: multi-stream decode failure should still strip other streams', () => {
  it('Contents=[A(Flate), B(LZW), C(Flate)] で B が decode 不能でも A と C の Tj は in-place 削除される', async () => {
    const original = await makePdfWithMixedFilterStreams();
    // sanity: 元 PDF には A/B/C の Tj が全て見える
    const originalText = await decodeAllPage0Contents(original);
    expect(originalText).toContain('(legacyA) Tj');
    expect(originalText).toContain('(legacyC) Tj');
    // B は LZW のままなので latin1 decoded の中で legacyB は raw bytes として読める
    // (この test は実 LZW 圧縮を使わず生バイト列なので decoded == raw)
    expect(originalText).toContain('(legacyB) Tj');

    const saved = await buildPdfDocument(original, makeNonDirtyDoc());
    const savedText = await decodeAllPage0Contents(saved);

    // 修正後: A と C は in-place strip で Tj が消えている
    expect(savedText).not.toContain('(legacyA)');
    expect(savedText).not.toContain('(legacyC)');
    // B は decode 不能なので原本のまま (これは仕様、Acrobat 互換性のため部分書換しない)
    // ただし B が「他 stream のテキスト混入」していない (元の B 内容のみ) ことを確認
    expect(savedText).toContain('(legacyB) Tj');

    // Tj/TJ が BT..ET の外に「漏れて」いないこと (Acrobat 7 互換性 — A/C は strip 後、B は元のまま完結)
    const tokenRegex = /\b(BT|ET|Tj|TJ)\b/g;
    let lastOpen: 'BT' | 'ET' | null = null;
    let m: RegExpExecArray | null;
    const violations: string[] = [];
    while ((m = tokenRegex.exec(savedText)) !== null) {
      const tok = m[1];
      if (tok === 'BT') lastOpen = 'BT';
      else if (tok === 'ET') lastOpen = 'ET';
      else if ((tok === 'Tj' || tok === 'TJ') && lastOpen !== 'BT') {
        violations.push(`${tok} at index ${m.index}`);
      }
    }
    expect(violations).toEqual([]);
  }, 60_000);
});
