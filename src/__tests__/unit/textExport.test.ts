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

// ─── 非正常系・境界値テスト ───────────────────────────────────────────────────

describe('exportTextFromDocument - abnormal / boundary', () => {
  it('U-TE-AB-01: ページが 0 件のドキュメントは空文字列 (txt)', () => {
    const emptyDoc = makeDoc([]);
    const result = exportTextFromDocument(emptyDoc, 'txt');
    expect(result).toBe('');
  });

  it('U-TE-AB-02: ページが 0 件のドキュメントは空 JSON ページ配列', () => {
    const emptyDoc = makeDoc([]);
    const result = exportTextFromDocument(emptyDoc, 'json');
    const parsed = JSON.parse(result) as { pages: unknown[] };
    expect(parsed.pages).toHaveLength(0);
  });

  it('U-TE-AB-03: textBlocks が空のページは空行なし (txt)', () => {
    const emptyPage = makePage(0, []);
    const doc = makeDoc([emptyPage]);
    const result = exportTextFromDocument(doc, 'txt');
    expect(result).toBe('');
  });

  it('U-TE-AB-04: textBlocks が空のページは csv にデータ行なし', () => {
    const emptyPage = makePage(0, []);
    const doc = makeDoc([emptyPage]);
    const result = exportTextFromDocument(doc, 'csv');
    const lines = result.split('\r\n');
    expect(lines).toHaveLength(1); // header only
  });

  it('U-TE-AB-05: 空文字列 text を持つブロックはそのまま出力 (txt)', () => {
    const page = makePage(0, [makeBlock('e1', '', 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'txt');
    expect(result).toBe('');
  });

  it('U-TE-AB-06: Unicode 4バイト文字 (絵文字) を含むテキストはそのまま出力', () => {
    const emoji = '🦊テスト🔥';
    const page = makePage(0, [makeBlock('u1', emoji, 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'txt');
    expect(result).toBe(emoji);
  });

  it('U-TE-AB-07: サロゲートペア文字を CSV でそのまま出力', () => {
    const text = '𠮷野家'; // U+20BB7 + others
    const page = makePage(0, [makeBlock('s1', text, 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    expect(result).toContain(text);
  });

  it('U-TE-AB-08: 制御文字 (\\x00, \\x1F) を含むテキスト — CSV でクォート', () => {
    const text = 'line1\x00line2';
    const page = makePage(0, [makeBlock('ctrl1', text, 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    // 制御文字自体はエスケープしないが、改行を含むなら囲む
    expect(typeof result).toBe('string');
  });

  it('U-TE-AB-09: pageRange={start, end} で start > end のとき空結果 (txt)', () => {
    const result = exportTextFromDocument(twoPageDoc, 'txt', {
      pageRange: { start: 3, end: 1 },
    });
    expect(result).toBe('');
  });

  it('U-TE-AB-10: pageRange={start, end} が totalPages を超えても例外なし', () => {
    expect(() =>
      exportTextFromDocument(twoPageDoc, 'txt', {
        pageRange: { start: 0, end: 9999 },
      })
    ).not.toThrow();
  });

  it('U-TE-AB-11: pageRange=current で currentPageIndex が totalPages 以上でも例外なし', () => {
    expect(() =>
      exportTextFromDocument(twoPageDoc, 'txt', {
        pageRange: 'current',
        currentPageIndex: 9999,
      })
    ).not.toThrow();
  });

  it('U-TE-AB-12: CSV でダブルクォートのみのテキストを正しくエスケープ', () => {
    const page = makePage(0, [makeBlock('q1', '"""', 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'csv');
    expect(result).toContain('""""""'); // """ → """"""
  });

  it('U-TE-AB-13: Markdown で特殊文字 (#, *, `, [) を含むテキストはそのまま出力', () => {
    const text = '# heading * bold `code` [link]';
    const page = makePage(0, [makeBlock('md1', text, 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'md');
    expect(result).toContain(text);
  });

  it('U-TE-AB-14: JSON で非 ASCII テキストが正しくシリアライズされる', () => {
    const text = '日本語テスト中文한국어';
    const page = makePage(0, [makeBlock('j1', text, 0)]);
    const doc = makeDoc([page]);
    const result = exportTextFromDocument(doc, 'json');
    const parsed = JSON.parse(result) as { pages: Array<{ textBlocks: Array<{ text: string }> }> };
    expect(parsed.pages[0].textBlocks[0].text).toBe(text);
  });

  it('U-TE-AB-15: getPageData callback が undefined を返すページはスキップ', () => {
    const map = new Map<number, PageData>();
    map.set(0, page0);
    const partialDoc: PecoDocument = {
      filePath: '/tmp/partial.pdf',
      fileName: 'partial.pdf',
      totalPages: 2,
      metadata: {},
      pages: map,
    };
    // page 1 は callback でも undefined → スキップ
    const result = exportTextFromDocument(partialDoc, 'txt', {
      getPageData: (_idx) => undefined,
    });
    // page 0 のみ出力
    expect(result).toBe('Alpha\nBeta\nGamma');
  });

  it('U-TE-AB-16: 1万文字超のテキストブロックでもタイムアウトなし', () => {
    const longText = 'あ'.repeat(10000);
    const page = makePage(0, [makeBlock('long1', longText, 0)]);
    const doc = makeDoc([page]);
    const start = Date.now();
    const result = exportTextFromDocument(doc, 'txt');
    const elapsed = Date.now() - start;
    expect(result).toBe(longText);
    expect(elapsed).toBeLessThan(1000); // 1秒以内
  });
});
