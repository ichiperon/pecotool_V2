import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

async function ensurePdfjsEnv(): Promise<void> {
  if (typeof (globalThis as any).ReadableStream === 'undefined') {
    const streams = await import('node:stream/web');
    (globalThis as any).ReadableStream = streams.ReadableStream;
    (globalThis as any).WritableStream = streams.WritableStream;
    (globalThis as any).TransformStream = streams.TransformStream;
  }
}

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeOriginalPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makePecoDoc(text: string): PecoDocument {
  const block: TextBlock = {
    id: 'b0',
    text,
    originalText: text,
    bbox: { x: 50, y: 100, width: 480, height: 24 },
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
    filePath: 'fallback-fonts.pdf',
    fileName: 'fallback-fonts.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

async function extractPdfjsText(bytes: Uint8Array): Promise<string> {
  await ensurePdfjsEnv();
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  const text = (textContent.items as Array<{ str?: string }>)
    .map((item) => item.str ?? '')
    .join('');
  try { await pdf.cleanup(); } catch { /* ignore */ }
  try { await pdf.destroy(); } catch { /* ignore */ }
  return text;
}

describe('pdfSaver fallback fonts', () => {
  it('IPAexGothic 未対応の記号を NULL に落とさず pdfjs で再抽出できる', async () => {
    const text = 'C₁b 5.31Ⓡ死亡 ×1)☑(+15 以上☐944.2%';
    const original = await makeOriginalPdf();
    const primaryFont = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const fallbackFonts = [
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSans-Regular.ttf')),
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSansSymbols-Regular.ttf')),
      arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/NotoSansSymbols2-Regular.ttf')),
    ];

    const saved = await buildPdfDocument(original, makePecoDoc(text), primaryFont, fallbackFonts);
    const extracted = await extractPdfjsText(saved);

    expect(extracted).not.toContain('\u0000');
    expect(extracted).toContain('₁');
    expect(extracted).toContain('Ⓡ');
    expect(extracted).toContain('☑');
    expect(extracted).toContain('☐');
  }, 60_000);
});
