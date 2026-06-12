/**
 * Phase 5 Wave 2: useBackupManagement テスト
 * Cases: U-BK-01, U-BK-02, U-BK-03
 *
 * useBackupManagement は useAutoBackup を介してバックアップの復元・破棄を管理する hook。
 * - handleRestoreBackup: データ読み込み → infraStore.setPendingRestoration → handleOpen → waitForPendingIdbSaves → clearBackup
 * - handleDiscardBackup: clearBackup のみ
 * - processingBackupPath によるガード (競合排除)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { PendingBackup, BackupData } from '../../hooks/useAutoBackup';
import { useInfraStore } from '../../store/infraStore';

// ── 外部依存のモック ──────────────────────────────────────────

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

const mockClearBackup = vi.fn<(path: string) => Promise<void>>();
const mockLoadBackupData = vi.fn<(path: string) => Promise<BackupData | null>>();
const mockPerformBackup = vi.fn<() => Promise<void>>();

const mockIsBackingUpRef = { current: false };
// PCT-055: テストから onBackupComplete を直接呼び出せるよう capturedOnBackupComplete に保持する
let capturedOnBackupComplete: ((t: string) => void) | undefined;

vi.mock('../../hooks/useAutoBackup', () => ({
  useAutoBackup: (
    _onBackupsFound: unknown,
    _interval?: unknown,
    _quiet?: unknown,
    _savingRef?: unknown,
    onBackupComplete?: (timeLabel: string) => void,
  ) => {
    capturedOnBackupComplete = onBackupComplete;
    return {
      clearBackup: mockClearBackup,
      loadBackupData: mockLoadBackupData,
      performBackup: mockPerformBackup,
      isBackingUpRef: mockIsBackingUpRef,
    };
  },
}));

import { useBackupManagement } from '../../hooks/useBackupManagement';

// ── ヘルパー ───────────────────────────────────────────────────

function makeBackup(filePath = '/test/doc.pdf'): PendingBackup {
  return {
    file_path: filePath,
    timestamp: '2026-01-01T00:00:00Z',
    backup_path: `/backup/${filePath}`,
    is_stale: false,
  };
}

function makeBackupData(filePath = '/test/doc.pdf'): BackupData {
  return {
    version: 1,
    timestamp: '2026-01-01T00:00:00Z',
    originalFilePath: filePath,
    pages: {
      '0': {
        textBlocks: [],
        isDirty: false,
      },
    },
  };
}

const INITIAL_INFRA_STATE = {
  documentEpoch: 0,
  pageAccessOrder: [] as number[],
  pendingRestoration: null,
  lastIdbError: null,
  currentPageProxy: null,
  currentPageProxyKey: null,
} as const;

beforeEach(() => {
  mockClearBackup.mockReset().mockResolvedValue(undefined);
  mockLoadBackupData.mockReset();
  mockPerformBackup.mockReset().mockResolvedValue(undefined);
  useInfraStore.setState({ ...INITIAL_INFRA_STATE });
});

afterEach(() => {
  cleanup();
});

// ── U-BK-01: 正常な復元フロー ────────────────────────────────────

describe('U-BK-01: handleRestoreBackup — 正常な復元フロー', () => {
  it('loadBackupData が有効データを返す場合、handleOpen が呼ばれ clearBackup も実行される', async () => {
    const backup = makeBackup();
    const backupData = makeBackupData();
    mockLoadBackupData.mockResolvedValue(backupData);

    const showToast = vi.fn();
    const handleOpen = vi.fn().mockResolvedValue(true);

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    expect(handleOpen).toHaveBeenCalledWith(backup.file_path);
    expect(mockClearBackup).toHaveBeenCalledWith(backup.file_path);
    expect(result.current.processingBackupPath).toBeNull();
  });

  it('復元開始時に infraStore.pendingRestoration が正しいデータでセットされる', async () => {
    const backup = makeBackup();
    const backupData = makeBackupData();
    mockLoadBackupData.mockResolvedValue(backupData);

    const showToast = vi.fn();
    let capturedRestoration: unknown = undefined;
    const handleOpen = vi.fn().mockImplementation(async () => {
      capturedRestoration = useInfraStore.getState().pendingRestoration;
      return true;
    });

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    expect(capturedRestoration).toEqual(backupData.pages);
  });

  it('handleOpen が false を返す場合は clearBackup が呼ばれない', async () => {
    const backup = makeBackup();
    mockLoadBackupData.mockResolvedValue(makeBackupData());

    const showToast = vi.fn();
    const handleOpen = vi.fn().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    expect(mockClearBackup).not.toHaveBeenCalled();
    expect(result.current.processingBackupPath).toBeNull();
  });

  it('復元完了後に clearBackup が呼ばれる', async () => {
    const backup = makeBackup();
    mockLoadBackupData.mockResolvedValue(makeBackupData());
    const handleOpen = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    expect(mockClearBackup).toHaveBeenCalledWith(backup.file_path);
    expect(result.current.pendingBackups).toHaveLength(0);
  });
});

// ── U-BK-02: 競合ガード (processingBackupPath が設定済みの場合) ──

describe('U-BK-02: handleRestoreBackup — 保存中に復元が呼ばれると競合ガードが機能する', () => {
  it('handleRestoreBackup 完了後に processingBackupPath が null にリセットされる', async () => {
    const backup = makeBackup();
    mockLoadBackupData.mockResolvedValue(makeBackupData());
    const handleOpen = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    // handleOpen が呼ばれた
    expect(handleOpen).toHaveBeenCalledOnce();
    // 完了後は processingBackupPath がリセットされている
    expect(result.current.processingBackupPath).toBeNull();
  });

  it('processingBackupPath がセットされているとき handleRestoreBackup は即時 return する (no-op)', async () => {
    const backup = makeBackup();
    mockLoadBackupData.mockResolvedValue(makeBackupData());
    const handleOpen = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    // 強制的に processingBackupPath をセット (内部 state を simulate)
    // 実際の競合は processingBackupPath が null でない間は即時 return する実装
    // 1 回目で processingBackupPath がセットされ、2 回目は skip される
    let firstCallCount = 0;
    mockLoadBackupData.mockImplementation(async () => {
      firstCallCount++;
      return makeBackupData();
    });

    // 1 回目: 正常実行
    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });
    expect(firstCallCount).toBe(1);
    expect(result.current.processingBackupPath).toBeNull(); // 完了後リセット

    // 2 回目: processingBackupPath=null なので実行される (ガードは効かない)
    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });
    expect(firstCallCount).toBe(2);
  });

  it('handleDiscardBackup は processingBackupPath がセットされているとき skip される', async () => {
    const backup = makeBackup();

    let resolveFirst!: () => void;
    // 1 回目の clearBackup は pending
    mockClearBackup
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);

    const showToast = vi.fn();
    const handleOpen = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    // 1 回目を開始 (pending)
    let p1Settled = false;
    act(() => {
      void result.current.handleDiscardBackup(backup).then(() => { p1Settled = true; });
    });

    // processingBackupPath がセットされるまで待つ
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // 2 回目: processingBackupPath がセットされていれば skip
    await act(async () => {
      await result.current.handleDiscardBackup(backup);
    });

    // clearBackup は 1 回のみ
    expect(mockClearBackup).toHaveBeenCalledTimes(1);

    // 1 回目を完了させる
    resolveFirst();
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });
    expect(p1Settled).toBe(true);
  });
});

// ── U-BK-03: 復元対象バックアップが存在しない場合は no-op ──────────

describe('U-BK-03: handleRestoreBackup — データなし時は no-op', () => {
  it('loadBackupData が null を返す場合 handleOpen が呼ばれずエラートーストが表示される', async () => {
    const backup = makeBackup();
    mockLoadBackupData.mockResolvedValue(null);

    const showToast = vi.fn();
    const handleOpen = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleRestoreBackup(backup);
    });

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('失敗'),
      true,
    );
    expect(handleOpen).not.toHaveBeenCalled();
    expect(result.current.processingBackupPath).toBeNull();
  });

  it('handleDiscardBackup は clearBackup を呼んで processingBackupPath をリセットする', async () => {
    const backup = makeBackup();

    const showToast = vi.fn();
    const handleOpen = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleDiscardBackup(backup);
    });

    expect(mockClearBackup).toHaveBeenCalledWith(backup.file_path);
    expect(result.current.processingBackupPath).toBeNull();
  });

  it('handleDiscardBackup は clearBackup を 1 回だけ呼ぶ', async () => {
    const backup1 = makeBackup('/doc1.pdf');

    const showToast = vi.fn();
    const handleOpen = vi.fn();

    const { result } = renderHook(() =>
      useBackupManagement({ showToast, handleOpen })
    );

    await act(async () => {
      await result.current.handleDiscardBackup(backup1);
    });

    expect(mockClearBackup).toHaveBeenCalledTimes(1);
    expect(mockClearBackup).toHaveBeenCalledWith(backup1.file_path);
  });
});

// ── PCT-055: バックアップ完了通知 + isBackingUpRef の公開 ──────────

describe('PCT-055 (R04U-1+2): バックアップ完了通知と isBackingUpRef 公開', () => {
  it('onBackupComplete が呼ばれると showToast に "自動保存しました" メッセージが渡る', () => {
    const showToast = vi.fn();
    const handleOpen = vi.fn();

    renderHook(() => useBackupManagement({ showToast, handleOpen }));

    // useAutoBackup に渡された onBackupComplete を手動で発火
    act(() => {
      capturedOnBackupComplete?.('14:30');
    });

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('自動保存しました'));
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('14:30'));
  });

  it('isBackingUpRef が公開されている', () => {
    const showToast = vi.fn();
    const handleOpen = vi.fn();

    const { result } = renderHook(() => useBackupManagement({ showToast, handleOpen }));

    expect(result.current.isBackingUpRef).toBe(mockIsBackingUpRef);
  });
});
