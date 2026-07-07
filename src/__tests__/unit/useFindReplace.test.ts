/**
 * useFindReplace (issue #93 + #98 + #222) のロジック層単体テスト。
 *
 *  - buildRegexOrError: 通常文字列 / 大小区別 / regex / 構文エラー
 *  - countMatches: scope=selection/current/all, 大小区別, regex
 *  - buildMatchPreview (issue #98): before/after / マッチ範囲 / replacement 反映 /
 *    maxItems 打ち切り / scope / 大小区別 / regex / ゼロ幅マッチ
 *  - useFindReplace hook (issue #222): scope='all' debounce / scope='current' 即時
 *
 * React Hook 部分 (useFindReplace) は ReplaceDialog.test.tsx で間接的に検証済み。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pdfLoader (DOMMatrix を要求する pdfjs を import している) は pure 関数テストには不要
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
}));

import {
  buildRegexOrError,
  countMatches,
  buildMatchPreview,
} from '../../hooks/useFindReplace';
import type { PageData, TextBlock } from '../../types';

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'b1',
    text: '',
    originalText: '',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
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

function buildPagesMap(pages: PageData[]): Map<number, PageData> {
  return new Map(pages.map((p) => [p.pageIndex, p]));
}

describe('buildRegexOrError', () => {
  it('空文字列は error:"" を返す (UI 側で error 文字列が falsy ならエラー非表示)', () => {
    const r = buildRegexOrError({ pattern: '', caseSensitive: false, useRegex: false });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('');
  });

  it('useRegex=false で特殊文字は literal として扱う', () => {
    const r = buildRegexOrError({ pattern: 'a.b', caseSensitive: false, useRegex: false });
    expect('re' in r).toBe(true);
    if ('re' in r) {
      expect(r.re.test('a.b')).toBe(true);
      expect(r.re.test('axb')).toBe(false); // . が literal なので
    }
  });

  it('useRegex=true で構文エラーは error 文字列を返す', () => {
    const r = buildRegexOrError({ pattern: '[invalid', caseSensitive: false, useRegex: true });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.length).toBeGreaterThan(0);
  });

  it('caseSensitive=false (既定) は i フラグが付く', () => {
    const r = buildRegexOrError({ pattern: 'hello', caseSensitive: false, useRegex: false });
    if ('re' in r) {
      expect(r.re.flags).toContain('i');
      expect(r.re.test('HELLO')).toBe(true);
    }
  });
});

describe('countMatches', () => {
  it('scope=current は現ページのみカウント', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'foo foo' })]);
    const p1 = makePage(1, [makeBlock({ id: 'b2', text: 'foo' })]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'current',
      pagesMap: buildPagesMap([p0, p1]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r).toEqual({ hits: 2, blocks: 1, pages: 1 });
  });

  it('scope=all で全ページ集計', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'foo' })]);
    const p1 = makePage(1, [makeBlock({ id: 'b2', text: 'foo foo' })]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'all',
      pagesMap: buildPagesMap([p0, p1]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r).toEqual({ hits: 3, blocks: 2, pages: 2 });
  });

  it('scope=selection は selectedIds に含まれるブロックのみ', () => {
    const p0 = makePage(0, [
      makeBlock({ id: 'b1', text: 'foo' }),
      makeBlock({ id: 'b2', text: 'foo foo' }),
    ]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'selection',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(['b2']),
    });
    expect(r).toEqual({ hits: 2, blocks: 1, pages: 1 });
  });

  it('pagesMap=undefined は 0 件', () => {
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'all',
      pagesMap: undefined,
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r).toEqual({ hits: 0, blocks: 0, pages: 0 });
  });
});

describe('buildMatchPreview (issue #98)', () => {
  it('単純な置換: before / after / ranges が正しい', () => {
    const p0 = makePage(0, [
      makeBlock({ id: 'b3', text: 'こんにちは、あ りがとう' }),
    ]);
    const re = /あ/g;
    const r = buildMatchPreview({
      re,
      replacement: 'い',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items.length).toBe(1);
    const it = r.items[0];
    expect(it.pageIndex).toBe(0);
    expect(it.blockId).toBe('b3');
    expect(it.before).toBe('こんにちは、あ りがとう');
    expect(it.after).toBe('こんにちは、い りがとう');
    expect(it.beforeRanges).toEqual([{ start: 6, end: 7 }]);
    expect(it.afterRanges).toEqual([{ start: 6, end: 7 }]);
    expect(r.totalBlocks).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('1 ブロック複数マッチ: ranges が全マッチ分作られる', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'aXaXa' })]);
    const re = /a/g;
    const r = buildMatchPreview({
      re,
      replacement: 'b',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items.length).toBe(1);
    const it = r.items[0];
    expect(it.before).toBe('aXaXa');
    expect(it.after).toBe('bXbXb');
    expect(it.beforeRanges).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    expect(it.afterRanges).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it('replacement が長い場合の after ranges が伸びる', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'a-a' })]);
    const re = /a/g;
    const r = buildMatchPreview({
      re,
      replacement: 'XX',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    const it = r.items[0];
    expect(it.after).toBe('XX-XX');
    expect(it.afterRanges).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('replacement が空 (削除) でも after ranges が 0 幅で並ぶ', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'aXa' })]);
    const re = /a/g;
    const r = buildMatchPreview({
      re,
      replacement: '',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    const it = r.items[0];
    expect(it.after).toBe('X');
    expect(it.afterRanges).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });

  it('マッチしないブロックは items に含まれない', () => {
    const p0 = makePage(0, [
      makeBlock({ id: 'b1', text: 'foo' }),
      makeBlock({ id: 'b2', text: 'bar' }),
    ]);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'baz',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items.length).toBe(1);
    expect(r.items[0].blockId).toBe('b1');
  });

  it('maxItems=2 で打ち切り、totalBlocks は全件数、truncated=true', () => {
    const blocks: TextBlock[] = [];
    for (let i = 0; i < 5; i++) {
      blocks.push(makeBlock({ id: `b${i}`, text: 'foo' }));
    }
    const p0 = makePage(0, blocks);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
      maxItems: 2,
    });
    expect(r.items.length).toBe(2);
    expect(r.totalBlocks).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('maxItems=20 default は明示しなくても適用される', () => {
    const blocks: TextBlock[] = [];
    for (let i = 0; i < 25; i++) {
      blocks.push(makeBlock({ id: `b${i}`, text: 'foo' }));
    }
    const p0 = makePage(0, blocks);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items.length).toBe(20);
    expect(r.totalBlocks).toBe(25);
    expect(r.truncated).toBe(true);
  });

  it('scope=all で複数ページの items が page index 順に並ぶ', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b0', text: 'foo' })]);
    const p2 = makePage(2, [makeBlock({ id: 'b2', text: 'foo' })]);
    const p1 = makePage(1, [makeBlock({ id: 'b1', text: 'foo' })]);
    // Map 挿入順をわざと逆にして、ソート機能を検証
    const map = new Map<number, PageData>();
    map.set(2, p2);
    map.set(0, p0);
    map.set(1, p1);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'all',
      pagesMap: map,
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items.map((x) => x.pageIndex)).toEqual([0, 1, 2]);
  });

  it('scope=selection は selectedIds のみ', () => {
    const p0 = makePage(0, [
      makeBlock({ id: 'a', text: 'foo' }),
      makeBlock({ id: 'b', text: 'foo' }),
    ]);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'selection',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(['b']),
    });
    expect(r.items.length).toBe(1);
    expect(r.items[0].blockId).toBe('b');
  });

  it('大小区別 OFF (i フラグ) で Hello / HELLO どちらもハイライト', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'Hello HELLO' })]);
    const re = /hello/gi;
    const r = buildMatchPreview({
      re,
      replacement: 'hi',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items[0].beforeRanges).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
    expect(r.items[0].after).toBe('hi hi');
  });

  it('useRegex=true で \\d+ マッチが正しく置換され ranges が出る', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'abc123def456' })]);
    const re = /\d+/g;
    const r = buildMatchPreview({
      re,
      replacement: 'N',
      useRegex: true,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    const it = r.items[0];
    expect(it.before).toBe('abc123def456');
    expect(it.after).toBe('abcNdefN');
    expect(it.beforeRanges).toEqual([
      { start: 3, end: 6 },
      { start: 9, end: 12 },
    ]);
    expect(it.afterRanges).toEqual([
      { start: 3, end: 4 },
      { start: 7, end: 8 },
    ]);
  });

  it('useRegex=true で $1 後方参照 が反映される', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'abc 123' })]);
    const re = /(\w+) (\d+)/g;
    const r = buildMatchPreview({
      re,
      replacement: '$2-$1',
      useRegex: true,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items[0].after).toBe('123-abc');
  });

  // ── bug-hunt round3: lookbehind/lookahead で after プレビューが before のまま (=置換なし) に見える ──
  it('R3-LA-06: lookbehind (?<=第)\\d を含むプレビューで after が正しく展開される', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: '第3章' })]);
    const re = /(?<=第)\d/g;
    const r = buildMatchPreview({
      re,
      replacement: 'X',
      useRegex: true,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    // 元バグ: matchStr='3' 単体への再マッチが失敗し after が 'X' に展開されず before と
    // 同じ '第3章' のまま (=置換されていないように見える) になっていた
    expect(r.items[0].after).toBe('第X章');
    expect(r.items[0].afterRanges).toEqual([{ start: 1, end: 2 }]);
  });

  it('R3-LA-07: lookahead \\d(?=章) を含むプレビューで after が正しく展開される、件数も一致する', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: '第3章 第5章' })]);
    const re = /\d(?=章)/g;
    const r = buildMatchPreview({
      re,
      replacement: 'X',
      useRegex: true,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items[0].after).toBe('第X章 第X章');
    // countMatches (実行系の hits と対応) と一致することも確認
    const counts = countMatches({
      re: /\d(?=章)/g,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(counts.hits).toBe(r.items[0].beforeRanges.length);
  });

  it('useRegex=false で $ は literal 扱い (replacement の $1 が文字列のまま入る)', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'abc' })]);
    const re = /abc/g;
    const r = buildMatchPreview({
      re,
      replacement: '$1',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    // useRegex=false 経路は $1 を literal として埋める
    expect(r.items[0].after).toBe('$1');
  });

  it('writingMode が item に反映される', () => {
    const p0 = makePage(0, [
      makeBlock({ id: 'b1', text: '縦書きあ', writingMode: 'vertical' }),
    ]);
    const re = /あ/g;
    const r = buildMatchPreview({
      re,
      replacement: 'い',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items[0].writingMode).toBe('vertical');
  });

  it('pagesMap=undefined は空 preview を返す', () => {
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'all',
      pagesMap: undefined,
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items).toEqual([]);
    expect(r.totalBlocks).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('全ページに大量マッチがあっても maxItems で止まる (パフォーマンス: 早期打ち切り)', () => {
    // 100 ページ x 10 ブロックずつヒット = 1000 件ブロックヒット
    const pages: PageData[] = [];
    for (let p = 0; p < 100; p++) {
      const blocks: TextBlock[] = [];
      for (let i = 0; i < 10; i++) {
        blocks.push(makeBlock({ id: `p${p}b${i}`, text: 'foo' }));
      }
      pages.push(makePage(p, blocks));
    }
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'all',
      pagesMap: buildPagesMap(pages),
      currentPageIndex: 0,
      selectedIds: new Set(),
      maxItems: 20,
    });
    expect(r.items.length).toBe(20);
    // 全ブロックは数え続けるので totalBlocks は 1000
    expect(r.totalBlocks).toBe(1000);
    expect(r.truncated).toBe(true);
    // 最初の 20 件は page index の昇順
    expect(r.items[0].pageIndex).toBe(0);
    expect(r.items[19].pageIndex).toBe(1);
  });
});

// ── issue #104: countMatches / buildMatchPreview が IDB 退避ページも含める ──
describe('issue #104: countMatches / buildMatchPreview の IDB マージ', () => {
  it('countMatches scope=all で in-memory + IDB 両方のページが集計される', () => {
    const inMem = makePage(0, [makeBlock({ id: 'm0', text: 'foo' })]);
    const idbPages = new Map<number, Partial<PageData>>([
      [1, {
        pageIndex: 1,
        width: 595,
        height: 842,
        textBlocks: [makeBlock({ id: 'idb1', text: 'foo foo' })],
        isDirty: true,
        thumbnail: null,
      }],
    ]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'all',
      pagesMap: buildPagesMap([inMem]),
      currentPageIndex: 0,
      selectedIds: new Set(),
      idbPages,
    });
    // in-memory 1 hit + idb 2 hit
    expect(r).toEqual({ hits: 3, blocks: 2, pages: 2 });
  });

  it('countMatches scope=current は IDB を見ない', () => {
    const inMem = makePage(0, [makeBlock({ id: 'm0', text: 'foo' })]);
    const idbPages = new Map<number, Partial<PageData>>([
      [1, {
        pageIndex: 1,
        width: 595,
        height: 842,
        textBlocks: [makeBlock({ id: 'idb1', text: 'foo foo' })],
        isDirty: true,
        thumbnail: null,
      }],
    ]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'current',
      pagesMap: buildPagesMap([inMem]),
      currentPageIndex: 0,
      selectedIds: new Set(),
      idbPages,
    });
    // current page (0) のみ
    expect(r).toEqual({ hits: 1, blocks: 1, pages: 1 });
  });

  it('buildMatchPreview scope=all で IDB 退避ページの items も生成される', () => {
    const inMem = makePage(0, [makeBlock({ id: 'm0', text: 'foo' })]);
    const idbPages = new Map<number, Partial<PageData>>([
      [2, {
        pageIndex: 2,
        width: 595,
        height: 842,
        textBlocks: [makeBlock({ id: 'idb2', text: 'foo' })],
        isDirty: true,
        thumbnail: null,
      }],
    ]);
    const re = /foo/g;
    const r = buildMatchPreview({
      re,
      replacement: 'bar',
      useRegex: false,
      scope: 'all',
      pagesMap: buildPagesMap([inMem]),
      currentPageIndex: 0,
      selectedIds: new Set(),
      idbPages,
    });
    expect(r.items.length).toBe(2);
    expect(r.items.map((it) => it.pageIndex).sort()).toEqual([0, 2]);
    // IDB の item でも after は正しい
    const idbItem = r.items.find((it) => it.pageIndex === 2)!;
    expect(idbItem.before).toBe('foo');
    expect(idbItem.after).toBe('bar');
  });

  it('IDB エントリに textBlocks が無い場合はマージ対象から外れる (defensive)', () => {
    const inMem = makePage(0, [makeBlock({ id: 'm0', text: 'foo' })]);
    const idbPages = new Map<number, Partial<PageData>>([
      // textBlocks 未設定 (例: isDirty フラグだけ持つ stub)
      [1, { pageIndex: 1, isDirty: true }],
    ]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'all',
      pagesMap: buildPagesMap([inMem]),
      currentPageIndex: 0,
      selectedIds: new Set(),
      idbPages,
    });
    expect(r).toEqual({ hits: 1, blocks: 1, pages: 1 });
  });

  it('in-memory に同 idx がある場合 IDB は上書きしない (in-memory 優先)', () => {
    const inMem = makePage(1, [makeBlock({ id: 'mem1', text: 'foo' })]);
    const idbPages = new Map<number, Partial<PageData>>([
      // 同じ idx=1 に古い IDB スナップショット (textBlocks=[]) があっても in-memory 優先
      [1, {
        pageIndex: 1,
        textBlocks: [],
        isDirty: false,
      }],
    ]);
    const re = /foo/g;
    const r = countMatches({
      re,
      scope: 'all',
      pagesMap: buildPagesMap([inMem]),
      currentPageIndex: 1,
      selectedIds: new Set(),
      idbPages,
    });
    expect(r.hits).toBe(1);
  });
});

// ── issue #105: buildMatchPreview useRegex=false で $ が literal ──
describe('issue #105: buildMatchPreview と replaceText の literal $ 一致', () => {
  it('useRegex=false で replacement="$&" は literal "$&" として after に入る (preview)', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'abc' })]);
    const re = /abc/g;
    const r = buildMatchPreview({
      re,
      replacement: '$&',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r.items[0].after).toBe('$&');
  });

  it('useRegex=false で replacement="$$" / "$1" も literal で入る (preview と実置換の一致根拠)', () => {
    const p0 = makePage(0, [makeBlock({ id: 'b1', text: 'foo' })]);
    const re = /foo/g;
    const r1 = buildMatchPreview({
      re: new RegExp(re.source, re.flags),
      replacement: '$$',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r1.items[0].after).toBe('$$');

    const r2 = buildMatchPreview({
      re: new RegExp(re.source, re.flags),
      replacement: '$1',
      useRegex: false,
      scope: 'current',
      pagesMap: buildPagesMap([p0]),
      currentPageIndex: 0,
      selectedIds: new Set(),
    });
    expect(r2.items[0].after).toBe('$1');
  });
});

// ── issue #222: useFindReplace hook — scope='all' debounce ──────────────────
//
// pecoStore と pdfLoader を最小限 mock して renderHook で hook 挙動を検証する。
// vi.useFakeTimers で setTimeout をコントロールし debounce の on/off を確認する。

vi.mock('../../store/pecoStore', () => {
  // テスト中に pages を差し替えられるよう store object を外に出す
  const store: Record<string, unknown> = {
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    replaceText: vi.fn(),
  };
  return {
    usePecoStore: Object.assign(
      vi.fn((selector: (s: typeof store) => unknown) => selector(store)),
      { getState: vi.fn(() => store) },
    ),
    __store: store,
  };
});

import { renderHook, act } from '@testing-library/react';
import { useFindReplace, type ReplaceQuery } from '../../hooks/useFindReplace';
import { usePecoStore } from '../../store/pecoStore';

// テスト用ページ/ブロックを store.document にセットするヘルパー
function setStoreDocument(blocks: Array<{ id: string; text: string }>) {
  const store = (
    usePecoStore as unknown as { __store: Record<string, unknown> }
  ).__store ?? (vi.mocked(usePecoStore).mock as unknown as { store: Record<string, unknown> }).store;

  // module 内の store object への参照を usePecoStore の mock 経由で差し替える
  vi.mocked(usePecoStore).mockImplementation((selector: (s: unknown) => unknown) => {
    const doc = {
      filePath: '/test.pdf',
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: blocks.map(b => ({
          id: b.id,
          text: b.text,
          originalText: b.text,
          bbox: { x: 0, y: 0, width: 100, height: 20 },
          writingMode: 'horizontal' as const,
          order: 0,
          isNew: false,
          isDirty: false,
        })), isDirty: false, thumbnail: null }],
      ]),
    };
    return selector({
      document: doc,
      currentPageIndex: 0,
      selectedIds: new Set<string>(),
      replaceText: vi.fn(),
    });
  });
}

describe('useFindReplace hook (issue #222): debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // pdfLoader.getAllTemporaryPageData は既に上部で mock 済み (空 Map を返す)
    setStoreDocument([{ id: 'b1', text: 'foobar' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scope="all" で query 変化直後は isSearching=true、300ms 後に isSearching=false', () => {
    const initQuery: ReplaceQuery = { pattern: '', caseSensitive: false, useRegex: false };
    const { result, rerender } = renderHook(
      ({ query, scope }: { query: ReplaceQuery; scope: 'all' | 'current' }) =>
        useFindReplace(query, scope),
      { initialProps: { query: initQuery, scope: 'all' as const } },
    );

    // 初期: pattern 空なので isSearching は false (同一参照で debounce が起きていない)
    expect(result.current.isSearching).toBe(false);

    const newQuery: ReplaceQuery = { pattern: 'foo', caseSensitive: false, useRegex: false };

    act(() => {
      rerender({ query: newQuery, scope: 'all' });
    });

    // 変化直後 (タイマー未経過) は検索中
    expect(result.current.isSearching).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    // 300ms 経過後は反映完了
    expect(result.current.isSearching).toBe(false);
  });

  it('scope="current" で query 変化後は即座に isSearching=false (debounce 不要)', () => {
    const initQuery: ReplaceQuery = { pattern: '', caseSensitive: false, useRegex: false };
    const { result, rerender } = renderHook(
      ({ query, scope }: { query: ReplaceQuery; scope: 'all' | 'current' }) =>
        useFindReplace(query, scope),
      { initialProps: { query: initQuery, scope: 'current' as const } },
    );

    const newQuery: ReplaceQuery = { pattern: 'foo', caseSensitive: false, useRegex: false };

    act(() => {
      rerender({ query: newQuery, scope: 'current' });
    });

    // scope='current' は delay=0 なので即時反映 → isSearching は false
    expect(result.current.isSearching).toBe(false);
  });
});
