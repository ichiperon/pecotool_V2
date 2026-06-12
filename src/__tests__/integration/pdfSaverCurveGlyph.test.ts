/**
 * Integration test: curve 付き TextBlock が保存後の PDF content stream に
 * per-glyph `cosθ sinθ -sinθ cosθ x y Tm` + `Tj` 列として書き出される
 * こと (issue #187 / Phase 3)。
 *
 * Phase 1 (#186) の roundtrip テストはメタ層の curve 保存のみを保証していた。
 * Phase 3 では実際の content stream 上に per-glyph Tm が現れることを確認する。
 *
 * 検証:
 *   - arc 付き block (6 文字 ASCII) を保存
 *   - 保存 PDF の page contents stream を decode (FlateDecode)
 *   - BT...ET の中に Tm operator が文字数以上ある
 *   - Tm 行列が cos θ sin θ -sin θ cos θ x y パターン (a == d, b == -c)
 *   - Tr (text rendering mode) = 3 (invisible) が現れる
 *   - 既存 PecoToolBBoxes メタにも curve が保存されている (Phase 1 不変条件維持)
 */
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFArray,
} from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { readPecoToolBBoxMetaFromBytes } from '../../utils/pdfPecoToolMetadata';
import type { CurveDefinition, PageData, PecoDocument, TextBlock } from '../../types';
// #357: renderMode 3 不可視性の厳密検証ヘルパー
import { assertAllTextSegmentsHaveRenderMode3 } from './helpers/renderModeHelpers';

async function makeMinimalPdfWithId(width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  doc.context.trailerInfo.ID = doc.context.obj([
    PDFHexString.of('aabbccddeeff00112233445566778899'),
    PDFHexString.of('99887766554433221100ffeeddccbbaa'),
  ]);
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeDocStateWithCurve(
  curve: CurveDefinition,
  text: string,
  pageW: number,
  pageH: number,
): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text,
    originalText: '',
    bbox: { x: 20, y: 80, width: pageW - 40, height: 40 },
    writingMode: 'horizontal',
    order: 0,
    isNew: true,
    isDirty: true,
    curve,
  };
  const page: PageData = {
    pageIndex: 0,
    width: pageW,
    height: pageH,
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

/**
 * page 0 の Contents stream(s) を decode して結合したテキスト形式の content stream を返す。
 */
async function decodePage0Contents(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const contentsKey = PDFName.of('Contents');
  const raw = page.node.get?.(contentsKey) ?? page.node.Contents?.();
  if (!raw) return '';
  const resolved = doc.context.lookup(raw);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [raw];
  const chunks: string[] = [];
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    const rawBytes = stream.getContents();
    let bytesPlain: Uint8Array = rawBytes;
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try {
        bytesPlain = inflate(rawBytes);
      } catch {
        continue;
      }
    }
    chunks.push(new TextDecoder('latin1').decode(bytesPlain));
  }
  return chunks.join('\n');
}

describe('buildPdfDocument curve per-glyph Tm/Tj (#187)', () => {
  it('arc curve 付き block を保存すると content stream に文字数分以上の Tm が現れる', async () => {
    const pageW = 200;
    const pageH = 200;
    const input = await makeMinimalPdfWithId(pageW, pageH);
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 100, y: 120 },
      radius: 70,
      startAngle: Math.PI,
      endAngle: 2 * Math.PI,
    };
    const text = 'ABCDEF';
    const saved = await buildPdfDocument(input, makeDocStateWithCurve(arc, text, pageW, pageH));

    const stream = await decodePage0Contents(saved);

    // 1) Tm operator が文字数以上ある
    const tmMatches = stream.match(/\bTm\b/g) ?? [];
    expect(tmMatches.length).toBeGreaterThanOrEqual(text.length);

    // 2) BT...ET の中に invisible rendering mode (3 Tr) が現れる
    // #357: 単発マッチではなく「各 BT...ET セグメントで Tj より前に 3 Tr が存在する」を検証
    expect(stream).toMatch(/\bBT\b/);
    expect(stream).toMatch(/\bET\b/);
    const curveRenderMode3Check = assertAllTextSegmentsHaveRenderMode3(stream);
    expect(
      curveRenderMode3Check.pass,
      `#357: renderMode 3 check failed for ${curveRenderMode3Check.failingSegmentCount}/${curveRenderMode3Check.totalTextSegments} BT...ET segments`,
    ).toBe(true);

    // 3) Tm 各引数が rotation 行列パターンを満たす:
    //    "<a> <b> <c> <d> <x> <y> Tm" で a == d かつ b == -c (回転 only、scale なし)
    //    主要 6 個分について見つける (Tj の前/後の数値群を緩く取り出す)
    const tmRegex = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm/g;
    let count = 0;
    for (const m of stream.matchAll(tmRegex)) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      const c = parseFloat(m[3]);
      const d = parseFloat(m[4]);
      // 浮動小数誤差を許容
      expect(Math.abs(a - d)).toBeLessThan(1e-3);
      expect(Math.abs(b + c)).toBeLessThan(1e-3);
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(text.length);

    // 4) BBoxMeta にも curve が保存されている (Phase 1 不変条件)
    const meta = await readPecoToolBBoxMetaFromBytes(saved);
    const entries = meta['0'] as Array<Record<string, unknown>>;
    expect(entries[0].curve).toEqual(arc);
    expect(entries[0].text).toBe(text);
  }, 30_000);

  it('polyline curve 付き block も per-glyph Tm を生成する', async () => {
    const pageW = 200;
    const pageH = 200;
    const input = await makeMinimalPdfWithId(pageW, pageH);
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 20, y: 80 },
        { x: 100, y: 60 },
        { x: 180, y: 80 },
      ],
    };
    const text = 'WXYZ';
    const saved = await buildPdfDocument(
      input,
      makeDocStateWithCurve(polyline, text, pageW, pageH),
    );

    const stream = await decodePage0Contents(saved);
    const tmCount = (stream.match(/\bTm\b/g) ?? []).length;
    expect(tmCount).toBeGreaterThanOrEqual(text.length);
    expect(stream).toMatch(/\bBT\b/);
    expect(stream).toMatch(/\bET\b/);
  }, 30_000);

  it('curve なし block は per-glyph Tm を生成しない (既存 axis-aligned 経路維持)', async () => {
    const pageW = 200;
    const pageH = 200;
    const input = await makeMinimalPdfWithId(pageW, pageH);
    const block: TextBlock = {
      id: 'b0',
      text: 'PlainText',
      originalText: '',
      bbox: { x: 20, y: 80, width: 160, height: 40 },
      writingMode: 'horizontal',
      order: 0,
      isNew: true,
      isDirty: true,
    };
    const page: PageData = {
      pageIndex: 0,
      width: pageW,
      height: pageH,
      textBlocks: [block],
      isDirty: true,
      thumbnail: null,
    };
    const doc: PecoDocument = {
      filePath: 'in-memory.pdf',
      fileName: 'in-memory.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, page]]),
    };

    const saved = await buildPdfDocument(input, doc);
    const stream = await decodePage0Contents(saved);
    // axis-aligned 経路は drawText 由来の Tj は使うが、per-glyph で繰り返し発行する
    // Tm はせいぜい 1〜数個 (block 数分)。9 文字に対して 9 個もの Tm は出ない。
    const tmCount = (stream.match(/\bTm\b/g) ?? []).length;
    expect(tmCount).toBeLessThan(block.text.length);
  }, 30_000);
});
