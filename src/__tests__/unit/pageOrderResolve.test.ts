/**
 * PCT-104 (A-lite 段階1): resolvePageId / resolveDisplayIndex の単体テスト。
 *
 * 検証観点:
 *   1. identity pageOrder での往復不変性
 *   2. move 後の pageOrder での往復不変性
 *   3. resolvePageId の境界値（空・範囲外）
 *   4. resolveDisplayIndex の境界値（存在しない pageId・不正フォーマット）
 */
import { describe, expect, it } from 'vitest';
import { resolvePageId, resolveDisplayIndex } from '../../utils/pageOrder';

// ── 1. identity pageOrder での往復不変性 ──────────────────────────────────

describe('resolvePageId + resolveDisplayIndex 往復不変性 (identity pageOrder)', () => {
  it('3 ページ identity で全 displayIndex が往復一致する', () => {
    const pageOrder = [0, 1, 2];
    for (let di = 0; di < pageOrder.length; di++) {
      const pageId = resolvePageId(pageOrder, di);
      const back = resolveDisplayIndex(pageOrder, pageId);
      expect(back).toBe(di);
    }
  });

  it('pageId の値は "src:" + sourceIndex の形式', () => {
    const pageOrder = [0, 1, 2];
    expect(resolvePageId(pageOrder, 0)).toBe('src:0');
    expect(resolvePageId(pageOrder, 1)).toBe('src:1');
    expect(resolvePageId(pageOrder, 2)).toBe('src:2');
  });
});

// ── 2. move 後の pageOrder での往復不変性 ────────────────────────────────

describe('resolvePageId + resolveDisplayIndex 往復不変性 (reordered pageOrder)', () => {
  it('ページ0を末尾に移動した pageOrder で往復一致する', () => {
    // [0,1,2] → 0を末尾へ → [1,2,0]
    const pageOrder = [1, 2, 0];
    for (let di = 0; di < pageOrder.length; di++) {
      const pageId = resolvePageId(pageOrder, di);
      const back = resolveDisplayIndex(pageOrder, pageId);
      expect(back).toBe(di);
    }
  });

  it('任意の並び順で 5 ページ分が往復一致する', () => {
    const pageOrder = [3, 1, 4, 0, 2]; // ランダム順
    for (let di = 0; di < pageOrder.length; di++) {
      const pageId = resolvePageId(pageOrder, di);
      const back = resolveDisplayIndex(pageOrder, pageId);
      expect(back).toBe(di);
    }
  });

  it('move 後でも元ページの pageId は不変 (pageId = "src:" + 初期 sourceIndex)', () => {
    // 初期 [0,1,2] のとき pageId[displayIndex=0] = "src:0"
    // 移動後 [1,2,0] のとき "src:0" は displayIndex=2 にある
    const afterOrder = [1, 2, 0];
    expect(resolveDisplayIndex(afterOrder, 'src:0')).toBe(2);
    expect(resolveDisplayIndex(afterOrder, 'src:1')).toBe(0);
    expect(resolveDisplayIndex(afterOrder, 'src:2')).toBe(1);
  });
});

// ── 3. resolvePageId 境界値 ──────────────────────────────────────────────

describe('resolvePageId 境界値', () => {
  it('空 pageOrder で displayIndex=0 は "src:0" を返す (identity fallback)', () => {
    expect(resolvePageId([], 0)).toBe('src:0');
  });

  it('範囲外 displayIndex は identity 前提で "src:" + displayIndex を返す', () => {
    const pageOrder = [0, 1, 2];
    expect(resolvePageId(pageOrder, 5)).toBe('src:5');
  });
});

// ── 4. resolveDisplayIndex 境界値 ──────────────────────────────────────

describe('resolveDisplayIndex 境界値', () => {
  it('存在しない sourceIndex の pageId は -1 を返す', () => {
    const pageOrder = [0, 1, 2];
    expect(resolveDisplayIndex(pageOrder, 'src:9')).toBe(-1);
  });

  it('"src:" プレフィックスなしの文字列は -1 を返す', () => {
    const pageOrder = [0, 1, 2];
    expect(resolveDisplayIndex(pageOrder, '0')).toBe(-1);
    expect(resolveDisplayIndex(pageOrder, 'page:0')).toBe(-1);
    expect(resolveDisplayIndex(pageOrder, '')).toBe(-1);
  });

  it('"src:NaN" は -1 を返す', () => {
    expect(resolveDisplayIndex([0, 1], 'src:NaN')).toBe(-1);
  });

  it('"src:" (数値なし) は -1 を返す', () => {
    expect(resolveDisplayIndex([0, 1], 'src:')).toBe(-1);
  });
});
