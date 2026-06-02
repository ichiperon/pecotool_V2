/**
 * Integration test: curve 付き TextBlock を含む BBoxes JSON が buildPdfDocument
 * 経由で round-trip しても curve が保持されること (issue #186 Phase 1)。
 *
 * Phase 1 ではまだ PDF saver は curve を per-glyph Tm 出力しない (Phase 3)。
 * このテストはあくまで「メタ層 (PecoToolBBoxes JSON) で curve definition が
 * 保存・再読込で復元される」ことだけを保証する。
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString } from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { readPecoToolBBoxMetaFromBytes } from '../../utils/pdfPecoToolMetadata';
import type { CurveDefinition, PageData, PecoDocument, TextBlock } from '../../types';

async function makeMinimalPdfWithId(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.context.trailerInfo.ID = doc.context.obj([
    PDFHexString.of('aabbccddeeff00112233445566778899'),
    PDFHexString.of('99887766554433221100ffeeddccbbaa'),
  ]);
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeDocStateWithCurve(curve: CurveDefinition): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text: 'PecoTool',
    originalText: '',
    bbox: { x: 20, y: 80, width: 160, height: 40 },
    writingMode: 'horizontal',
    order: 0,
    isNew: true,
    isDirty: true,
    curve,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 200,
    height: 200,
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

describe('curve BBoxMeta roundtrip (#186)', () => {
  it('arc curve を持つ TextBlock を保存して再読込すると curve が復元される', async () => {
    const input = await makeMinimalPdfWithId();
    const arc: CurveDefinition = {
      type: 'arc',
      center: { x: 100, y: 100 },
      radius: 80,
      startAngle: Math.PI,
      endAngle: 2 * Math.PI,
    };

    const saved = await buildPdfDocument(input, makeDocStateWithCurve(arc));
    const meta = await readPecoToolBBoxMetaFromBytes(saved);
    const entries = meta['0'] as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].curve).toEqual(arc);
  }, 30_000);

  it('polyline curve を持つ TextBlock を保存して再読込すると curve が復元される', async () => {
    const input = await makeMinimalPdfWithId();
    const polyline: CurveDefinition = {
      type: 'polyline',
      points: [
        { x: 20, y: 80 },
        { x: 100, y: 60 },
        { x: 180, y: 80 },
      ],
    };

    const saved = await buildPdfDocument(input, makeDocStateWithCurve(polyline));
    const meta = await readPecoToolBBoxMetaFromBytes(saved);
    const entries = meta['0'] as Array<Record<string, unknown>>;
    expect(entries[0].curve).toEqual(polyline);
  }, 30_000);

  it('curve なしの TextBlock を保存すると JSON に curve フィールドが現れない (後方互換)', async () => {
    const input = await makeMinimalPdfWithId();
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
      width: 200,
      height: 200,
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
    const meta = await readPecoToolBBoxMetaFromBytes(saved);
    const entries = meta['0'] as Array<Record<string, unknown>>;
    expect(entries[0]).not.toHaveProperty('curve');
  }, 30_000);
});
