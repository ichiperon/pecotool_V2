/**
 * 実 PDF に Acrobat 互換性事故の再現断片を混ぜ、保存後の content stream を機械監査する。
 *
 * シナリオ:
 *   AC-1: 実PDFの1ページ目へ BT 外 Tj/TJ/ET と inline image 内 BT/ET を注入し、
 *         savePDF 後に不正 text-show と operand 不足が残らないこと。
 *   AC-2: 実PDFを保存後、pdfjs で 1→2→1 の順に page/operator/text を取得でき、
 *         1ページ目が空扱いにならないこと。
 *   AC-3: dirty page / non-dirty page 混在で、dirty page だけ content が変わり、
 *         non-dirty page の content が維持されること。
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfAcrobatCompatScenarios.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject } from '@cantoo/pdf-lib';

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
import type { TextBlock } from '../../types';
import {
  decodePageContents,
  findInputPdf,
  freshCopy,
  loadFontArrayBuffer,
  buildPecoDocumentFromRealPdf,
  ensurePdfjsEnv,
  outputPath,
} from './helpers/realPdfFixtures';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_INJECTED = outputPath(REAL_PDF_PATH, '_acrobat_compat_injected_input');
const OUT_REPAIRED = outputPath(REAL_PDF_PATH, '_acrobat_compat_repaired');
const OUT_DIRTY_MIXED = outputPath(REAL_PDF_PATH, '_dirty_mixed');

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

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

function skipHexStringOrDict(data: Uint8Array, i: number): { next: number; operand: boolean } {
  if (data[i + 1] === 0x3c) {
    i += 2;
    while (i + 1 < data.length) {
      if (data[i] === 0x3e && data[i + 1] === 0x3e) return { next: i + 2, operand: true };
      i += 1;
    }
    return { next: data.length, operand: true };
  }
  i += 1;
  while (i < data.length) {
    if (data[i] === 0x3e) return { next: i + 1, operand: true };
    i += 1;
  }
  return { next: i, operand: true };
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
      i = skipHexStringOrDict(data, i).next;
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

function skipComment(data: Uint8Array, i: number): number {
  while (i < data.length && data[i] !== 0x0a && data[i] !== 0x0d) i += 1;
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

interface StreamAudit {
  violations: string[];
  operatorCount: number;
}

function auditContentStream(data: Uint8Array, pageIndex: number): StreamAudit {
  const violations: string[] = [];
  const minOperands = new Map<string, number>([
    ['cm', 6], ['Tf', 2], ['Tr', 1], ['Tm', 6], ['Td', 2], ['TD', 2],
    ['Tj', 1], ['TJ', 1], ['Do', 1], ['gs', 1], ['rg', 3], ['RG', 3],
    ['g', 1], ['G', 1], ['k', 4], ['K', 4], ['w', 1], ['J', 1],
    ['j', 1], ['M', 1], ['d', 2], ['m', 2], ['l', 2], ['c', 6],
    ['v', 4], ['y', 4], ['re', 4],
  ]);
  const zeroOperandOperators = new Set(['q', 'Q', 'BT', 'ET', 'S', 's', 'f', 'F', 'f*', 'n', 'W', 'W*', 'B', 'B*', 'b', 'b*', 'h']);

  let i = 0;
  let operandCount = 0;
  let operatorCount = 0;
  let textDepth = 0;
  let graphicsDepth = 0;

  while (i < data.length) {
    while (i < data.length && isWhite(data[i])) i += 1;
    if (i >= data.length) break;

    const b = data[i];
    if (b === 0x25) {
      i = skipComment(data, i);
      continue;
    }
    if (b === 0x28) {
      i = skipLiteralString(data, i);
      operandCount += 1;
      continue;
    }
    if (b === 0x3c) {
      const skipped = skipHexStringOrDict(data, i);
      i = skipped.next;
      if (skipped.operand) operandCount += 1;
      continue;
    }
    if (b === 0x5b) {
      i = skipArray(data, i);
      operandCount += 1;
      continue;
    }
    if (b === 0x2f) {
      i += 1;
      while (i < data.length && !isDelimiter(data[i])) i += 1;
      operandCount += 1;
      continue;
    }

    const start = i;
    while (i < data.length && !isDelimiter(data[i])) i += 1;
    if (i === start) {
      i += 1;
      continue;
    }
    const token = new TextDecoder('latin1').decode(data.slice(start, i));

    if (token === 'BI') {
      i = skipInlineImage(data, start);
      operandCount = 0;
      operatorCount += 1;
      continue;
    }

    if (token === 'BT') textDepth += 1;
    if (token === 'ET') {
      if (textDepth === 0) violations.push(`page ${pageIndex}: ET outside text object at ${start}`);
      else textDepth -= 1;
    }
    if ((token === 'Tj' || token === 'TJ') && textDepth === 0) {
      violations.push(`page ${pageIndex}: ${token} outside text object at ${start}`);
    }
    if (token === 'q') graphicsDepth += 1;
    if (token === 'Q') {
      graphicsDepth -= 1;
      if (graphicsDepth < 0) {
        violations.push(`page ${pageIndex}: Q without matching q at ${start}`);
        graphicsDepth = 0;
      }
    }

    const required = minOperands.get(token);
    if (required !== undefined && operandCount < required) {
      violations.push(`page ${pageIndex}: ${token} has ${operandCount}/${required} operands at ${start}`);
    }
    if (required !== undefined || zeroOperandOperators.has(token)) {
      operatorCount += 1;
      operandCount = 0;
    } else {
      operandCount += 1;
    }
  }

  if (textDepth !== 0) violations.push(`page ${pageIndex}: unclosed BT depth=${textDepth}`);
  return { violations, operatorCount };
}

async function auditPdfBytes(bytes: Uint8Array): Promise<{ violations: string[]; auditedPages: number; operatorCount: number }> {
  const pdfDoc = await PDFDocument.load(freshCopy(bytes), {
    throwOnInvalidObject: false,
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const violations: string[] = [];
  let auditedPages = 0;
  let operatorCount = 0;
  for (let i = 0; i < pdfDoc.getPages().length; i++) {
    const decoded = decodePageContents(pdfDoc, i);
    if (!decoded) continue;
    const audit = auditContentStream(decoded, i);
    violations.push(...audit.violations);
    operatorCount += audit.operatorCount;
    auditedPages += 1;
  }
  return { violations, auditedPages, operatorCount };
}

async function injectAcrobatErrorFragments(realBytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(freshCopy(realBytes), {
    throwOnInvalidObject: false,
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const injected = latin1Bytes(
    [
      'q',
      ') Tj ET',
      '(leaked) Tj',
      '[(array) 120 (text)] TJ',
      'BI /W 2 /H 2 /CS /RGB /BPC 8 ID abc BT image ET ) Tj [(x)] TJ xyz EI',
      'Q',
    ].join('\n'),
  );
  const injectedRef = doc.context.register(doc.context.flateStream(injected));
  const contents = page.node.Contents();
  const resolved = contents ? doc.context.lookup(contents) : undefined;
  const refs: PDFObject[] = resolved instanceof PDFArray
    ? resolved.asArray()
    : contents
      ? [contents]
      : [];
  page.node.set(PDFName.of('Contents'), doc.context.obj([...refs, injectedRef]));
  return await doc.save({ useObjectStreams: false, addDefaultPage: false });
}

function markOnlyPage0Dirty(doc: Awaited<ReturnType<typeof buildPecoDocumentFromRealPdf>>['doc']): void {
  for (const [pageIndex, pageData] of doc.pages.entries()) {
    if (pageIndex !== 0) {
      doc.pages.set(pageIndex, {
        ...pageData,
        isDirty: false,
        textBlocks: pageData.textBlocks.map((b) => ({ ...b, isDirty: false })),
      });
      continue;
    }
    const changed = pageData.textBlocks.map((b, idx): TextBlock => {
      if (idx !== 0) return { ...b, isDirty: false };
      return {
        ...b,
        text: `${b.text}#dirty-page-0`,
        bbox: { ...b.bbox, x: b.bbox.x + 1, y: b.bbox.y + 1 },
        isDirty: true,
      };
    });
    doc.pages.set(pageIndex, { ...pageData, isDirty: true, textBlocks: changed });
  }
}

async function assertPdfjsPageRoundtrip(bytes: Uint8Array): Promise<void> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsDoc = await pdfjsLib.getDocument({
    data: freshCopy(bytes),
    disableWorker: true,
    disableFontFace: true,
  }).promise;
  try {
    const sequence = [1, Math.min(2, pdfjsDoc.numPages), 1];
    for (const pageNo of sequence) {
      const page = await pdfjsDoc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 0.25 });
      const operatorList = await page.getOperatorList();
      const textContent = await page.getTextContent();
      expect(viewport.width).toBeGreaterThan(0);
      expect(viewport.height).toBeGreaterThan(0);
      expect(
        operatorList.fnArray.length + textContent.items.length,
        `page ${pageNo} should not be structurally blank`,
      ).toBeGreaterThan(0);
      try { page.cleanup(); } catch { /* ignore */ }
    }
  } finally {
    try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
  }
}

describe.skipIf(!hasRealPdf)('REAL PDF Acrobat 互換性追加シナリオ (AC)', () => {
  it('AC-1: 壊れた Tj/TJ/ET 断片を実PDFへ注入しても保存後 content stream 監査が通る', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const injectedBytes = await injectAcrobatErrorFragments(realBytes);
    writeFileSync(OUT_INJECTED, injectedBytes);

    const beforeAudit = await auditPdfBytes(injectedBytes);
    expect(beforeAudit.violations.some((v) => v.includes('outside text object'))).toBe(true);

    const { doc } = await buildPecoDocumentFromRealPdf(injectedBytes, REAL_PDF_PATH);
    const saved = await savePDF({ bytes: freshCopy(injectedBytes) }, doc, loadFontArrayBuffer());
    writeFileSync(OUT_REPAIRED, saved);

    const afterAudit = await auditPdfBytes(saved);
    expect(afterAudit.auditedPages).toBeGreaterThan(0);
    expect(afterAudit.operatorCount).toBeGreaterThan(0);
    expect(afterAudit.violations).toEqual([]);
  }, 900_000);

  it('AC-2: 保存後PDFを pdfjs で 1→2→1 の順に開き直しても1ページ目が空扱いにならない', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    const saved = await savePDF({ bytes: freshCopy(realBytes) }, doc, loadFontArrayBuffer());

    await assertPdfjsPageRoundtrip(saved);
  }, 900_000);

  it('AC-3: dirty page / non-dirty page 混在保存で dirty page だけ content stream が変わる', async () => {
    const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
    const { doc } = await buildPecoDocumentFromRealPdf(realBytes, REAL_PDF_PATH);
    expect(doc.totalPages).toBeGreaterThan(1);
    markOnlyPage0Dirty(doc);

    const saved = await savePDF({ bytes: freshCopy(realBytes) }, doc, loadFontArrayBuffer());
    writeFileSync(OUT_DIRTY_MIXED, saved);

    const originalDoc = await PDFDocument.load(freshCopy(realBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(freshCopy(saved), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const originalPage0 = decodePageContents(originalDoc, 0);
    const savedPage0 = decodePageContents(savedDoc, 0);
    const originalPage1 = decodePageContents(originalDoc, 1);
    const savedPage1 = decodePageContents(savedDoc, 1);

    expect(originalPage0).not.toBeNull();
    expect(savedPage0).not.toBeNull();
    expect(originalPage1).not.toBeNull();
    expect(savedPage1).not.toBeNull();
    expect(Buffer.compare(Buffer.from(originalPage0!), Buffer.from(savedPage0!))).not.toBe(0);
    expect(Buffer.compare(Buffer.from(originalPage1!), Buffer.from(savedPage1!))).toBe(0);

    const audit = await auditPdfBytes(saved);
    expect(audit.violations).toEqual([]);
  }, 900_000);
});
