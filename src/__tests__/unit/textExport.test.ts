import { describe, it, expect } from 'vitest';
import { exportTextFromDocument, type TextExportFormat } from '../../utils/textExport';
import type { PecoDocument, PageData, TextBlock } from '../../types';

// ─── テスト用データ構築ヘルパ ────────────────────────────────────────────────

function makeBlock(
  id: string,
  text: string,
  order: number,
  writingMode: 'horizontal' | 'vertical' = 'horizontal',
): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 10 + order * 5, y: 20, width: 100, height: 20 },
    writingMode,
    order,
    isNew: false,
    isDirty: false,
  };
}

function makePage(pageIndex: number, blocks: TextBlock[]): PageData {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  };
}

function makeDoc(pages: PageData[]): PecoDocument {
  const map = new Map<number, PageData>();
  for (const p of pages) map.set(p.pageIndex, p);
  return {
    filePath: '/tmp/test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.length,
    metadata: {},
    pages: map,
  };
}

// 2ページ × 各3ブロックの基本ドキュメント
const page0 = makePage(0, [
  makeBlock('a1', 'Alpha', 0),
  makeBlock('a2', 'Beta', 1),
  makeBlock('a3', 'Gamma', 2),
]);
const page1 = makePage(1, [
  makeBlock('b1', 'Delta', 0),
  makeBlock('b2', 'Epsilon', 1),
  makeBlock('b3', 'Zeta', 2),
]);
const twoPageDoc = makeDoc([page0, page1]);

// ─── TXT ─────────────────────────────────────────────────────────────────────

describe('exportTextFromDocument - txt', () => {
  it('U-TE-01: 全ページを --- 区切りで出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'txt');
    expect(result).toBe('Alpha\nBeta\nGamma\n---\nDelta\nEpsilon\nZeta');
  });

  it('U-TE-02: pageRange=current で 1 ページのみ', () => {
    const result = exportTextFromDocument(twoPageDoc, 'txt', {
      pageRange: 'current',
      currentPageIndex: 1,
    });
    expect(result).toBe('Delta\nEpsilon\nZeta');
  });

  it('U-TE-03: pageRange={start,end} で範囲指定', () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage(i, [makeBlock(`c${i}`, `Page${i}`, 0)])
    );
    const doc = makeDoc(pages);
    const result = exportTextFromDocument(doc, 'txt', {
      pageRange: { start: 1, end: 3 },
    });
    expect(result).toBe('Page1\n---\nPage2\n---\nPage3');
  });

  it('U-TE-04: order 順でブロックをソート', () => {
    const reversed = makePage(0, [
      makeBlock('r3', 'Third', 2),
      makeBlock('r1', 'First', 0),
      makeBlock('r2', 'Second', 1),
    ]);
    const doc = makeDoc([reversed]);
    const result = exportTextFromDocument(doc, 'txt');
    expect(result).toBe('First\nSecond\nThird');
  });
});

// ─── Markdown ─────────────────────────────────────────────────────────────────

describe('exportTextFromDocument - md', () => {
  it('U-TE-05: ページ見出しとテキストを出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'md');
    expect(result).toContain('## Page 1');
    expect(result).toContain('## Page 2');
    expect(result).toContain('Alpha');
    expect(result).toContain('Delta');
  });

  it('U-TE-06: 縦書きブロックは > 引用形式', () => {
    const page = makePage(0, [
      makeBlock('v1', '縦書きテキスト', 0, 'vertical'),
      makeBlock('h1', '横書きテキスト', 1, 'horizontal'),
    ]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'md');
    expect(result).toContain('> 縦書きテキスト');
    expect(result).not.toContain('> 横書きテキスト');
    expect(result).toContain('横書きテキスト');
  });

  it('U-TE-07: pageRange=current で現在ページのみ', () => {
    const result = exportTextFromDocument(twoPageDoc, 'md', {
      pageRange: 'current',
      currentPageIndex: 0,
    });
    expect(result).toContain('## Page 1');
    expect(result).not.toContain('## Page 2');
    expect(result).toContain('Alpha');
    expect(result).not.toContain('Delta');
  });
});

// ─── CSV ─────────────────────────────────────────────────────────────────────

describe('exportTextFromDocument - csv', () => {
  it('U-TE-08: ヘッダー行を出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'csv');
    const firstLine = result.split('\r\n')[0];
    expect(firstLine).toBe('page,order,x,y,width,height,writingMode,text');
  });

  it('U-TE-09: 各フィールドを正しく出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'csv');
    const lines = result.split('\r\n');
    // page 1, order 0, Alpha
    expect(lines[1]).toContain('1,0,');
    expect(lines[1]).toContain('Alpha');
  });

  it('U-TE-10: カンマを含むテキストはダブルクォートで囲む', () => {
    const page = makePage(0, [makeBlock('csv1', 'Hello, World', 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    expect(result).toContain('"Hello, World"');
  });

  it('U-TE-11: ダブルクォートを含むテキストは "" にエスケープ', () => {
    const page = makePage(0, [makeBlock('csv2', 'Say "hello"', 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    expect(result).toContain('"Say ""hello"""');
  });

  it('U-TE-12: 改行を含むテキストはダブルクォートで囲む', () => {
    const page = makePage(0, [makeBlock('csv3', 'line1\nline2', 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    expect(result).toContain('"line1\nline2"');
  });

  it('U-TE-13: CRLF 区切りで出力 (RFC 4180)', () => {
    const result = exportTextFromDocument(twoPageDoc, 'csv');
    // header + 6 data rows = 7 lines joined by CRLF
    const lines = result.split('\r\n');
    expect(lines).toHaveLength(7); // 1 header + 3 page0 + 3 page1
  });
});

// ─── JSON ─────────────────────────────────────────────────────────────────────

describe('exportTextFromDocument - json', () => {
  it('U-TE-14: 正しい JSON 構造を出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'json');
    const parsed = JSON.parse(result) as {
      pages: Array<{
        pageIndex: number;
        textBlocks: Array<{ id: string; text: string; order: number }>;
      }>;
    };
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages[0].pageIndex).toBe(0);
    expect(parsed.pages[0].textBlocks).toHaveLength(3);
    expect(parsed.pages[0].textBlocks[0].text).toBe('Alpha');
  });

  it('U-TE-15: pageRange=current で 1 ページのみ出力', () => {
    const result = exportTextFromDocument(twoPageDoc, 'json', {
      pageRange: 'current',
      currentPageIndex: 1,
    });
    const parsed = JSON.parse(result) as { pages: unknown[] };
    expect(parsed.pages).toHaveLength(1);
  });

  it('U-TE-16: pageRange={start:1,end:3} で 3 ページ出力', () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage(i, [makeBlock(`d${i}`, `PageText${i}`, 0)])
    );
    const doc = makeDoc(pages);
    const result = exportTextFromDocument(doc, 'json', {
      pageRange: { start: 1, end: 3 },
    });
    const parsed = JSON.parse(result) as { pages: unknown[] };
    expect(parsed.pages).toHaveLength(3);
  });

  it('U-TE-17: order 順でソートされた textBlocks を出力', () => {
    const page = makePage(0, [
      makeBlock('x3', 'Third', 2),
      makeBlock('x1', 'First', 0),
      makeBlock('x2', 'Second', 1),
    ]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'json');
    const parsed = JSON.parse(result) as {
      pages: Array<{ textBlocks: Array<{ text: string }> }>;
    };
    const texts = parsed.pages[0].textBlocks.map(b => b.text);
    expect(texts).toEqual(['First', 'Second', 'Third']);
  });
});

// ─── getPageData callback ────────────────────────────────────────────────────

describe('exportTextFromDocument - getPageData callback', () => {
  it('U-TE-18: document.pages にないページを getPageData で補完', () => {
    // page 0 のみ pages に持つ、page 1 は callback で返す
    const map = new Map<number, PageData>();
    map.set(0, page0);
    const partialDoc: PecoDocument = {
      filePath: '/tmp/partial.pdf',
      fileName: 'partial.pdf',
      totalPages: 2,
      metadata: {},
      pages: map,
    };
    const result = exportTextFromDocument(partialDoc, 'txt', {
      getPageData: (idx) => (idx === 1 ? page1 : undefined),
    });
    expect(result).toBe('Alpha\nBeta\nGamma\n---\nDelta\nEpsilon\nZeta');
  });
});

// ─── 全フォーマットスナップショット ──────────────────────────────────────────

const FORMATS: TextExportFormat[] = ['txt', 'md', 'csv', 'json'];

describe('exportTextFromDocument - snapshot sanity', () => {
  for (const fmt of FORMATS) {
    it(`U-TE-19-${fmt}: 2ページ×3ブロックが非空文字列を返す`, () => {
      const result = exportTextFromDocument(twoPageDoc, fmt);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  }
});
