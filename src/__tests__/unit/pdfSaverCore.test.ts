/**
 * Unit tests for pdfSaverCore.ts (test gap fill wave 6)
 *
 * Pure-function coverage:
 *   - bytesEqual
 *   - concatWithNewlines
 *   - decodeStreamContents (FlateDecode / no-filter / unknown-filter)
 *   - getRotationCm
 *   - normalizeRotation
 *   - getViewportSize
 *   - isRepairTextBlock
 *   - asPageIndex
 *   - sanitizeBBoxMetaTexts
 *   - splitTextBySupportedFont (primary + fallback + skip)
 *   - makeFontSupportSet
 *   - measureRuns
 *   - isPdfRef / addRefCount
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deflate } from 'pako';

// ── hoisted stubs so vi.mock can reference them ────────────────────────────────

const m = vi.hoisted(() => {
  class PDFNameStub {
    private _value: string;
    constructor(v: string) { this._value = v; }
    asString() { return this._value; }
    static of(v: string) { return new PDFNameStub('/' + v); }
    toString() { return this._value; }
  }

  class PDFArrayStub {
    private _arr: unknown[];
    constructor(arr: unknown[]) { this._arr = arr; }
    asArray() { return this._arr; }
  }

  class PDFDictStub {
    private _map: Map<string, unknown>;
    constructor(entries: [string, unknown][] = []) {
      this._map = new Map(entries);
    }
    lookup(key: PDFNameStub) { return this._map.get(key.asString()) ?? null; }
    // 実 pdf-lib の lookupMaybe(key, type) は型一致時のみ値を返すが、このスタブは
    // テスト側が正しい型の値を格納する前提で単純な map lookup として振る舞う
    // (undefined = 未登録キー、= 実装の「無ければ undefined」と同じ観測結果)。
    lookupMaybe(key: PDFNameStub, _type: unknown) { return this._map.get(key.asString()); }
    // 実 pdf-lib の PDFDict#entries() は [PDFName, PDFObject][] を返す。
    // 呼び出し側 (cleanFormXObjectsInResources / pruneStalePecoToolResources 等) は
    // key.asString() / key.toString() を呼ぶため、素の string ではなく PDFNameStub
    // でラップして返す。
    entries(): [PDFNameStub, unknown][] {
      return Array.from(this._map.entries()).map(([k, v]) => [new PDFNameStub(k), v]);
    }
    set(key: PDFNameStub, value: unknown) { this._map.set(key.asString(), value); }
    delete(key: PDFNameStub) { this._map.delete(key.asString()); }
  }

  class PDFRawStreamStub {
    dict: PDFDictStub;
    private _contents: Uint8Array;
    constructor(dict: PDFDictStub, contents: Uint8Array) {
      this.dict = dict;
      this._contents = contents;
    }
    getContents() { return this._contents; }
    updateContents(data: Uint8Array) { this._contents = data; }
  }

  // Minimal concatTransformationMatrix stub — returns a plain object
  const concatTransformationMatrix = vi.fn(
    (a: number, b: number, c: number, d: number, e: number, f: number) => ({ a, b, c, d, e, f }),
  );

  return {
    PDFName: PDFNameStub,
    PDFArray: PDFArrayStub,
    PDFDict: PDFDictStub,
    PDFRawStream: PDFRawStreamStub,
    concatTransformationMatrix,
  };
});

vi.mock('@cantoo/pdf-lib', () => ({
  PDFDocument: { prototype: { context: {} } },
  PDFName: m.PDFName,
  PDFRawStream: m.PDFRawStream,
  PDFArray: m.PDFArray,
  PDFDict: m.PDFDict,
  concatTransformationMatrix: m.concatTransformationMatrix,
}));

vi.mock('./pdfContentStream', () => ({
  stripTextBlocks: vi.fn((b: Uint8Array) => b),
  stripEmptyGraphicsStateBlocksOnly: vi.fn((b: Uint8Array) => b),
  hasTextOperatorsOutsideTextObjects: vi.fn(() => false),
  hasUnbalancedTextBlockBoundary: vi.fn(() => false),
}));

vi.mock('../../utils/pdfContentStream', () => ({
  stripTextBlocks: vi.fn((b: Uint8Array) => b),
  stripEmptyGraphicsStateBlocksOnly: vi.fn((b: Uint8Array) => b),
  hasTextOperatorsOutsideTextObjects: vi.fn(() => false),
  hasUnbalancedTextBlockBoundary: vi.fn(() => false),
}));

vi.mock('../../utils/pdfPecoToolMarkers', () => ({
  PECO_FONT_KEY_TAG: 'PecoFont',
  isPecoToolFontKey: vi.fn(() => false),
  isPecoToolGraphicsStateKey: vi.fn(() => false),
}));

vi.mock('../../utils/pdfSkippedTextChars', () => ({
  sanitizeTextForPdfCopy: vi.fn((text: string) => text),
  recordSkippedTextChar: vi.fn(),
  createSkippedTextCollector: vi.fn(() => ({ chars: [] })),
  getSkippedTextChars: vi.fn(() => []),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  bytesEqual,
  concatWithNewlines,
  decodeStreamContents,
  getRotationCm,
  normalizeRotation,
  getViewportSize,
  isRepairTextBlock,
  asPageIndex,
  sanitizeBBoxMetaTexts,
  splitTextBySupportedFont,
  makeFontSupportSet,
  measureRuns,
  isPdfRef,
  addRefCount,
  cleanContentStream,
  cleanFormXObjectsInResources,
  pruneStalePecoToolResources,
  replacePageTextContentStreams,
  pageHasTextOperatorDamage,
  collectPageContentRefCounts,
  sweepNonDirtyPage,
  findExistingFontKey,
  getOrRegisterPageFontKey,
} from '../../utils/pdfSaverCore';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStream(
  contents: Uint8Array,
  filterValue?: unknown,
): InstanceType<typeof m.PDFRawStream> {
  const dictEntries: [string, unknown][] = [];
  if (filterValue !== undefined) {
    dictEntries.push(['/Filter', filterValue]);
  }
  const dict = new m.PDFDict(dictEntries);
  return new m.PDFRawStream(dict, contents) as unknown as InstanceType<typeof m.PDFRawStream>;
}

function makeFont(
  charSet: number[] | null,
  widthPerChar = 10,
  height = 12,
): import('@cantoo/pdf-lib').PDFFont {
  return {
    getCharacterSet: charSet !== null ? () => charSet : undefined,
    widthOfTextAtSize: vi.fn((_text: string, _size: number) => _text.length * widthPerChar),
    heightAtSize: vi.fn(() => height),
  } as unknown as import('@cantoo/pdf-lib').PDFFont;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — bytesEqual', () => {
  it('returns true for identical Uint8Array values', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('returns false when lengths differ', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('returns false when contents differ', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('returns true for two empty arrays', () => {
    expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — concatWithNewlines', () => {
  it('joins chunks with 0x0a newlines and correct total length', () => {
    const a = new TextEncoder().encode('BT');
    const b = new TextEncoder().encode('ET');
    const result = concatWithNewlines([a, b]);
    // 'BT\nET\n'
    expect(result.length).toBe(2 + 1 + 2 + 1);
    expect(result[2]).toBe(0x0a);
    expect(result[5]).toBe(0x0a);
  });

  it('handles empty array gracefully (zero-length result)', () => {
    const result = concatWithNewlines([]);
    expect(result.length).toBe(0);
  });

  it('single chunk produces chunk + newline', () => {
    const chunk = new TextEncoder().encode('abc');
    const result = concatWithNewlines([chunk]);
    expect(result.length).toBe(4);
    expect(result[3]).toBe(0x0a);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — decodeStreamContents', () => {
  it('returns raw bytes when no Filter is set', () => {
    const raw = new Uint8Array([10, 20, 30]);
    const stream = makeStream(raw);
    const result = decodeStreamContents(stream as never);
    expect(result).toEqual(raw);
  });

  it('inflates FlateDecode-filtered stream', () => {
    const original = new TextEncoder().encode('BT 1 Tf ET');
    const compressed = deflate(original);
    const filter = new m.PDFName('/FlateDecode');
    const stream = makeStream(compressed, filter);
    const result = decodeStreamContents(stream as never);
    expect(result).toEqual(original);
  });

  it('returns null for corrupted FlateDecode data', () => {
    const corrupted = new Uint8Array([0xff, 0xfe, 0xfd]); // not valid deflate
    const filter = new m.PDFName('/FlateDecode');
    const stream = makeStream(corrupted, filter);
    const result = decodeStreamContents(stream as never);
    expect(result).toBeNull();
  });

  it('returns null for unsupported filter (LZWDecode)', () => {
    const raw = new Uint8Array([0xab, 0xcd]);
    const filter = new m.PDFName('/LZWDecode');
    const stream = makeStream(raw, filter);
    const result = decodeStreamContents(stream as never);
    expect(result).toBeNull();
  });

  it('returns null for multi-filter PDFArray chain', () => {
    const raw = deflate(new Uint8Array([1, 2, 3]));
    const filterArray = new m.PDFArray([new m.PDFName('/ASCII85Decode'), new m.PDFName('/FlateDecode')]);
    const stream = makeStream(raw, filterArray);
    const result = decodeStreamContents(stream as never);
    expect(result).toBeNull();
  });

  it('inflates single-element PDFArray with FlateDecode', () => {
    const original = new TextEncoder().encode('hello');
    const compressed = deflate(original);
    const filterArray = new m.PDFArray([new m.PDFName('/FlateDecode')]);
    const stream = makeStream(compressed, filterArray);
    const result = decodeStreamContents(stream as never);
    expect(result).toEqual(original);
  });

  it('returns null for a truthy Filter that is neither a PDFName nor a PDFArray', () => {
    // Defensive branch: malformed/unexpected Filter value type (e.g. a raw PDFDict).
    // Must not attempt to modify the stream — return null to skip modification.
    const raw = new Uint8Array([1, 2, 3]);
    const weirdFilter = { unexpected: true };
    const stream = makeStream(raw, weirdFilter);
    const result = decodeStreamContents(stream as never);
    expect(result).toBeNull();
  });

  it('returns raw bytes for an empty PDFArray filter (Filter=[])', () => {
    const raw = new Uint8Array([9, 8, 7]);
    const emptyFilterArray = new m.PDFArray([]);
    const stream = makeStream(raw, emptyFilterArray);
    const result = decodeStreamContents(stream as never);
    expect(result).toEqual(raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — getRotationCm', () => {
  beforeEach(() => {
    m.concatTransformationMatrix.mockClear();
  });

  it('returns empty array for rotation=0', () => {
    const result = getRotationCm(0, 595, 842);
    expect(result).toEqual([]);
  });

  it('calls concatTransformationMatrix for rotation=90', () => {
    const result = getRotationCm(90, 595, 842);
    expect(result).toHaveLength(1);
    expect(m.concatTransformationMatrix).toHaveBeenCalledWith(0, 1, -1, 0, 595, 0);
  });

  it('calls concatTransformationMatrix for rotation=180', () => {
    const result = getRotationCm(180, 595, 842);
    expect(result).toHaveLength(1);
    expect(m.concatTransformationMatrix).toHaveBeenCalledWith(-1, 0, 0, -1, 595, 842);
  });

  it('calls concatTransformationMatrix for rotation=270', () => {
    const result = getRotationCm(270, 595, 842);
    expect(result).toHaveLength(1);
    expect(m.concatTransformationMatrix).toHaveBeenCalledWith(0, -1, 1, 0, 0, 842);
  });

  it('returns empty array for unknown rotation value', () => {
    const result = getRotationCm(45, 595, 842);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — normalizeRotation', () => {
  it('keeps 0 as 0', () => expect(normalizeRotation(0)).toBe(0));
  it('keeps 90 as 90', () => expect(normalizeRotation(90)).toBe(90));
  it('keeps 270 as 270', () => expect(normalizeRotation(270)).toBe(270));
  it('normalizes 360 to 0', () => expect(normalizeRotation(360)).toBe(0));
  it('normalizes -90 to 270', () => expect(normalizeRotation(-90)).toBe(270));
  it('normalizes 450 to 90', () => expect(normalizeRotation(450)).toBe(90));
  it('rounds non-integer angle (89.9 → 90)', () => expect(normalizeRotation(89.9)).toBe(90));
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — getViewportSize', () => {
  it('rotation=0: vw=pageW, vh=pageH', () => {
    expect(getViewportSize(0, 595, 842)).toEqual({ vw: 595, vh: 842 });
  });

  it('rotation=180: vw=pageW, vh=pageH (no swap)', () => {
    expect(getViewportSize(180, 595, 842)).toEqual({ vw: 595, vh: 842 });
  });

  it('rotation=90: vw=pageH, vh=pageW (swap)', () => {
    expect(getViewportSize(90, 595, 842)).toEqual({ vw: 842, vh: 595 });
  });

  it('rotation=270: vw=pageH, vh=pageW (swap)', () => {
    expect(getViewportSize(270, 595, 842)).toEqual({ vw: 842, vh: 595 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — asPageIndex', () => {
  it('returns number from integer number', () => expect(asPageIndex(0)).toBe(0));
  it('returns number from numeric string', () => expect(asPageIndex('3')).toBe(3));
  it('returns null for float', () => expect(asPageIndex(1.5)).toBeNull());
  it('returns null for non-numeric string', () => expect(asPageIndex('abc')).toBeNull());
  it('returns null for null', () => expect(asPageIndex(null)).toBeNull());
  it('returns null for undefined', () => expect(asPageIndex(undefined)).toBeNull());
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — isRepairTextBlock', () => {
  const validBlock = {
    text: 'hello',
    order: 0,
    writingMode: 'horizontal' as const,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
  };

  it('returns true for a valid RepairTextBlock', () => {
    expect(isRepairTextBlock(validBlock)).toBe(true);
  });

  it('accepts writingMode=vertical', () => {
    expect(isRepairTextBlock({ ...validBlock, writingMode: 'vertical' })).toBe(true);
  });

  it('returns false when text is missing', () => {
    const { text: _, ...rest } = validBlock;
    expect(isRepairTextBlock(rest)).toBe(false);
  });

  it('returns false when bbox is missing', () => {
    const { bbox: _, ...rest } = validBlock;
    expect(isRepairTextBlock(rest)).toBe(false);
  });

  it('returns false when writingMode is invalid', () => {
    expect(isRepairTextBlock({ ...validBlock, writingMode: 'diagonal' })).toBe(false);
  });

  it('returns false for null', () => expect(isRepairTextBlock(null)).toBe(false));

  it('accepts optional curve field without rejecting', () => {
    const withCurve = {
      ...validBlock,
      curve: { type: 'arc', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: 1 },
    };
    expect(isRepairTextBlock(withCurve)).toBe(true);
  });

  it('accepts broken curve field without rejecting (curve validated by caller)', () => {
    const withBrokenCurve = { ...validBlock, curve: { type: 'unknown' } };
    expect(isRepairTextBlock(withBrokenCurve)).toBe(true);
  });

  it('returns false when order is not a number', () => {
    expect(isRepairTextBlock({ ...validBlock, order: '0' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — sanitizeBBoxMetaTexts', () => {
  it('returns false and does not mutate when no text changes needed', () => {
    // The vi.mock above stubs sanitizeTextForPdfCopy to return the input unchanged.
    const meta: Record<string, unknown[]> = {
      '0': [{ text: 'hello', order: 0 }],
    };
    const skipped = {} as never;
    const result = sanitizeBBoxMetaTexts(meta, skipped);
    expect(result).toBe(false);
    expect((meta['0'][0] as Record<string, unknown>).text).toBe('hello');
  });

  it('returns true and updates entries when sanitizeTextForPdfCopy returns a different string', async () => {
    const pdfSkippedModule = vi.mocked(await import('../../utils/pdfSkippedTextChars'));
    (pdfSkippedModule.sanitizeTextForPdfCopy as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => 'CLEANED');

    const meta: Record<string, unknown[]> = {
      '1': [{ text: 'dirty text', order: 0 }],
    };
    const skipped = {} as never;
    const result = sanitizeBBoxMetaTexts(meta, skipped);
    expect(result).toBe(true);
    expect((meta['1'][0] as Record<string, unknown>).text).toBe('CLEANED');
  });

  it('skips non-array page entries without throwing', () => {
    const meta = { '0': 'not-array' as unknown as never[] };
    expect(() => sanitizeBBoxMetaTexts(meta, {} as never)).not.toThrow();
  });

  it('treats a non-integer page key as normalizedPageIndex=undefined but still processes entries', async () => {
    const pdfSkippedModule = vi.mocked(await import('../../utils/pdfSkippedTextChars'));
    (pdfSkippedModule.sanitizeTextForPdfCopy as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => 'CLEANED');

    const meta: Record<string, unknown[]> = { 'abc': [{ text: 'dirty', order: 0 }] };
    const result = sanitizeBBoxMetaTexts(meta, {} as never);
    expect(result).toBe(true);
    expect(pdfSkippedModule.sanitizeTextForPdfCopy).toHaveBeenCalledWith('dirty', {}, undefined);
  });

  it('skips null/primitive array entries without throwing and reports no change', () => {
    const meta: Record<string, unknown[]> = { '0': [null, 'a raw string entry', 42] as unknown[] };
    expect(() => sanitizeBBoxMetaTexts(meta, {} as never)).not.toThrow();
    expect(sanitizeBBoxMetaTexts(meta, {} as never)).toBe(false);
  });

  it('skips entries whose text field is not a string', () => {
    const meta: Record<string, unknown[]> = { '0': [{ text: 42, order: 0 }] };
    const result = sanitizeBBoxMetaTexts(meta, {} as never);
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — makeFontSupportSet', () => {
  it('returns Set of code points when getCharacterSet exists', () => {
    const font = makeFont([65, 66, 67]); // A B C
    const set = makeFontSupportSet(font);
    expect(set).not.toBeNull();
    expect(set?.has(65)).toBe(true);
    expect(set?.has(90)).toBe(false);
  });

  it('returns null when getCharacterSet is not a function', () => {
    const font = makeFont(null);
    expect(makeFontSupportSet(font)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — splitTextBySupportedFont', () => {
  const PRIMARY_CHARS = [65, 66, 67, 68]; // A B C D
  const FALLBACK_CHARS = [69, 70, 71]; // E F G

  it('assigns all chars to primary when all are supported', () => {
    const primaryFont = makeFont(PRIMARY_CHARS);
    const primarySupport = new Set(PRIMARY_CHARS);
    const runs = splitTextBySupportedFont('ABCD', primaryFont, primarySupport, []);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('ABCD');
    expect(runs[0].font).toBe(primaryFont);
  });

  it('falls back to fallback font for unsupported chars', () => {
    const primaryFont = makeFont(PRIMARY_CHARS);
    const fallbackFont = makeFont(FALLBACK_CHARS);
    const primarySupport = new Set(PRIMARY_CHARS);
    const fallbackSupport = new Set(FALLBACK_CHARS);
    // 'A' from primary, 'E' from fallback
    const runs = splitTextBySupportedFont('AE', primaryFont, primarySupport, [
      { font: fallbackFont, support: fallbackSupport },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe('A');
    expect(runs[0].font).toBe(primaryFont);
    expect(runs[1].text).toBe('E');
    expect(runs[1].font).toBe(fallbackFont);
  });

  it('skips unsupported chars not in any fallback', () => {
    const primaryFont = makeFont(PRIMARY_CHARS);
    const primarySupport = new Set(PRIMARY_CHARS);
    // 'Z' (90) not in primary or any fallback
    const runs = splitTextBySupportedFont('AZB', primaryFont, primarySupport, []);
    // 'Z' is skipped — only A and B remain
    const text = runs.map((r) => r.text).join('');
    expect(text).toBe('AB');
  });

  it('merges consecutive chars with same font into single run', () => {
    const primaryFont = makeFont(PRIMARY_CHARS);
    const primarySupport = new Set(PRIMARY_CHARS);
    const runs = splitTextBySupportedFont('ABC', primaryFont, primarySupport, []);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('ABC');
  });

  it('handles primarySupport=null (all chars use primary font)', () => {
    const primaryFont = makeFont(null);
    const runs = splitTextBySupportedFont('hello', primaryFont, null, []);
    expect(runs).toHaveLength(1);
    expect(runs[0].font).toBe(primaryFont);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — measureRuns', () => {
  it('sums widths and takes max height across runs', () => {
    const fontA = makeFont([], 10, 12);
    const fontB = makeFont([], 8, 15);
    const runs = [
      { text: 'AAA', font: fontA },
      { text: 'BB', font: fontB },
    ];
    const result = measureRuns(runs as never, 14);
    // widthOfTextAtSize is mocked as text.length * widthPerChar
    // fontA: 3 * 10 = 30, fontB: 2 * 8 = 16
    expect(result.width).toBe(46);
    expect(result.height).toBe(15); // max(12, 15)
  });

  it('returns zero width and height for empty runs', () => {
    const result = measureRuns([], 12);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pdfSaverCore — isPdfRef / addRefCount', () => {
  it('isPdfRef returns false for plain objects', () => {
    expect(isPdfRef({})).toBe(false);
    expect(isPdfRef(null)).toBe(false);
    expect(isPdfRef('1 0 R')).toBe(false);
  });

  it('isPdfRef returns true for an object whose constructor is named PDFRef', () => {
    function PDFRef() {}
    const ref = Object.create(PDFRef.prototype);
    Object.defineProperty(PDFRef, 'name', { value: 'PDFRef' });
    expect(isPdfRef(ref)).toBe(true);
  });

  it('addRefCount increments count for valid PDFRef-like objects', () => {
    function PDFRef(this: { toString: () => string }) {
      this.toString = () => '1 0 R';
    }
    const ref = new (PDFRef as never)() as { toString: () => string };
    Object.defineProperty((ref as never).constructor, 'name', { value: 'PDFRef' });
    const counts = new Map<string, number>();
    addRefCount(counts, ref);
    expect(counts.get('1 0 R')).toBe(1);
    addRefCount(counts, ref);
    expect(counts.get('1 0 R')).toBe(2);
  });

  it('addRefCount does nothing for non-PDFRef values', () => {
    const counts = new Map<string, number>();
    addRefCount(counts, 'not a ref');
    addRefCount(counts, 42);
    addRefCount(counts, null);
    expect(counts.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coverage-gap fill (branch coverage wave): cleanContentStream / cleanFormXObjectsInResources /
// pruneStalePecoToolResources / replacePageTextContentStreams / pageHasTextOperatorDamage /
// collectPageContentRefCounts / findExistingFontKey / getOrRegisterPageFontKey / sweepNonDirtyPage
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal PDFDocument.context stub shared by the tests below (mirrors pdfSaver.test.ts's makeSweepableContext). */
function makeStubContext(overrides: Record<string, unknown> = {}) {
  return {
    lookup: vi.fn((value: unknown) => value),
    delete: vi.fn(),
    register: vi.fn((value: unknown) => value),
    flateStream: vi.fn((data: Uint8Array) => new m.PDFRawStream(new m.PDFDict(), data)),
    ...overrides,
  };
}

/** PDFRef-like object matching the `constructor.name === 'PDFRef'` duck-type used by isPdfRef(). */
function makePdfRef(str: string): { toString: () => string } {
  function PDFRef(this: { toString: () => string }) {
    this.toString = () => str;
  }
  const ref = new (PDFRef as never)() as { toString: () => string };
  Object.defineProperty((ref as never).constructor, 'name', { value: 'PDFRef' });
  return ref;
}

describe('pdfSaverCore — cleanContentStream', () => {
  it('returns false and does not call updateContents when stripTextBlocks makes no change (identity mock)', () => {
    const raw = new TextEncoder().encode('0 0 100 100 re f'); // no filter → decodeStreamContents returns raw as-is
    const stream = makeStream(raw);
    const updateSpy = vi.spyOn(stream, 'updateContents');
    const result = cleanContentStream(stream as never);
    expect(result).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('pdfSaverCore — cleanFormXObjectsInResources', () => {
  it('skips XObject entries that resolve to a non-PDFRawStream (e.g. unresolved ref) without throwing', () => {
    const xObjectDict = new m.PDFDict([['/Im0', 'not-a-stream-value']]);
    const resources = new m.PDFDict([['/XObject', xObjectDict]]);
    const context = makeStubContext();
    expect(() => cleanFormXObjectsInResources(resources as never, context as never)).not.toThrow();
  });

  it('skips XObject entries that are PDFRawStream but Subtype != /Form (e.g. an Image), leaving it untouched', () => {
    const imageDict = new m.PDFDict([['/Subtype', new m.PDFName('/Image')]]);
    const imageStream = new m.PDFRawStream(imageDict, new Uint8Array([1, 2, 3]));
    const xObjectDict = new m.PDFDict([['/Im0', imageStream]]);
    const resources = new m.PDFDict([['/XObject', xObjectDict]]);
    const context = makeStubContext();
    const updateSpy = vi.spyOn(imageStream, 'updateContents');

    cleanFormXObjectsInResources(resources as never, context as never);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when resources have no XObject dict', () => {
    const resources = new m.PDFDict();
    const context = makeStubContext();
    expect(() => cleanFormXObjectsInResources(resources as never, context as never)).not.toThrow();
  });
});

describe('pdfSaverCore — pruneStalePecoToolResources (ExtGState loop)', () => {
  it('deletes ExtGState entries matching isPecoToolGraphicsStateKey and keeps non-matching entries', async () => {
    const markersModule = vi.mocked(await import('../../utils/pdfPecoToolMarkers'));
    (markersModule.isPecoToolGraphicsStateKey as ReturnType<typeof vi.fn>)
      .mockImplementation((key: { asString: () => string }) => key.asString() === '/PecoGS-1');

    const extGStateDict = new m.PDFDict([
      ['/PecoGS-1', 'gs-peco'],
      ['/GS0', 'gs-other'],
    ]);
    const resources = new m.PDFDict([['/ExtGState', extGStateDict]]);
    const pageNode = { Resources: () => resources as never };

    pruneStalePecoToolResources(pageNode as never);

    const remainingKeys = Array.from(extGStateDict.entries()).map(([k]) => k.asString());
    expect(remainingKeys).toEqual(['/GS0']);

    (markersModule.isPecoToolGraphicsStateKey as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(false);
  });

  it('does nothing when resources have no ExtGState dict', () => {
    const resources = new m.PDFDict();
    const pageNode = { Resources: () => resources as never };
    expect(() => pruneStalePecoToolResources(pageNode as never)).not.toThrow();
  });
});

describe('pdfSaverCore — replacePageTextContentStreams', () => {
  it('warns with a typeof fallback when a content stream ref resolves to null, and leaves an unchanged per-entry stream untouched (anyDecodeFailed path)', () => {
    const rawBytes = new TextEncoder().encode('0 0 100 100 re f'); // no BT/ET → stripTextBlocks(identity) is a no-op
    const validStream = makeStream(rawBytes); // no filter
    const streamsArray = new m.PDFArray(['NULL_REF', validStream]);
    const pageNode = {
      get: vi.fn(() => streamsArray),
      set: vi.fn(),
    };
    const context = makeStubContext({
      lookup: vi.fn((v: unknown) => (v === 'NULL_REF' ? null : v)),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updateSpy = vi.spyOn(validStream, 'updateContents');

    replacePageTextContentStreams(pageNode as never, context as never, new Map());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is not a PDFRawStream'),
      expect.objectContaining({ streamType: 'object' }), // typeof null fallback
    );
    // per-entry strip made no change → updateContents not called for the valid stream
    expect(updateSpy).not.toHaveBeenCalled();
    // merge path not taken (anyDecodeFailed skips it)
    expect(pageNode.set).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('pdfSaverCore — pageHasTextOperatorDamage', () => {
  it('returns false when the page has no Contents entry at all', () => {
    expect(pageHasTextOperatorDamage({} as never, makeStubContext() as never)).toBe(false);
  });

  it('falls back to pageNode.Contents() when .get is absent', () => {
    const rawBytes = new TextEncoder().encode('BT (x) Tj ET');
    const stream = makeStream(rawBytes);
    const pageNode = { Contents: () => stream as never }; // no .get
    const context = makeStubContext();
    expect(() => pageHasTextOperatorDamage(pageNode as never, context as never)).not.toThrow();
    expect(context.lookup).toHaveBeenCalled();
  });

  it('skips non-PDFRawStream entries and detects damage carried across a decode-failure boundary (PCT-177)', async () => {
    const contentStreamModule = vi.mocked(await import('../../utils/pdfContentStream'));
    (contentStreamModule.hasTextOperatorsOutsideTextObjects as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true);

    const okBytes = new TextEncoder().encode('BT (leaked'); // decodes fine (no filter)
    const okStream = makeStream(okBytes);
    const badFilterStream = makeStream(new Uint8Array([1, 2, 3]), new m.PDFName('/LZWDecode')); // decode → null
    const streamsArray = new m.PDFArray([okStream, 'NOT_A_STREAM', badFilterStream]);
    const pageNode = { get: vi.fn(() => streamsArray) };
    const context = makeStubContext({
      lookup: vi.fn((v: unknown) => (v === 'NOT_A_STREAM' ? {} : v)),
    });

    const result = pageHasTextOperatorDamage(pageNode as never, context as never);
    expect(result).toBe(true);
    // 早期 return (line 421) を通った証跡として、直近の呼び出しが decodedStreams
    // (okBytes 分) を対象にしていたことを確認する。呼び出し回数はファイル内の
    // 他テストと mock を共有しているため（本ファイルは vi.clearAllMocks を持たない
    // 既存の慣習）、絶対回数ではなく直近の呼び出し引数で検証する。
    const lastCallArg = (contentStreamModule.hasTextOperatorsOutsideTextObjects as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(new TextDecoder().decode(lastCallArg as Uint8Array)).toContain('BT (leaked');
  });

  it('a decode failure with no prior accumulated content does not throw or falsely report damage', () => {
    const badFilterStream = makeStream(new Uint8Array([1, 2, 3]), new m.PDFName('/LZWDecode'));
    const pageNode = { get: vi.fn(() => badFilterStream) }; // single, non-array Contents
    const context = makeStubContext();
    expect(pageHasTextOperatorDamage(pageNode as never, context as never)).toBe(false);
  });
});

describe('pdfSaverCore — collectPageContentRefCounts', () => {
  it('returns an empty map when pdfDoc has no getPages function', () => {
    const counts = collectPageContentRefCounts({} as never);
    expect(counts.size).toBe(0);
  });
});

describe('pdfSaverCore — findExistingFontKey / getOrRegisterPageFontKey', () => {
  it('reuses an existing PecoTool-tagged font key when a matching ref is found', () => {
    const targetRef = makePdfRef('5 0 R');
    const font = { ref: targetRef } as unknown as import('@cantoo/pdf-lib').PDFFont;
    const fontDict = new m.PDFDict([
      ['/Helvetica', makePdfRef('1 0 R')], // non-matching ref
      ['/PecoFont-abc', targetRef],        // matching ref + correct tag → reused
    ]);
    const resources = new m.PDFDict([['/Font', fontDict]]);
    const page = { node: { Resources: () => resources as never } };

    const key = findExistingFontKey(page as never, font);
    expect(key?.asString()).toBe('/PecoFont-abc');
  });

  it('does not reuse a matching ref whose key lacks the PecoTool tag prefix', () => {
    const targetRef = makePdfRef('7 0 R');
    const font = { ref: targetRef } as unknown as import('@cantoo/pdf-lib').PDFFont;
    const fontDict = new m.PDFDict([
      ['/UserFont1', targetRef], // ref matches but not Peco-tagged → must not be reused
    ]);
    const resources = new m.PDFDict([['/Font', fontDict]]);
    const page = { node: { Resources: () => resources as never } };

    expect(findExistingFontKey(page as never, font)).toBeUndefined();
  });

  it('skips non-PDFRef dict entries while scanning for a matching key', () => {
    const targetRef = makePdfRef('9 0 R');
    const font = { ref: targetRef } as unknown as import('@cantoo/pdf-lib').PDFFont;
    const fontDict = new m.PDFDict([
      ['/Weird', 'not-a-ref'],
      ['/PecoFont-xyz', targetRef],
    ]);
    const resources = new m.PDFDict([['/Font', fontDict]]);
    const page = { node: { Resources: () => resources as never } };

    expect(findExistingFontKey(page as never, font)?.asString()).toBe('/PecoFont-xyz');
  });

  it('getOrRegisterPageFontKey reuses the key found via the findExistingFontKey scan (cache miss, scan hit)', () => {
    const targetRef = makePdfRef('11 0 R');
    const font = { ref: targetRef } as unknown as import('@cantoo/pdf-lib').PDFFont;
    const fontDict = new m.PDFDict([['/PecoFont-found', targetRef]]);
    const resources = new m.PDFDict([['/Font', fontDict]]);
    const page = { node: { Resources: () => resources as never } };
    const fontKeys = new Map<import('@cantoo/pdf-lib').PDFFont, InstanceType<typeof m.PDFName>>();

    const key = getOrRegisterPageFontKey(page as never, font, fontKeys as never);
    expect(key?.asString()).toBe('/PecoFont-found');
    expect((fontKeys.get(font) as InstanceType<typeof m.PDFName> | undefined)?.asString()).toBe('/PecoFont-found');
  });
});

describe('pdfSaverCore — sweepNonDirtyPage (mock-based edge case)', () => {
  it('skips content stream refs that do not resolve to a PDFRawStream', () => {
    const streamsArray = new m.PDFArray(['NOT_A_STREAM']);
    const pageNode = { get: vi.fn(() => streamsArray), set: vi.fn() };
    const context = makeStubContext({ lookup: vi.fn(() => ({})) }); // resolves to plain object
    expect(() => sweepNonDirtyPage(pageNode as never, context as never, new Map())).not.toThrow();
    expect(pageNode.set).not.toHaveBeenCalled();
  });
});
