/**
 * Regression test: OCR text layer offset (textLayerOffsetPt) for horizontal writing mode.
 *
 * Verifies that when textLayerOffsetPt = { dx, dy } is provided via SaveDialogOptions,
 * the horizontal text block's translate operator in the PDF content stream is shifted by
 * exactly (+dx in x, -dy in y) relative to the unshifted baseline.
 *
 * Background:
 *   pdfSaverCore.ts buildPdfDocumentCore reads options.textLayerOffsetPt and applies:
 *     translate(block.bbox.x + textOffsetDx, baselineY - textOffsetDy)
 *   where baselineY = vh - bbox.y - textHeight * sy * (1 - descentRatio).
 *   dx > 0 shifts right, dy > 0 shifts down (viewport coordinate: +y is down).
 *
 * Strategy:
 *   1. Create a minimal 1-page PDF using pdf-lib (no real test PDF dependency).
 *   2. Build a documentState with a single horizontal TextBlock at a well-known bbox.
 *   3. Save once with no offset → extract the translate (cm) x/y coordinates.
 *   4. Save again with offset { dx: 11.34, dy: 5.67 } → extract the same.
 *   5. Assert delta x ≈ +11.34 and delta y ≈ -5.67 (±0.05).
 *   6. Assert that the no-offset result has no accidental offset applied.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFDocument,
  PDFArray,
  PDFRawStream,
  PDFName,
} from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';
import type { SaveDialogOptions } from '../../hooks/useFileOperations';

// Tauri APIs and bitmap cache are not available in the test environment.
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arrayBufferFromFile(fileName: string): ArrayBuffer {
  const buf = readFileSync(resolve(process.cwd(), 'public/fonts', fileName));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** Create a minimal single-page PDF (no content) as Uint8Array. */
async function makeMinimalPdf(pageW = 595, pageH = 842): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([pageW, pageH]);
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** Decode page 0 content stream(s) to a latin1 string for operator parsing. */
async function decodePage0ContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  // Access Contents ref via the node dictionary.
  const rawContents =
    page.node.get(PDFName.of('Contents')) ??
    (page.node as unknown as { Contents?(): unknown }).Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(rawContents as Parameters<typeof doc.context.lookup>[0]);
  const streams =
    resolved instanceof PDFArray
      ? resolved.asArray()
      : [rawContents as Parameters<typeof doc.context.lookup>[0]];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef as Parameters<typeof doc.context.lookup>[0]);
    if (!(s instanceof PDFRawStream)) continue;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try {
        chunks.push(inflate(raw));
      } catch {
        /* skip unreadable streams */
      }
    } else if (!filter) {
      chunks.push(raw);
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder('latin1').decode(out);
}

/**
 * Extract all `cm` operators from a PDF content stream string.
 * Each cm entry = [a, b, c, d, e, f] where e=tx, f=ty.
 */
function extractCmOperands(
  text: string,
): Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> {
  const re =
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: Array<{
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      a: parseFloat(m[1]),
      b: parseFloat(m[2]),
      c: parseFloat(m[3]),
      d: parseFloat(m[4]),
      e: parseFloat(m[5]),
      f: parseFloat(m[6]),
    });
  }
  return out;
}

/**
 * Build a PecoDocument with a single horizontal TextBlock.
 * The bbox is placed at (x=100, y=50, width=200, height=24).
 * isDirty=true so pdfSaverCore enters the drawing path.
 */
function makeDocWithHorizontalBlock(pageW: number, pageH: number): PecoDocument {
  const block: TextBlock = {
    id: 'hblock-0',
    text: 'テスト文字',
    originalText: 'テスト文字',
    bbox: { x: 100, y: 50, width: 200, height: 24 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
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
  return {
    filePath: 'test-offset.pdf',
    fileName: 'test-offset.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/**
 * Extract the translate cm (identity matrix part with non-zero e/f) from
 * a decoded content stream.
 *
 * pdf-lib emits translate(x, y) as `1 0 0 1 x y cm` for R=0 (no rotation).
 * We look for all cm entries with a=1, b=0, c=0, d=1 (pure translation).
 */
function extractTranslateCms(
  text: string,
): Array<{ e: number; f: number }> {
  return extractCmOperands(text)
    .filter(
      (m) =>
        Math.abs(m.a - 1) < 0.001 &&
        Math.abs(m.b) < 0.001 &&
        Math.abs(m.c) < 0.001 &&
        Math.abs(m.d - 1) < 0.001,
    )
    .map(({ e, f }) => ({ e, f }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pdfTextLayerOffset: horizontal writing mode translate shift', () => {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const OFFSET = { dx: 11.34, dy: 5.67 };
  const TOLERANCE = 0.05;

  it('offset なしとオフセット {dx:11.34, dy:5.67} の translate 差分が x=+11.34, y=-5.67 になる', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const originalBytes = await makeMinimalPdf(PAGE_W, PAGE_H);
    const doc = makeDocWithHorizontalBlock(PAGE_W, PAGE_H);

    // --- Save 1: no offset ---
    const optionsNoOffset: SaveDialogOptions = { compression: 'none' };
    const savedNoOffset = await buildPdfDocument(
      originalBytes,
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      optionsNoOffset,
    );

    // --- Save 2: with offset ---
    const optionsWithOffset: SaveDialogOptions = {
      compression: 'none',
      textLayerOffsetPt: OFFSET,
    };
    // Use a fresh copy of originalBytes for the second save.
    const savedWithOffset = await buildPdfDocument(
      new Uint8Array(originalBytes),
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      optionsWithOffset,
    );

    // --- Decode content streams ---
    const textNoOffset = await decodePage0ContentText(savedNoOffset);
    const textWithOffset = await decodePage0ContentText(savedWithOffset);

    // --- Extract translate cm entries ---
    // R=0 → rotationCm=[]. Horizontal path emits: q, translate, scale, drawText..., Q.
    // translate = "1 0 0 1 tx ty cm".
    const translatesNoOffset = extractTranslateCms(textNoOffset);
    const translatesWithOffset = extractTranslateCms(textWithOffset);

    expect(translatesNoOffset.length).toBeGreaterThanOrEqual(1);
    expect(translatesWithOffset.length).toBeGreaterThanOrEqual(1);

    // Take the first translate in each (corresponds to our single text block).
    const baseTranslate = translatesNoOffset[0];
    const shiftedTranslate = translatesWithOffset[0];

    // Verify offset application: dx shifts x right (+), dy shifts y down (= -dy in PDF y-up coords).
    const deltaX = shiftedTranslate.e - baseTranslate.e;
    const deltaY = shiftedTranslate.f - baseTranslate.f;

    expect(deltaX).toBeCloseTo(OFFSET.dx, 1); // x += dx  → delta = +11.34
    expect(deltaY).toBeCloseTo(-OFFSET.dy, 1); // y -= dy  → delta = -5.67
  }, 60_000);

  it('offset 未指定の translate はオフセットが加算されていない (baseline 座標が素の値)', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const originalBytes = await makeMinimalPdf(PAGE_W, PAGE_H);
    const doc = makeDocWithHorizontalBlock(PAGE_W, PAGE_H);

    const optionsNoOffset: SaveDialogOptions = { compression: 'none' };
    const savedNoOffset = await buildPdfDocument(
      originalBytes,
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      optionsNoOffset,
    );

    const textNoOffset = await decodePage0ContentText(savedNoOffset);
    const translatesNoOffset = extractTranslateCms(textNoOffset);

    expect(translatesNoOffset.length).toBeGreaterThanOrEqual(1);

    // The baseline x should be near bbox.x = 100 (within page bounds, no offset applied).
    const tx = translatesNoOffset[0].e;
    expect(tx).toBeCloseTo(100, 0); // block.bbox.x = 100

    // The baseline y should be in the range (pageH - bbox.y - height .. pageH - bbox.y):
    // baselineY = vh - bbox.y - textHeight * sy * (1 - descentRatio)
    // = 842 - 50 - 24 * (200/textWidth) * (1 - dr) ≈ somewhere in [768, 792].
    const ty = translatesNoOffset[0].f;
    expect(ty).toBeGreaterThan(PAGE_H - doc.pages.get(0)!.textBlocks[0].bbox.y - 50);
    expect(ty).toBeLessThan(PAGE_H - doc.pages.get(0)!.textBlocks[0].bbox.y);
  }, 60_000);

  it('dx=0, dy=0 を明示指定したとき offset なしと translate が一致する', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const originalBytes = await makeMinimalPdf(PAGE_W, PAGE_H);
    const doc = makeDocWithHorizontalBlock(PAGE_W, PAGE_H);

    const optionsNoOffset: SaveDialogOptions = { compression: 'none' };
    const optionsZeroOffset: SaveDialogOptions = {
      compression: 'none',
      textLayerOffsetPt: { dx: 0, dy: 0 },
    };

    const savedNoOffset = await buildPdfDocument(
      new Uint8Array(originalBytes),
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      optionsNoOffset,
    );
    const savedZeroOffset = await buildPdfDocument(
      new Uint8Array(originalBytes),
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      optionsZeroOffset,
    );

    const textNoOffset = await decodePage0ContentText(savedNoOffset);
    const textZeroOffset = await decodePage0ContentText(savedZeroOffset);

    const translatesNoOffset = extractTranslateCms(textNoOffset);
    const translatesZeroOffset = extractTranslateCms(textZeroOffset);

    expect(translatesNoOffset.length).toBeGreaterThanOrEqual(1);
    expect(translatesZeroOffset.length).toBeGreaterThanOrEqual(1);

    expect(translatesZeroOffset[0].e).toBeCloseTo(translatesNoOffset[0].e, 2);
    expect(translatesZeroOffset[0].f).toBeCloseTo(translatesNoOffset[0].f, 2);
  }, 60_000);
});
