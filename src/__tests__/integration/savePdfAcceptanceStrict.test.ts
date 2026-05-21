import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import {
  ensurePdfjsEnv,
  loadFontArrayBuffer,
  reloadBBoxMetaViaPdfjs,
} from './helpers/realPdfFixtures';
import {
  __resetSaveStateForTest,
  __setSaveWorkerFactoryForTest,
  savePDF,
} from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';
import type { PecoToolBBoxMetaEntry } from '../../utils/pdfMetadataLoader';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

type StrictMetaEntry = Pick<PecoToolBBoxMetaEntry, 'text' | 'bbox' | 'writingMode' | 'order'>;

const PAGE0_SIZE = { width: 842, height: 595 };
const PAGE1_SIZE = { width: 595, height: 842 };

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

function strictEntries(blocks: TextBlock[]): StrictMetaEntry[] {
  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((block) => ({
      text: block.text,
      bbox: block.bbox,
      writingMode: block.writingMode,
      order: block.order,
    }));
}

function expectStrictMetaEntries(
  actual: PecoToolBBoxMetaEntry[] | undefined,
  expectedBlocks: TextBlock[],
): void {
  expect(actual).toEqual(strictEntries(expectedBlocks));
}

function makeBlock(overrides: Partial<TextBlock>): TextBlock {
  return {
    id: 'block',
    text: 'text',
    originalText: 'text',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
    ...overrides,
  };
}

function makePage(
  pageIndex: number,
  size: { width: number; height: number },
  textBlocks: TextBlock[],
  isDirty: boolean,
): PageData {
  return {
    pageIndex,
    width: size.width,
    height: size.height,
    textBlocks,
    isDirty,
    thumbnail: null,
  };
}

function makeDocument(
  pages: Array<[number, PageData]>,
  fileName = 'strict-acceptance.pdf',
): PecoDocument {
  return {
    filePath: fileName,
    fileName,
    totalPages: pages.length,
    metadata: {},
    pages: new Map(pages),
  };
}

async function makeTwoPagePdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page0 = pdf.addPage([PAGE0_SIZE.width, PAGE0_SIZE.height]);
  page0.drawText('landscape source page', {
    x: 24,
    y: PAGE0_SIZE.height - 40,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  const page1 = pdf.addPage([PAGE1_SIZE.width, PAGE1_SIZE.height]);
  page1.drawText('portrait source page', {
    x: 24,
    y: PAGE1_SIZE.height - 40,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function saveWithStrictFallback(source: Uint8Array, doc: PecoDocument): Promise<Uint8Array> {
  return await savePDF({ bytes: source }, doc, loadFontArrayBuffer());
}

describe('PDF/OCR save acceptance strict', () => {
  it('2ページの横/縦/空文字 OCR block の text/bbox/writingMode/order を実 PDF 保存後に完全一致で読める', async () => {
    const sourceBytes = await makeTwoPagePdfBytes();
    const page0Blocks = [
      makeBlock({
        id: 'p0-v',
        text: '縦書き',
        originalText: '縦書き',
        bbox: { x: 712.5, y: 80.25, width: 28.5, height: 156.75 },
        writingMode: 'vertical',
        order: 2,
      }),
      makeBlock({
        id: 'p0-empty',
        text: '',
        originalText: '',
        bbox: { x: 320.125, y: 210.5, width: 64.25, height: 18.75 },
        writingMode: 'horizontal',
        order: 1,
      }),
      makeBlock({
        id: 'p0-h',
        text: 'landscape horizontal',
        originalText: 'landscape horizontal',
        bbox: { x: 48.5, y: 64.25, width: 226.75, height: 24.5 },
        writingMode: 'horizontal',
        order: 0,
      }),
    ];
    const page1Blocks = [
      makeBlock({
        id: 'p1-v',
        text: 'portrait vertical',
        originalText: 'portrait vertical',
        bbox: { x: 420.5, y: 126.25, width: 32.75, height: 210.5 },
        writingMode: 'vertical',
        order: 0,
      }),
      makeBlock({
        id: 'p1-h',
        text: 'portrait horizontal',
        originalText: 'portrait horizontal',
        bbox: { x: 74.25, y: 516.5, width: 198.75, height: 22.25 },
        writingMode: 'horizontal',
        order: 1,
      }),
    ];
    const doc = makeDocument([
      [0, makePage(0, PAGE0_SIZE, page0Blocks, true)],
      [1, makePage(1, PAGE1_SIZE, page1Blocks, true)],
    ]);

    const saved = await saveWithStrictFallback(sourceBytes, doc);
    const { meta, totalPages } = await reloadBBoxMetaViaPdfjs(saved);

    expect(totalPages).toBe(2);
    expect(meta).not.toBeNull();
    expectStrictMetaEntries(meta?.['0'], page0Blocks);
    expectStrictMetaEntries(meta?.['1'], page1Blocks);
  }, 60_000);

  it('初回保存後に page0 だけ dirty 再保存して page1 の既存 OCR メタを維持する', async () => {
    const sourceBytes = await makeTwoPagePdfBytes();
    const firstPage0Blocks = [
      makeBlock({
        id: 'p0-first',
        text: 'first page zero',
        originalText: 'first page zero',
        bbox: { x: 42, y: 70, width: 180, height: 24 },
        writingMode: 'horizontal',
        order: 0,
      }),
    ];
    const firstPage1Blocks = [
      makeBlock({
        id: 'p1-keep-v',
        text: '維持する縦書き',
        originalText: '維持する縦書き',
        bbox: { x: 460.5, y: 90.75, width: 26.25, height: 160.5 },
        writingMode: 'vertical',
        order: 0,
      }),
      makeBlock({
        id: 'p1-keep-h',
        text: '',
        originalText: '',
        bbox: { x: 82.25, y: 396.5, width: 90.75, height: 21.25 },
        writingMode: 'horizontal',
        order: 1,
      }),
    ];
    const firstDoc = makeDocument([
      [0, makePage(0, PAGE0_SIZE, firstPage0Blocks, true)],
      [1, makePage(1, PAGE1_SIZE, firstPage1Blocks, true)],
    ]);
    const savedOnce = await saveWithStrictFallback(sourceBytes, firstDoc);
    const savedOnceMeta = await reloadBBoxMetaViaPdfjs(savedOnce);
    expectStrictMetaEntries(savedOnceMeta.meta?.['1'], firstPage1Blocks);

    const secondPage0Blocks = [
      makeBlock({
        id: 'p0-second-v',
        text: 'page zero rewritten',
        originalText: 'page zero rewritten',
        bbox: { x: 640.25, y: 120.5, width: 30.25, height: 175.75 },
        writingMode: 'vertical',
        order: 0,
      }),
    ];
    const ignoredPage1Blocks = [
      makeBlock({
        id: 'p1-ignored',
        text: 'this non-dirty page data must not replace saved meta',
        originalText: 'this non-dirty page data must not replace saved meta',
        bbox: { x: 1, y: 2, width: 3, height: 4 },
        writingMode: 'horizontal',
        order: 0,
        isDirty: false,
      }),
    ];
    const secondDoc = makeDocument([
      [0, makePage(0, PAGE0_SIZE, secondPage0Blocks, true)],
      [1, makePage(1, PAGE1_SIZE, ignoredPage1Blocks, false)],
    ]);

    const savedTwice = await saveWithStrictFallback(savedOnce, secondDoc);
    const { meta, totalPages } = await reloadBBoxMetaViaPdfjs(savedTwice);

    expect(totalPages).toBe(2);
    expect(meta).not.toBeNull();
    expectStrictMetaEntries(meta?.['0'], secondPage0Blocks);
    expectStrictMetaEntries(meta?.['1'], firstPage1Blocks);
  }, 60_000);
});
