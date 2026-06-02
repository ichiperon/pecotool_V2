import { useEffect, useState } from 'react';

/**
 * issue #222: value を delayMs ミリ秒 debounce して返す汎用フック。
 * delayMs=0 のときは即時反映 (setEffect なしで同期的に更新)。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delayMs === 0) {
      setDebounced(value);
      return;
    }
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
