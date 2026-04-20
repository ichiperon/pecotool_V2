/**
 * S-12: reorderThreshold ユーティリティの境界 / 不正値テスト。
 * - localStorage 経由の read/write の clamp / fallback 挙動を検証する。
 * - jsdom の localStorage は実装されているため、setItem/getItem を直接使う。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readReorderThreshold,
  writeReorderThreshold,
  REORDER_THRESHOLD_STORAGE_KEY,
  DEFAULT_REORDER_THRESHOLD,
  REORDER_THRESHOLD_MIN,
  REORDER_THRESHOLD_MAX,
} from '../../utils/reorderThreshold';

beforeEach(() => {
  // テスト間の汚染防止
  localStorage.clear();
});

describe('readReorderThreshold', () => {
  it('S-12-01: 正常値 (50) はそのまま返す', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, '50');
    expect(readReorderThreshold()).toBe(50);
  });

  it("S-12-02a: 'NaN' はデフォルト値にフォールバック", () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, 'NaN');
    expect(readReorderThreshold()).toBe(DEFAULT_REORDER_THRESHOLD);
  });

  it("S-12-02b: 'abc' (parseInt 結果が NaN) はデフォルト値にフォールバック", () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, 'abc');
    expect(readReorderThreshold()).toBe(DEFAULT_REORDER_THRESHOLD);
  });

  it('S-12-03a: 範囲外 (-10) は MIN に clamp', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, '-10');
    expect(readReorderThreshold()).toBe(REORDER_THRESHOLD_MIN);
  });

  it('S-12-03b: 範囲外 (999) は MAX に clamp', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, '999');
    expect(readReorderThreshold()).toBe(REORDER_THRESHOLD_MAX);
  });

  it('S-12-04a: 空文字 (未保存扱い) はデフォルト値', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, '');
    expect(readReorderThreshold()).toBe(DEFAULT_REORDER_THRESHOLD);
  });

  it('S-12-04b: キー未保存 (null) はデフォルト値', () => {
    // localStorage.clear() 直後 → getItem は null
    expect(readReorderThreshold()).toBe(DEFAULT_REORDER_THRESHOLD);
  });

  it('S-12-05: 浮動小数 (50.7) は parseInt で 50 に整数化される', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, '50.7');
    expect(readReorderThreshold()).toBe(50);
  });

  it('S-12-07: 既存 localStorage に不正値が残っていても read は安全 (破壊的書き戻しなし)', () => {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, 'garbage');
    const value = readReorderThreshold();
    expect(value).toBe(DEFAULT_REORDER_THRESHOLD);
    // read 自体は localStorage を書き換えない
    expect(localStorage.getItem(REORDER_THRESHOLD_STORAGE_KEY)).toBe('garbage');
  });
});

describe('writeReorderThreshold', () => {
  it('S-12-06a: 範囲内の値はそのまま保存し、その値を返す', () => {
    const ret = writeReorderThreshold(70);
    expect(ret).toBe(70);
    expect(localStorage.getItem(REORDER_THRESHOLD_STORAGE_KEY)).toBe('70');
  });

  it('S-12-06b: 下限未満 (-5) を渡すと MIN に clamp して保存する', () => {
    const ret = writeReorderThreshold(-5);
    expect(ret).toBe(REORDER_THRESHOLD_MIN);
    expect(localStorage.getItem(REORDER_THRESHOLD_STORAGE_KEY)).toBe(
      String(REORDER_THRESHOLD_MIN),
    );
  });

  it('S-12-06c: 上限超過 (500) を渡すと MAX に clamp して保存する', () => {
    const ret = writeReorderThreshold(500);
    expect(ret).toBe(REORDER_THRESHOLD_MAX);
    expect(localStorage.getItem(REORDER_THRESHOLD_STORAGE_KEY)).toBe(
      String(REORDER_THRESHOLD_MAX),
    );
  });

  it('S-12-06d: write した値は read で取得できる (round-trip)', () => {
    writeReorderThreshold(33);
    expect(readReorderThreshold()).toBe(33);
  });
});
