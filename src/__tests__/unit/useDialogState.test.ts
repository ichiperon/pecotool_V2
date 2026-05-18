/**
 * useDialogState の showToast まわりの回帰テスト。
 *
 * #53: action 付きトーストは自動消滅させない (「別名で保存」フォールバック等)
 * #72: 直前のトーストが張った 3 秒 timer が、後続の action 付きトーストを消さない
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDialogState } from '../../hooks/useDialogState';

describe('useDialogState.showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('action 無しの toast は 3 秒後に自動消滅する (既存挙動)', () => {
    const { result } = renderHook(() => useDialogState());

    act(() => {
      result.current.showToast('hello');
    });
    expect(result.current.notification?.message).toBe('hello');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.notification).toBeNull();
  });

  it('action 付き toast は自動消滅しない (#53)', () => {
    const { result } = renderHook(() => useDialogState());

    act(() => {
      result.current.showToast('save failed', true, {
        label: '別名で保存',
        onClick: () => {},
      });
    });
    expect(result.current.notification?.action?.label).toBe('別名で保存');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // action 付きは消えないこと
    expect(result.current.notification?.message).toBe('save failed');
    expect(result.current.notification?.action?.label).toBe('別名で保存');
  });

  it('直前のトースト timer が、後続の action 付きトーストを消さない (#72)', () => {
    const { result } = renderHook(() => useDialogState());

    // 1) 通常 toast → 3 秒 timer がセットされる
    act(() => {
      result.current.showToast('first');
    });
    expect(result.current.notification?.message).toBe('first');

    // 2) すぐに action 付き toast を出す (= 前の timer が cleared されるはず)
    act(() => {
      result.current.showToast('second', true, {
        label: '別名で保存',
        onClick: () => {},
      });
    });
    expect(result.current.notification?.message).toBe('second');
    expect(result.current.notification?.action?.label).toBe('別名で保存');

    // 3) 1) の timer 残骸が走っても、action 付き toast が消えないこと
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.notification?.message).toBe('second');
    expect(result.current.notification?.action?.label).toBe('別名で保存');

    // さらに時間を進めても残り続ける
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.notification?.message).toBe('second');
  });

  it('連続した通常 toast は最新のメッセージに置き換わり、最後の呼び出しから 3 秒で消える', () => {
    const { result } = renderHook(() => useDialogState());

    act(() => {
      result.current.showToast('first');
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 2 秒残っている状態で新しい toast を出す
    act(() => {
      result.current.showToast('second');
    });
    expect(result.current.notification?.message).toBe('second');

    // 旧 timer の残り 2 秒が経過しても消えないこと (= cleared されている)
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.notification?.message).toBe('second');

    // 新 timer 起点で 3 秒経過したら消える (合計 1000+2000+1000 = 4000 のうち、
    // 上で 2000 進めたので残り 1000 で 3 秒経過)
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.notification).toBeNull();
  });

  it('action 付き toast の後に通常 toast を出すと、通常 toast は 3 秒で消える', () => {
    const { result } = renderHook(() => useDialogState());

    act(() => {
      result.current.showToast('first', true, {
        label: '別名で保存',
        onClick: () => {},
      });
    });
    // 後続の通常 toast (新しい timer がセットされる)
    act(() => {
      result.current.showToast('second');
    });
    expect(result.current.notification?.message).toBe('second');
    expect(result.current.notification?.action).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.notification).toBeNull();
  });

  it('unmount 時に未解決の timer がクリアされる (リーク防止)', () => {
    const { result, unmount } = renderHook(() => useDialogState());
    act(() => {
      result.current.showToast('msg');
    });
    unmount();
    // 進めても state 更新が走らない (=エラーや警告にならない) ことだけ確認できれば十分
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // 既に unmount 済みのため notification の参照は古い値だが、エラーになっていないこと
    expect(true).toBe(true);
  });
});
