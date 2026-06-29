/**
 * useStorageQuotaMonitor のユニットテスト。
 *
 * navigator.storage をモック/削除してストアへの反映を確認する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInfraStore } from '../../store/infraStore';
import { useStorageQuotaMonitor } from '../../hooks/useStorageQuotaMonitor';

// zustand ストアを各テスト前にリセット
beforeEach(() => {
  useInfraStore.setState({
    documentEpoch: 0,
    pageAccessOrder: [],
    pendingRestoration: null,
    lastIdbError: null,
    storageWarning: null,
    currentPageProxy: null,
    currentPageProxyKey: null,
  });
  vi.clearAllMocks();
  // visibilityState をデフォルト 'visible' にする
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// navigator.storage モックのヘルパー
function mockStorageEstimate(usage: number, quota: number) {
  const estimateMock = vi.fn().mockResolvedValue({ usage, quota });
  const persistMock = vi.fn().mockResolvedValue(true);
  Object.defineProperty(navigator, 'storage', {
    value: { estimate: estimateMock, persist: persistMock },
    configurable: true,
    writable: true,
  });
  return { estimateMock, persistMock };
}

function removeNavigatorStorage() {
  Object.defineProperty(navigator, 'storage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe('U-SQM-01: 使用率 0.85 → warn レベルで storageWarning が設定される', () => {
  it('ratio=0.85 のとき storageWarning.level が "warn" になる', async () => {
    mockStorageEstimate(85, 100);

    const { unmount } = renderHook(() => useStorageQuotaMonitor());

    // estimate() は Promise なので act で非同期処理を流す
    await act(async () => {
      await Promise.resolve();
    });

    const warning = useInfraStore.getState().storageWarning;
    expect(warning).not.toBeNull();
    expect(warning?.level).toBe('warn');
    expect(warning?.ratio).toBeCloseTo(0.85, 5);

    unmount();
  });
});

describe('U-SQM-02: 使用率 0.97 → critical レベルで storageWarning が設定される', () => {
  it('ratio=0.97 のとき storageWarning.level が "critical" になる', async () => {
    mockStorageEstimate(97, 100);

    const { unmount } = renderHook(() => useStorageQuotaMonitor());

    await act(async () => {
      await Promise.resolve();
    });

    const warning = useInfraStore.getState().storageWarning;
    expect(warning).not.toBeNull();
    expect(warning?.level).toBe('critical');

    unmount();
  });
});

describe('U-SQM-03: 使用率 0.5 → 警告なし（storageWarning は null のまま）', () => {
  it('ratio=0.5 のとき storageWarning が null のまま', async () => {
    mockStorageEstimate(50, 100);

    const { unmount } = renderHook(() => useStorageQuotaMonitor());

    await act(async () => {
      await Promise.resolve();
    });

    expect(useInfraStore.getState().storageWarning).toBeNull();

    unmount();
  });
});

describe('U-SQM-04: navigator.storage が存在しない環境では no-op（例外なし）', () => {
  it('navigator.storage が undefined でもエラーがスローされない', async () => {
    removeNavigatorStorage();

    let error: unknown = null;
    try {
      const { unmount } = renderHook(() => useStorageQuotaMonitor());

      await act(async () => {
        await Promise.resolve();
      });

      // storageWarning は null のまま
      expect(useInfraStore.getState().storageWarning).toBeNull();

      unmount();
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
  });
});

describe('U-SQM-05: 同一レベルが続く場合は store を再 set しない（dedup）', () => {
  it('60s 後に同じ warn を再チェックしても setStorageWarning は再呼び出しされない', async () => {
    vi.useFakeTimers();
    try {
      mockStorageEstimate(85, 100);

      const setStorageWarningSpy = vi.spyOn(
        useInfraStore.getState(),
        'setStorageWarning',
      );

      const { unmount } = renderHook(() => useStorageQuotaMonitor());

      // 初回 check（mount 時の void check()）を流す → warn が 1 回 set される
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(setStorageWarningSpy.mock.calls.length).toBe(1);

      // 60s（hook の CHECK_INTERVAL_MS）進めて interval の2回目 check を起こす
      // （同一 warn レベル・visibility=visible）。dedup が無いと2回目も set されて
      // count=2 になる＝この advance が検出力の核。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // dedup により同一レベルでは再 set されない（dedup を削ると 2 になり赤）
      expect(setStorageWarningSpy.mock.calls.length).toBe(1);

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('U-SQM-06: quota が 0 の場合は no-op', () => {
  it('quota=0 のとき storageWarning が null のまま', async () => {
    mockStorageEstimate(0, 0);

    const { unmount } = renderHook(() => useStorageQuotaMonitor());

    await act(async () => {
      await Promise.resolve();
    });

    expect(useInfraStore.getState().storageWarning).toBeNull();

    unmount();
  });
});
