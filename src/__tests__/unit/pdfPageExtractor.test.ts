import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── hoisted mocks ──────────────────────────────────────────────

const m = vi.hoisted(() => {
  // Minimal PDFPage stub
  class PDFPageStub {
    _id: number;
    constructor(id: number) { this._id = id; }
  }

  // PDFDocument stub — tracks calls and returns controllable values
  const createInstance = () => ({
    _pages: [] as PDFPageStub[],
    _srcPages: [] as PDFPageStub[],

    getPageCount() { return this._srcPages.length; },

    copyPages(_srcDoc: unknown, indices: number[]) {
      return Promise.resolve(indices.map((i) => new PDFPageStub(i)));
    },

    addPage(page: PDFPageStub) {
      this._pages.push(page);
    },

    save(_opts?: unknown) {
      // Return a minimal Uint8Array so callers can verify it is defined
      return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF"
    },
  });

  // srcDoc returned by PDFDocument.load
  const srcDocInstance = {
    ...createInstance(),
    _srcPages: [new (class P { _id = 0 })()] as unknown as [],
  } as ReturnType<typeof createInstance>;

  // Make srcDocInstance.getPageCount() return the length of its _srcPages
  // (the _srcPages array we set below)
  const srcPages: { _id: number }[] = [];
  srcDocInstance.getPageCount = () => srcPages.length;
  (srcDocInstance as unknown as { _srcPagesRef: typeof srcPages })._srcPagesRef = srcPages;

  // dstDoc returned by PDFDocument.create
  const dstDocInstance = createInstance();

  const pdfLoad = vi.fn((_bytes: unknown, _opts?: unknown) => Promise.resolve(srcDocInstance));
  const pdfCreate = vi.fn(() => Promise.resolve(dstDocInstance));

  return {
    srcDocInstance,
    dstDocInstance,
    srcPages,
    pdfLoad,
    pdfCreate,
    PDFPageStub,
  };
});

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument: {
    load: m.pdfLoad,
    create: m.pdfCreate,
  },
}));

// ── import after mocks ─────────────────────────────────────────

import { extractPagesToNewPdf } from '../../utils/pdfPageExtractor';

// ── helpers ────────────────────────────────────────────────────

function makeBytes(pageCount: number): Uint8Array {
  // Fake bytes — only the shape matters; pdf-lib.load is mocked
  return new Uint8Array(pageCount);
}

// Helper: set srcDoc page count before each test
function setSrcPageCount(n: number): void {
  m.srcPages.length = 0;
  for (let i = 0; i < n; i++) {
    m.srcPages.push({ _id: i });
  }
}

// ── tests ──────────────────────────────────────────────────────

describe('extractPagesToNewPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.dstDocInstance._pages.length = 0;
    setSrcPageCount(3);
  });

  it('extracts 2 pages out of 3 → dst has 2 pages', async () => {
    const bytes = await extractPagesToNewPdf(makeBytes(3), [0, 2]);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(m.dstDocInstance._pages).toHaveLength(2);
  });

  it('preserves the requested order ([2, 0] → pages 2 then 0)', async () => {
    await extractPagesToNewPdf(makeBytes(3), [2, 0]);

    expect(m.dstDocInstance._pages[0]).toMatchObject({ _id: 2 });
    expect(m.dstDocInstance._pages[1]).toMatchObject({ _id: 0 });
  });

  it('throws when pageIndices is empty', async () => {
    await expect(extractPagesToNewPdf(makeBytes(3), [])).rejects.toThrow(
      'pageIndices must not be empty',
    );
  });

  it('throws when an index is out of range (>= pageCount)', async () => {
    await expect(extractPagesToNewPdf(makeBytes(3), [0, 5])).rejects.toThrow(
      'out of range',
    );
  });

  it('throws when an index is negative', async () => {
    await expect(extractPagesToNewPdf(makeBytes(3), [-1])).rejects.toThrow(
      'out of range',
    );
  });

  it('calls PDFDocument.load with ignoreEncryption:true', async () => {
    await extractPagesToNewPdf(makeBytes(3), [1]);

    expect(m.pdfLoad).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ ignoreEncryption: true }),
    );
  });

  it('calls dstDoc.save with useObjectStreams:false', async () => {
    const saveSpy = vi.spyOn(m.dstDocInstance, 'save');
    await extractPagesToNewPdf(makeBytes(3), [0]);

    expect(saveSpy).toHaveBeenCalledWith({ useObjectStreams: false });
  });

  // ── wave 5 additions ────────────────────────────────────────────────────

  it('PDFDocument.load is called with throwOnInvalidObject:false (lenient parse)', async () => {
    await extractPagesToNewPdf(makeBytes(3), [0]);

    expect(m.pdfLoad).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ throwOnInvalidObject: false }),
    );
  });

  it('PDFDocument.load is called with updateMetadata:false (preserve Catalog metadata)', async () => {
    await extractPagesToNewPdf(makeBytes(3), [0]);

    expect(m.pdfLoad).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ updateMetadata: false }),
    );
  });

  it('error message for out-of-range index includes the actual index and valid range', async () => {
    setSrcPageCount(2);
    let errorMsg = '';
    try {
      await extractPagesToNewPdf(makeBytes(2), [0, 5]);
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    // Must mention the bad index and the valid upper bound
    expect(errorMsg).toContain('5');
    expect(errorMsg).toContain('out of range');
  });

  it('error message for negative index includes the negative value', async () => {
    let errorMsg = '';
    try {
      await extractPagesToNewPdf(makeBytes(3), [-3]);
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    expect(errorMsg).toContain('-3');
    expect(errorMsg).toContain('out of range');
  });

  it('all-pages extract: dst page count equals src page count', async () => {
    setSrcPageCount(4);
    await extractPagesToNewPdf(makeBytes(4), [0, 1, 2, 3]);

    expect(m.dstDocInstance._pages).toHaveLength(4);
  });

  it('single page extract: dst has exactly 1 page', async () => {
    setSrcPageCount(5);
    m.dstDocInstance._pages.length = 0;
    await extractPagesToNewPdf(makeBytes(5), [3]);

    expect(m.dstDocInstance._pages).toHaveLength(1);
    expect(m.dstDocInstance._pages[0]).toMatchObject({ _id: 3 });
  });

  it('PDFDocument.create is always called to build a fresh dst doc', async () => {
    await extractPagesToNewPdf(makeBytes(3), [1]);

    expect(m.pdfCreate).toHaveBeenCalledTimes(1);
  });

  it('returns Uint8Array that starts with %PDF magic bytes', async () => {
    const bytes = await extractPagesToNewPdf(makeBytes(3), [0]);

    // The mock save() returns [0x25, 0x50, 0x44, 0x46] = "%PDF"
    expect(bytes[0]).toBe(0x25); // %
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x44); // D
    expect(bytes[3]).toBe(0x46); // F
  });
});
