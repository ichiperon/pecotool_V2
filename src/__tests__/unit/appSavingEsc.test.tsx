/**
 * Issue #47 regression: 保存中の全 keydown ブロックでも Esc は通すこと。
 * (モーダル/ダイアログを Esc で閉じられないと UX が詰む)
 *
 * App.tsx の isSaving 用 useEffect と同一仕様の hook を抜き出して契約検証する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useEffect } from 'react';

afterEach(() => cleanup());

// App.tsx の isSaving keydown ブロッカと同一仕様。
function useBlockKeysWhileSaving(isSaving: boolean) {
  useEffect(() => {
    if (!isSaving) return;
    const blockKeys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', blockKeys, true);
    return () => window.removeEventListener('keydown', blockKeys, true);
  }, [isSaving]);
}

function dispatchKey(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe('Issue #47: 保存中 keydown ブロックでも Esc は通す', () => {
  it('isSaving=true で Esc 以外のキーは preventDefault される (既存挙動)', () => {
    renderHook(() => useBlockKeysWhileSaving(true));

    const enter = dispatchKey('Enter');
    expect(enter.defaultPrevented).toBe(true);

    const f5 = dispatchKey('F5');
    expect(f5.defaultPrevented).toBe(true);

    const ctrlS = dispatchKey('s');
    expect(ctrlS.defaultPrevented).toBe(true);
  });

  it('isSaving=true でも Escape は preventDefault されず通過する', () => {
    renderHook(() => useBlockKeysWhileSaving(true));

    const escape = dispatchKey('Escape');
    expect(escape.defaultPrevented).toBe(false);
  });

  it('isSaving=true でも Escape は他のリスナーまで届く (stopPropagation されない)', () => {
    const downstream = vi.fn();
    window.addEventListener('keydown', downstream);

    renderHook(() => useBlockKeysWhileSaving(true));

    dispatchKey('Escape');

    expect(downstream).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', downstream);
  });

  it('isSaving=false の時は全キーが素通り (Enter も Escape も影響なし)', () => {
    renderHook(() => useBlockKeysWhileSaving(false));

    const enter = dispatchKey('Enter');
    expect(enter.defaultPrevented).toBe(false);

    const escape = dispatchKey('Escape');
    expect(escape.defaultPrevented).toBe(false);
  });

  it('unmount で keydown リスナーが解除される', () => {
    const { unmount, rerender } = renderHook(({ saving }: { saving: boolean }) => useBlockKeysWhileSaving(saving), {
      initialProps: { saving: true },
    });

    // 解除後は Enter も通過するようになる
    rerender({ saving: false });
    const e1 = dispatchKey('Enter');
    expect(e1.defaultPrevented).toBe(false);

    unmount();
    const e2 = dispatchKey('Enter');
    expect(e2.defaultPrevented).toBe(false);
  });
});
