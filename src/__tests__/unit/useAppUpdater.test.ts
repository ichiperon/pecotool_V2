/**
 * useAppUpdater のステートトランジション回帰テスト (Feature #202)
 *
 * checkForUpdateAdapter を DI (adapter 引数) でモックすることで、
 * @tauri-apps/plugin-updater が node_modules に存在しない状態でも
 * check / downloadAndInstall の全ステートを網羅的に検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppUpdater, type UpdaterUpdate } from '../../hooks/useAppUpdater';

// ── ヘルパー ────────────────────────────────────────────────────

type FakeInstall = ReturnType<typeof vi.fn>;

function makeFakeUpdate(overrides?: Partial<UpdaterUpdate & { downloadAndInstall: FakeInstall }>): UpdaterUpdate {
  return {
    available: true,
    version: '2.1.0',
    body: 'バグ修正',
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── テスト ──────────────────────────────────────────────────────

describe('useAppUpdater', () => {
  let mockAdapter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAdapter = vi.fn();
  });

  it('初期状態は isChecking=false, available=null, error=null', () => {
    const { result } = renderHook(() => useAppUpdater(mockAdapter));
    expect(result.current.state.isChecking).toBe(false);
    expect(result.current.state.available).toBeNull();
    expect(result.current.state.error).toBeNull();
  });

  it('checkForUpdate: アップデートあり → available にバージョン/notes がセットされる', async () => {
    mockAdapter.mockResolvedValue(makeFakeUpdate());

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.state.isChecking).toBe(false);
    expect(result.current.state.available).toEqual({ version: '2.1.0', notes: 'バグ修正' });
    expect(result.current.state.error).toBeNull();
  });

  it('checkForUpdate: body=null の場合 notes が undefined', async () => {
    mockAdapter.mockResolvedValue(makeFakeUpdate({ body: null }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.state.available).toEqual({ version: '2.1.0', notes: undefined });
  });

  it('checkForUpdate: アップデートなし (null) → available が null のまま', async () => {
    mockAdapter.mockResolvedValue(null);

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.state.isChecking).toBe(false);
    expect(result.current.state.available).toBeNull();
    expect(result.current.state.error).toBeNull();
  });

  it('checkForUpdate: available=false オブジェクト → available が null', async () => {
    mockAdapter.mockResolvedValue(makeFakeUpdate({ available: false }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.state.available).toBeNull();
  });

  it('checkForUpdate: エラー時 → error がセットされ isChecking=false', async () => {
    mockAdapter.mockRejectedValue(new Error('network timeout'));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.state.isChecking).toBe(false);
    expect(result.current.state.error).toBe('network timeout');
    expect(result.current.state.available).toBeNull();
  });

  it('downloadAndInstall: プログレスコールバックが呼ばれ、完了後 isDownloading=false', async () => {
    const mockInstall = vi.fn().mockImplementation(
      async (cb: (p: { chunkLength: number; contentLength: number | null }) => void) => {
        cb({ chunkLength: 512, contentLength: 1024 });
        cb({ chunkLength: 512, contentLength: 1024 });
      },
    );
    mockAdapter.mockResolvedValue(makeFakeUpdate({ downloadAndInstall: mockInstall }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(result.current.state.isDownloading).toBe(false);
    expect(mockInstall).toHaveBeenCalledOnce();
  });

  it('downloadAndInstall: update 未チェックの場合は何もしない', async () => {
    const { result } = renderHook(() => useAppUpdater(mockAdapter));
    // checkForUpdate を呼ばずに downloadAndInstall → no-op
    await act(async () => {
      await result.current.downloadAndInstall();
    });
    expect(result.current.state.isDownloading).toBe(false);
    expect(mockAdapter).not.toHaveBeenCalled();
  });

  it('downloadAndInstall: エラー時 → error がセットされる', async () => {
    const mockInstall = vi.fn().mockRejectedValue(new Error('install failed'));
    mockAdapter.mockResolvedValue(makeFakeUpdate({ downloadAndInstall: mockInstall }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));

    await act(async () => {
      await result.current.checkForUpdate();
    });

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(result.current.state.isDownloading).toBe(false);
    expect(result.current.state.error).toBe('install failed');
  });

  it("downloadAndInstall: エラー時の戻り値は 'error'、成功時は 'success'", async () => {
    const mockInstall = vi.fn().mockRejectedValue(new Error('install failed'));
    mockAdapter.mockResolvedValue(makeFakeUpdate({ downloadAndInstall: mockInstall }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));
    await act(async () => {
      await result.current.checkForUpdate();
    });

    let downloadResult: string | undefined;
    await act(async () => {
      downloadResult = await result.current.downloadAndInstall();
    });
    expect(downloadResult).toBe('error');
  });

  it("downloadAndInstall: 二重呼び出しは拒否され ('busy')、実際のプラグイン呼び出しは1回だけ (Wave4 多重起動ガード)", async () => {
    // 1つ目の呼び出しがまだ pending の間に2つ目を呼んでも、
    // 実際のダウンロード処理 (update.downloadAndInstall) は1回しか実行されないこと。
    let resolveInstall: (() => void) | undefined;
    const mockInstall = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveInstall = resolve; }),
    );
    mockAdapter.mockResolvedValue(makeFakeUpdate({ downloadAndInstall: mockInstall }));

    const { result } = renderHook(() => useAppUpdater(mockAdapter));
    await act(async () => {
      await result.current.checkForUpdate();
    });

    let firstResult: string | undefined;
    let secondResult: string | undefined;
    await act(async () => {
      const p1 = result.current.downloadAndInstall().then(r => { firstResult = r; });
      // 1つ目がまだ pending (resolveInstall 未呼び出し) の間に2つ目を呼ぶ。
      secondResult = await result.current.downloadAndInstall();
      resolveInstall?.();
      await p1;
    });

    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe('busy');
    expect(firstResult).toBe('success');
    expect(result.current.state.isDownloading).toBe(false);
  });
});
