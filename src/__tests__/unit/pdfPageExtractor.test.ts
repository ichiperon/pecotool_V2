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
});
