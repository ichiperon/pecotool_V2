/**
 * PCT-107 (P1, axis #5): Direction verification of the OCR text-layer offset
 * across page rotations (0/90/180/270) and writing modes (horizontal/vertical).
 *
 * What this guards
 * ----------------
 * The save path applies the position correction offset *inside* the
 * viewport-aligned drawing frame:
 *
 *     page.pushOperators(
 *       pushGraphicsState(),
 *       ...rotationCm,                                   // concat rotation matrix
 *       translate(origin.x + dx, origin.y - dy),         // viewport-space shift
 *       scale(sx, sy),
 *     );
 *
 * Because `rotationCm` is concatenated BEFORE the translate, the translate
 * vector (dx, -dy) is expressed in the viewport (rotated screen, y-down) frame.
 * The claim under test: regardless of page rotation or writing mode, an offset
 * of (dx>0, dy>0) must move the rendered text-layer origin toward the
 * **display right and display down** ("screen right/down").
 *
 * How direction is verified
 * --------------------------
 * The PDF content stream emits the rotation as a `cm` (concat) operator, then a
 * separate translate `1 0 0 1 tx ty cm`. The actual user-space draw origin is:
 *
 *     userOrigin = rotationMatrix * (translateVector)            (affine)
 *
 * So we:
 *   1. Save with no offset → extract (rotationCm, translateCm) → compute
 *      userOrigin_base.
 *   2. Save with offset (dx, dy) → compute userOrigin_shifted.
 *   3. delta_user = userOrigin_shifted - userOrigin_base.
 *   4. Independently compute the user-space directions that correspond to
 *      "display right" and "display down" by mapping the viewport basis
 *      vectors through the same rotation matrix.
 *   5. Assert delta_user projects positively onto BOTH (display-right) and
 *      (display-down). A negative projection = the offset moved the text the
 *      WRONG way (left/up) for that rotation → an inversion bug (P0 candidate).
 *
 * Mapping viewport basis → user space
 * -----------------------------------
 * Viewport is rotated-screen, y-DOWN. The translate y already encodes "down" as
 * "-dy" (PDF user y-up convention inside the frame). So within the translate
 * frame:
 *   - "display right" basis = (+1, 0)
 *   - "display down"  basis = (0, -1)
 * Mapping each through the rotation matrix linear part [a c; b d] gives the
 * user-space direction of display-right / display-down for that rotation.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { getRotationCm } from '../../utils/pdfSaverCore';
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
// Fixture / decode helpers (mirrors pdfTextLayerOffset.test.ts)
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
  const rawContents =
    page.node.get(PDFName.of('Contents')) ??
    (page.node as unknown as { Contents?(): unknown }).Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(
    rawContents as Parameters<typeof doc.context.lookup>[0],
  );
  const streams =
    resolved instanceof PDFArray
      ? resolved.asArray()
      : [rawContents as Parameters<typeof doc.context.lookup>[0]];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(
      streamRef as Parameters<typeof doc.context.lookup>[0],
    );
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

interface CmOp {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Extract all `cm` operators from a content-stream string in document order. */
function extractCmOperands(text: string): CmOp[] {
  const re =
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: CmOp[] = [];
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

/** A pure-translation cm (a=1,b=0,c=0,d=1, e/f free). */
function isTranslateCm(m: CmOp): boolean {
  return (
    Math.abs(m.a - 1) < 1e-6 &&
    Math.abs(m.b) < 1e-6 &&
    Math.abs(m.c) < 1e-6 &&
    Math.abs(m.d - 1) < 1e-6
  );
}

/** First pure-translation cm's (e, f) = the per-block draw frame origin. */
function firstTranslate(text: string): { e: number; f: number } {
  const t = extractCmOperands(text).filter(isTranslateCm);
  if (t.length === 0) throw new Error('no translate cm found in content stream');
  return { e: t[0].e, f: t[0].f };
}

/**
 * Apply a 2D affine matrix [a b c d e f] (PDF cm convention) to a point.
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
function applyMatrixPoint(
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** Apply only the linear part (rotation/scale, ignore translation) to a vector. */
function applyMatrixVector(
  m: { a: number; b: number; c: number; d: number },
  vx: number,
  vy: number,
): { x: number; y: number } {
  return { x: m.a * vx + m.c * vy, y: m.b * vx + m.d * vy };
}

type Rotation = 0 | 90 | 180 | 270;
type Writing = 'horizontal' | 'vertical';

/** rotationCm for a rotation, as a single matrix object (identity for R=0). */
function rotationMatrix(
  rotation: Rotation,
  pageW: number,
  pageH: number,
): CmOp {
  const cm = getRotationCm(rotation, pageW, pageH) as ReadonlyArray<unknown>;
  if (cm.length === 0) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  // getRotationCm returns concatTransformationMatrix(...) operator objects.
  // Re-derive the matrix from the known closed form so we do not depend on the
  // operator object's internal shape. This mirrors getRotationCm exactly.
  switch (rotation) {
    case 90:
      return { a: 0, b: 1, c: -1, d: 0, e: pageW, f: 0 };
    case 180:
      return { a: -1, b: 0, c: 0, d: -1, e: pageW, f: pageH };
    case 270:
      return { a: 0, b: -1, c: 1, d: 0, e: 0, f: pageH };
    default:
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
}

function makeDoc(
  pageW: number,
  pageH: number,
  rotation: Rotation,
  writingMode: Writing,
): PecoDocument {
  const block: TextBlock = {
    id: 'blk-0',
    text: 'テスト文字',
    originalText: 'テスト文字',
    bbox: { x: 100, y: 50, width: 200, height: 24 },
    writingMode,
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
    rotation,
  };
  return {
    filePath: 'rot-offset.pdf',
    fileName: 'rot-offset.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/**
 * Save once with no offset and once with the given offset; return the
 * user-space delta of the first text-block draw origin between the two.
 *
 * userOrigin = rotationMatrix applied to (translate e/f point).
 */
async function measureUserSpaceDelta(
  pageW: number,
  pageH: number,
  rotation: Rotation,
  writingMode: Writing,
  offset: { dx: number; dy: number },
  fontBytes: ArrayBuffer,
): Promise<{ dxUser: number; dyUser: number }> {
  const originalBytes = await makeMinimalPdf(pageW, pageH);
  const doc = makeDoc(pageW, pageH, rotation, writingMode);
  const rm = rotationMatrix(rotation, pageW, pageH);

  const savedBase = await buildPdfDocument(
    new Uint8Array(originalBytes),
    doc,
    fontBytes,
    [],
    undefined,
    undefined,
    { compression: 'none' } as SaveDialogOptions,
  );
  const savedShifted = await buildPdfDocument(
    new Uint8Array(originalBytes),
    doc,
    fontBytes,
    [],
    undefined,
    undefined,
    { compression: 'none', textLayerOffsetPt: offset } as SaveDialogOptions,
  );

  const baseTr = firstTranslate(await decodePage0ContentText(savedBase));
  const shiftTr = firstTranslate(await decodePage0ContentText(savedShifted));

  const baseUser = applyMatrixPoint(rm, baseTr.e, baseTr.f);
  const shiftUser = applyMatrixPoint(rm, shiftTr.e, shiftTr.f);

  return { dxUser: shiftUser.x - baseUser.x, dyUser: shiftUser.y - baseUser.y };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PCT-107: text-layer offset direction across rotation & writing mode', () => {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const OFFSET = { dx: 11.34, dy: 5.67 }; // 4mm right, 2mm down (point)
  const EPS = 1e-3;

  /**
   * For each rotation, the user-space directions of "display right" and
   * "display down". Inside the translate frame, display-right basis = (+1, 0)
   * and display-down basis = (0, -1) (viewport y-down → translate y-up
   * convention). Mapped through the rotation linear part.
   */
  function displayDirs(rotation: Rotation): {
    right: { x: number; y: number };
    down: { x: number; y: number };
  } {
    const rm = rotationMatrix(rotation, PAGE_W, PAGE_H);
    return {
      right: applyMatrixVector(rm, 1, 0),
      down: applyMatrixVector(rm, 0, -1),
    };
  }

  const rotations: Rotation[] = [0, 90, 180, 270];
  const writingModes: Writing[] = ['horizontal', 'vertical'];

  // Full matrix: horizontal × all rotations; vertical × R=0 (minimum) + the
  // remaining vertical rotations for completeness.
  const cases: Array<{ rotation: Rotation; writingMode: Writing }> = [];
  for (const writingMode of writingModes) {
    for (const rotation of rotations) {
      cases.push({ rotation, writingMode });
    }
  }

  for (const { rotation, writingMode } of cases) {
    it(`R=${rotation} × ${writingMode}: offset (右4mm,下2mm) が表示右下方向へ一貫して乗る`, async () => {
      const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
      const { dxUser, dyUser } = await measureUserSpaceDelta(
        PAGE_W,
        PAGE_H,
        rotation,
        writingMode,
        OFFSET,
        fontBytes,
      );

      const { right, down } = displayDirs(rotation);

      // Project the user-space delta onto display-right and display-down axes.
      const projRight = dxUser * right.x + dyUser * right.y;
      const projDown = dxUser * down.x + dyUser * down.y;

      // Expected magnitudes: projection onto display-right ≈ dx, onto
      // display-down ≈ dy (rotation matrices are orthonormal, basis vectors
      // are unit length). Both MUST be positive (toward right & down).
      const inverted =
        projRight < -EPS || projDown < -EPS;

      if (inverted) {
        // Make the failure loud and actionable for the P0-escalation call.
        throw new Error(
          `INVERSION DETECTED at R=${rotation} ${writingMode}: ` +
            `projRight=${projRight.toFixed(4)} (want ≈ +${OFFSET.dx}), ` +
            `projDown=${projDown.toFixed(4)} (want ≈ +${OFFSET.dy}). ` +
            `delta_user=(${dxUser.toFixed(4)}, ${dyUser.toFixed(4)}). ` +
            `Offset moved the text toward display ` +
            `${projRight < 0 ? 'LEFT' : 'right'}/${projDown < 0 ? 'UP' : 'down'}.`,
        );
      }

      // Direction (sign) — the core PCT-107 assertion.
      expect(projRight, `display-right projection at R=${rotation} ${writingMode}`).toBeGreaterThan(0);
      expect(projDown, `display-down projection at R=${rotation} ${writingMode}`).toBeGreaterThan(0);

      // Magnitude (should match the requested offset within tolerance, since
      // rotationCm is orthonormal — confirms no scale leakage on the offset).
      expect(projRight).toBeCloseTo(OFFSET.dx, 1);
      expect(projDown).toBeCloseTo(OFFSET.dy, 1);
    }, 60_000);
  }

  it('offset=0 のとき全回転・全書字方向で user-space 位置が不変', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    for (const writingMode of writingModes) {
      for (const rotation of rotations) {
        const { dxUser, dyUser } = await measureUserSpaceDelta(
          PAGE_W,
          PAGE_H,
          rotation,
          writingMode,
          { dx: 0, dy: 0 },
          fontBytes,
        );
        expect(Math.abs(dxUser)).toBeLessThan(EPS);
        expect(Math.abs(dyUser)).toBeLessThan(EPS);
      }
    }
  }, 120_000);
});
