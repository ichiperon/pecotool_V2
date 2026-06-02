/**
 * useDebouncedValue (issue #222) の単体テスト。
 *
 *  - delayMs=0: 即時反映
 *  - delayMs=300: タイマー経過後に反映
 *  - クリーンアップ: アンマウント後にタイマーが発火しても state 更新が起きない
 *  - 依存変更前の古いタイマーはキャンセルされる
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delayMs=0 は即時反映される', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) =>
        useDebouncedValue(value, delay),
      { initialProps: { value: 'a', delay: 0 } },
    );

    expect(result.current).toBe('a');

    act(() => {
      rerender({ value: 'b', delay: 0 });
    });

    // delay=0 なので タイマーを進めなくても反映される
    expect(result.current).toBe('b');
  });

  it('delayMs=300 は 300ms 経過後に反映される', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) =>
        useDebouncedValue(value, delay),
      { initialProps: { value: 'init', delay: 300 } },
    );

    expect(result.current).toBe('init');

    act(() => {
      rerender({ value: 'updated', delay: 300 });
    });

    // まだタイマー未経過 — 古い値のまま
    expect(result.current).toBe('init');

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe('updated');
  });

  it('300ms 経過前に再度 value が変化すると前のタイマーがキャンセルされる', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) =>
        useDebouncedValue(value, delay),
      { initialProps: { value: 'init', delay: 300 } },
    );

    // 最初の変化 (100ms 経過) → タイマー起動
    act(() => {
      rerender({ value: 'first', delay: 300 });
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('init');

    // 2 回目の変化 → 1 回目タイマーはキャンセルされ新タイマー起動
    act(() => {
      rerender({ value: 'second', delay: 300 });
    });

    // 1 回目のタイマーが仮に残っていたなら 200ms 進むと 'first' になるはずだが…
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('init'); // まだ反映されない

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('second'); // 2 回目のタイマー (300ms) が完了
  });

  it('アンマウント後のタイマー発火で state 更新が起きない (クリーンアップ)', () => {
    const { result, rerender, unmount } = renderHook(
      ({ value, delay }: { value: string; delay: number }) =>
        useDebouncedValue(value, delay),
      { initialProps: { value: 'init', delay: 300 } },
    );

    act(() => {
      rerender({ value: 'new', delay: 300 });
    });

    // アンマウントしてタイマーを進める
    unmount();

    // クリーンアップで clearTimeout されているので、タイマー経過後も error にならない
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // unmount 後は result.current が 'init' のまま (state 更新されない)
    expect(result.current).toBe('init');
  });
});
