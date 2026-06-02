import { describe, it, expect } from 'vitest';
import { computeSaveDiff } from '../../utils/saveDiffSummary';
import type { Action, PageData, TextBlock } from '../../types';

// ─── ヘルパ ────────────────────────────────────────────────────────────────

function makeBlock(id: string, text: string): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
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

// ─── テスト ────────────────────────────────────────────────────────────────

describe('computeSaveDiff', () => {
  it('undoStack が空の場合は空の diff を返す', () => {
    const result = computeSaveDiff([], 0);
    expect(result.entries).toHaveLength(0);
    expect(result.changedPages).toHaveLength(0);
    expect(result.totalPages).toBe(0);
  });

  it('lastSavedActionIndex 以前のアクションは無視する', () => {
    const before = makePage(0, [makeBlock('b1', '古いテキスト')]);
    const after = makePage(0, [makeBlock('b1', '変更後')]);
    const action: Action = { type: 'update_page', pageIndex: 0, before, after };
    // lastSavedActionIndex=1 なので action[0] はスキップ
    const result = computeSaveDiff([action], 1);
    expect(result.entries).toHaveLength(0);
  });

  it('update_page アクション 1 件 → 1 エントリ (modified)', () => {
    const before = makePage(0, [makeBlock('b1', '変更前')]);
    const after = makePage(0, [makeBlock('b1', '変更後')]);
    const action: Action = { type: 'update_page', pageIndex: 0, before, after };
    const result = computeSaveDiff([action], 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      pageIndex: 0,
      blockId: 'b1',
      before: '変更前',
      after: '変更後',
      changeType: 'modified',
    });
    expect(result.changedPages).toEqual([0]);
  });

  it('update_pages アクション（バッチ）→ 複数エントリ', () => {
    const entries = [
      {
        pageIndex: 0,
        before: makePage(0, [makeBlock('b1', 'p0-前')]),
        after: makePage(0, [makeBlock('b1', 'p0-後')]),
      },
      {
        pageIndex: 2,
        before: makePage(2, [makeBlock('b2', 'p2-前')]),
        after: makePage(2, [makeBlock('b2', 'p2-後')]),
      },
    ];
    const action: Action = { type: 'update_pages', entries };
    const result = computeSaveDiff([action], 0);
    expect(result.entries).toHaveLength(2);
    expect(result.changedPages).toEqual([0, 2]);
  });

  it('ブロック追加 → changeType が added', () => {
    const before = makePage(0, []);
    const after = makePage(0, [makeBlock('new1', '新しいテキスト')]);
    const action: Action = { type: 'update_page', pageIndex: 0, before, after };
    const result = computeSaveDiff([action], 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].changeType).toBe('added');
    expect(result.entries[0].before).toBe('');
    expect(result.entries[0].after).toBe('新しいテキスト');
  });

  it('ブロック削除 → changeType が removed', () => {
    const before = makePage(0, [makeBlock('del1', '消えるテキスト')]);
    const after = makePage(0, []);
    const action: Action = { type: 'update_page', pageIndex: 0, before, after };
    const result = computeSaveDiff([action], 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].changeType).toBe('removed');
    expect(result.entries[0].before).toBe('消えるテキスト');
    expect(result.entries[0].after).toBe('');
  });

  it('同一ブロックを複数回変更した場合は最初の before と最後の after のみ記録', () => {
    const p0 = makePage(0, [makeBlock('b1', 'ステップ0')]);
    const p1 = makePage(0, [makeBlock('b1', 'ステップ1')]);
    const p2 = makePage(0, [makeBlock('b1', 'ステップ2')]);
    const actions: Action[] = [
      { type: 'update_page', pageIndex: 0, before: p0, after: p1 },
      { type: 'update_page', pageIndex: 0, before: p1, after: p2 },
    ];
    const result = computeSaveDiff(actions, 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].before).toBe('ステップ0');
    expect(result.entries[0].after).toBe('ステップ2');
  });

  it('テキストが変わらないブロックはエントリに含まれない', () => {
    const block = makeBlock('b1', '同じテキスト');
    const before = makePage(0, [block]);
    const after = makePage(0, [{ ...block }]); // 同じテキスト
    const action: Action = { type: 'update_page', pageIndex: 0, before, after };
    const result = computeSaveDiff([action], 0);
    expect(result.entries).toHaveLength(0);
  });

  it('delete_pages / reorder_pages / rotate_pages アクションはスキップ', () => {
    const actions: Action[] = [
      {
        type: 'delete_pages',
        beforePages: new Map(),
        afterPages: new Map(),
        beforeOrder: [],
        afterOrder: [],
        beforeCurrentPageIndex: 0,
        afterCurrentPageIndex: 0,
        beforeTotalPages: 1,
        afterTotalPages: 0,
      },
      {
        type: 'reorder_pages',
        beforeOrder: [0, 1],
        afterOrder: [1, 0],
      },
      {
        type: 'rotate_pages',
        changes: [{ pageIndex: 0, before: 0, after: 90 }],
      },
    ];
    const result = computeSaveDiff(actions, 0);
    expect(result.entries).toHaveLength(0);
  });

  it('result.timestamp は Number 型かつ現在時刻に近い', () => {
    const before = Date.now() - 10;
    const result = computeSaveDiff([], 0);
    expect(typeof result.timestamp).toBe('number');
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('複数ページにまたがる変更で changedPages が正しくソートされる', () => {
    const entries = [
      { pageIndex: 5, before: makePage(5, [makeBlock('b5', '前')]), after: makePage(5, [makeBlock('b5', '後')]) },
      { pageIndex: 1, before: makePage(1, [makeBlock('b1', '前')]), after: makePage(1, [makeBlock('b1', '後')]) },
    ];
    const action: Action = { type: 'update_pages', entries };
    const result = computeSaveDiff([action], 0);
    expect(result.changedPages).toEqual([1, 5]);
  });
});
