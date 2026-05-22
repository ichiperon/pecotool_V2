import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflate } from 'pako';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import {
  hasLegacyPecoToolBBoxInfo,
  readPecoToolBBoxMetaFromPdfDoc,
} from '../../utils/pdfPecoToolMetadata';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import {
  buildPecoDocumentFromRealPdf,
  ensurePdfjsEnv,
  freshCopy,
  loadFallbackFontArrayBuffers,
  loadFontArrayBuffer,
} from './helpers/realPdfFixtures';

const TJ_REPRO_PDF = resolve(process.cwd(), 'test/tj/P291-310.pdf');
const TJ_REPAIRED_PDF = resolve(process.cwd(), 'test/tj/P291-310_tj_repaired.pdf');
const hasTjReproPdf = existsSync(TJ_REPRO_PDF);

const textOnlyOperators = new Set([
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"',
]);

function isWhite(b: number | undefined): boolean {
  return b === undefined || b <= 0x20;
}

function isDelimiter(b: number | undefined): boolean {
  return (
    b === undefined ||
    b <= 0x20 ||
    b === 0x28 ||
    b === 0x29 ||
    b === 0x3c ||
    b === 0x3e ||
    b === 0x5b ||
    b === 0x5d ||
    b === 0x7b ||
    b === 0x7d ||
    b === 0x2f ||
    b === 0x25
  );
}

function tokenAt(data: Uint8Array, i: number, token: string): boolean {
  for (let j = 0; j < token.length; j++) {
    if (data[i + j] !== token.charCodeAt(j)) return false;
  }
  return isDelimiter(i === 0 ? undefined : data[i - 1]) && isDelimiter(data[i + token.length]);
}

function skipLiteralString(data: Uint8Array, i: number): number {
  let depth = 1;
  i += 1;
  while (i < data.length) {
    const b = data[i];
    if (b === 0x5c) {
      i += i + 1 < data.length ? 2 : 1;
      continue;
    }
    if (b === 0x28) depth += 1;
    if (b === 0x29) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipHexStringOrDict(data: Uint8Array, i: number): number {
  if (data[i + 1] === 0x3c) {
    i += 2;
    while (i + 1 < data.length) {
      if (data[i] === 0x3e && data[i + 1] === 0x3e) return i + 2;
      i += 1;
    }
    return data.length;
  }
  i += 1;
  while (i < data.length) {
    if (data[i] === 0x3e) return i + 1;
    i += 1;
  }
  return i;
}

function skipArray(data: Uint8Array, i: number): number {
  let depth = 1;
  i += 1;
  while (i < data.length) {
    if (data[i] === 0x28) {
      i = skipLiteralString(data, i);
      continue;
    }
    if (data[i] === 0x3c) {
      i = skipHexStringOrDict(data, i);
      continue;
    }
    if (data[i] === 0x5b) depth += 1;
    if (data[i] === 0x5d) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipInlineImage(data: Uint8Array, i: number): number {
  let inImageData = false;
  while (i < data.length) {
    if (!inImageData && tokenAt(data, i, 'ID')) {
      i += 2;
      inImageData = true;
      continue;
    }
    if (inImageData && tokenAt(data, i, 'EI')) return i + 2;
    i += 1;
  }
  return i;
}

function decodePageContents(doc: PDFDocument, pageIndex: number): Uint8Array {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const resolved = doc.context.lookup(contents);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [contents];
  const chunks: Uint8Array[] = [];

  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      chunks.push(inflate(stream.getContents()));
    } else if (!filter) {
      chunks.push(stream.getContents());
    }
    chunks.push(new Uint8Array([0x0a]));
  }

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function findBrokenContentRefs(doc: PDFDocument): string[] {
  const broken: string[] = [];

  for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex++) {
    const page = doc.getPage(pageIndex);
    const contents = page.node.Contents();
    const resolved = doc.context.lookup(contents);
    const refs = resolved instanceof PDFArray ? resolved.asArray() : [contents];

    for (const ref of refs) {
      if (!(doc.context.lookup(ref) instanceof PDFRawStream)) {
        broken.push(`page ${pageIndex + 1}: ${String(ref)}`);
      }
    }
  }

  return broken;
}

function findControlCharsInBBoxMeta(doc: PDFDocument): string[] {
  expect(hasLegacyPecoToolBBoxInfo(doc)).toBe(false);
  const meta = readPecoToolBBoxMetaFromPdfDoc(doc) as Record<string, Array<{ text?: string; order?: number }>>;
  const violations: string[] = [];
  for (const [pageIndex, blocks] of Object.entries(meta)) {
    for (const block of blocks) {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(block.text ?? '')) {
        violations.push(`page ${Number(pageIndex) + 1} order ${block.order}`);
      }
    }
  }
  return violations;
}

async function findControlCharsInPdfjsText(pdfBytes: Uint8Array): Promise<string[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsDoc = await pdfjsLib.getDocument({
    data: freshCopy(pdfBytes),
    disableWorker: true,
  }).promise;
  const violations: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdfjsDoc.numPages; pageNumber++) {
    const page = await pdfjsDoc.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: false });
    const text = textContent.items
      .filter((item) => 'str' in item && typeof item.str === 'string')
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      violations.push(`page ${pageNumber}`);
    }
  }

  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
  return violations;
}

function findTextOperatorViolations(data: Uint8Array): string[] {
  const decoder = new TextDecoder('latin1');
  const violations: string[] = [];
  let i = 0;
  let textDepth = 0;

  while (i < data.length) {
    while (i < data.length && isWhite(data[i])) i += 1;
    if (i >= data.length) break;

    const b = data[i];
    if (b === 0x25) {
      while (i < data.length && data[i] !== 0x0a && data[i] !== 0x0d) i += 1;
      continue;
    }
    if (b === 0x28) {
      i = skipLiteralString(data, i);
      continue;
    }
    if (b === 0x3c) {
      i = skipHexStringOrDict(data, i);
      continue;
    }
    if (b === 0x5b) {
      i = skipArray(data, i);
      continue;
    }
    if (b === 0x2f) {
      i += 1;
      while (i < data.length && !isDelimiter(data[i])) i += 1;
      continue;
    }

    const start = i;
    while (i < data.length && !isDelimiter(data[i])) i += 1;
    if (i === start) {
      i += 1;
      continue;
    }

    const token = decoder.decode(data.slice(start, i));
    if (token === 'BI') {
      i = skipInlineImage(data, start);
      continue;
    }
    if (token === 'BT') textDepth += 1;
    if (token === 'ET') {
      if (textDepth === 0) violations.push(`ET outside text object at ${start}`);
      else textDepth -= 1;
    }
    if (textOnlyOperators.has(token) && token !== 'ET' && textDepth === 0) {
      violations.push(`${token} outside text object at ${start}`);
    }
  }

  if (textDepth !== 0) violations.push(`unclosed BT depth=${textDepth}`);
  return violations;
}

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

describe.skipIf(!hasTjReproPdf)('TJ/T* Acrobat regression PDF', () => {
  it('P291-310.pdf の BT 外 TL/T*/Tf が保存後に除去される', async () => {
    const original = new Uint8Array(readFileSync(TJ_REPRO_PDF));
    const originalDoc = await PDFDocument.load(freshCopy(original), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(findTextOperatorViolations(decodePageContents(originalDoc, 0))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TL outside text object'),
        expect.stringContaining('T* outside text object'),
        expect.stringContaining('Tf outside text object'),
      ]),
    );

    const { doc } = await buildPecoDocumentFromRealPdf(original, TJ_REPRO_PDF);
    let skippedChars: import('../../utils/pdfWorkerTypes').SkippedPdfTextChar[] = [];
    const saved = await savePDF(
      { bytes: freshCopy(original) },
      doc,
      loadFontArrayBuffer(),
      loadFallbackFontArrayBuffers(),
      (chars) => { skippedChars = chars; },
    );
    writeFileSync(TJ_REPAIRED_PDF, saved);
    expect(skippedChars).toContainEqual(expect.objectContaining({
      codePoint: 'U+0000',
      reason: 'control-character',
    }));

    const savedDoc = await PDFDocument.load(freshCopy(saved), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    for (let pageIndex = 0; pageIndex < savedDoc.getPageCount(); pageIndex++) {
      expect(findTextOperatorViolations(decodePageContents(savedDoc, pageIndex))).toEqual([]);
    }
    expect(findBrokenContentRefs(savedDoc)).toEqual([]);
    expect(new TextDecoder('latin1').decode(decodePageContents(savedDoc, 2))).toContain('/Im0 Do');
    expect(findControlCharsInBBoxMeta(savedDoc)).toEqual([]);
    expect(await findControlCharsInPdfjsText(saved)).toEqual([]);
  }, 300_000);

  it('P291-310.pdf は未編集の別名保存でも既存メタから修復される', async () => {
    const original = new Uint8Array(readFileSync(TJ_REPRO_PDF));
    const { doc } = await buildPecoDocumentFromRealPdf(original, TJ_REPRO_PDF);
    const saved = await savePDF(
      { bytes: freshCopy(original) },
      { ...doc, pages: new Map() },
      loadFontArrayBuffer(),
      loadFallbackFontArrayBuffers(),
    );

    const savedDoc = await PDFDocument.load(freshCopy(saved), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(findTextOperatorViolations(decodePageContents(savedDoc, 0))).toEqual([]);
    expect(findTextOperatorViolations(decodePageContents(savedDoc, 2))).toEqual([]);
    expect(findBrokenContentRefs(savedDoc)).toEqual([]);
    expect(findControlCharsInBBoxMeta(savedDoc)).toEqual([]);
  }, 300_000);
});
