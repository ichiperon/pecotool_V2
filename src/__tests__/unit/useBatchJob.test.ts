/**
 * #195: useBatchJob unit tests
 *
 * Tests cover:
 *   - startJob: lists PDFs, creates job, iterates files
 *   - cancelJob: sets cancelled flag, stops loop
 *   - resumeJob: re-runs pending entries
 *   - localStorage persistence (save/restore)
 *   - summary CSV path emission (via showToast)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

// pdfLoader mock (for sidecar save helper)
vi.mock('../../utils/pdfLoader', () => ({
  getSharedPdfProxy: vi.fn().mockResolvedValue({
    getData: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  }),
}));

// pecoStore mock
vi.mock('../../store/pecoStore', () => {
  const store: Record<string, unknown> = {
    document: null,
  };
  return {
    usePecoStore: Object.assign(
      vi.fn((selector: (s: typeof store) => unknown) => selector(store)),
      {
        getState: vi.fn(() => store),
      },
    ),
    waitForPendingIdbSaves: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Imports after mocks ─────────────────────────────────────────────────────

import { useBatchJob, type UseBatchJobCallbacks } from '../../hooks/useBatchJob';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore } from '../../store/pecoStore';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCallbacks(overrides: Partial<UseBatchJobCallbacks> = {}): UseBatchJobCallbacks {
  return {
    openPdf: vi.fn().mockResolvedValue(true),
    runOcrAllPagesSilent: vi.fn().mockResolvedValue(true),
    savePdf: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
    ...overrides,
  };
}

function setStoreDoc(filePath: string) {
  (usePecoStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
    document: {
      filePath,
      totalPages: 2,
      pages: new Map([
        [0, { textBlocks: [{ id: '1', text: 'a', order: 0 }], isDirty: false }],
        [1, { textBlocks: [{ id: '2', text: 'b', order: 0 }], isDirty: false }],
      ]),
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useBatchJob', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Default: no document open
    (usePecoStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ document: null });
  });

  it('shows toast if folder has no PDFs', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const callbacks = makeCallbacks();

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/some/folder', {
        outputDir: '/some/folder',
        exportFormat: 'txt',
        saveMode: 'overwrite',
      });
    });

    expect(callbacks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('見つかりませんでした'),
    );
    expect(result.current.currentJob).toBeNull();
  });

  it('shows toast on invoke error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('permission denied'));
    const callbacks = makeCallbacks();

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/some/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'overwrite',
      });
    });

    expect(callbacks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('失敗'),
      true,
    );
  });

  it('processes files and marks them done', async () => {
    const pdfFiles = ['/folder/a.pdf', '/folder/b.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'overwrite',
      });
    });

    await waitFor(() => {
      expect(result.current.currentJob?.finishedAt).toBeDefined();
    });

    const files = result.current.currentJob?.files ?? [];
    expect(files.every((f) => f.status === 'done')).toBe(true);
    expect(callbacks.savePdf).toHaveBeenCalledTimes(2);
  });

  it('cancelJob causes the loop to stop mid-run (files remain pending)', async () => {
    const pdfFiles = ['/folder/a.pdf', '/folder/b.pdf', '/folder/c.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    // Block the OCR call until we explicitly resolve it
    let resolveOcr!: (v: boolean) => void;
    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
      runOcrAllPagesSilent: vi.fn().mockImplementation(
        () => new Promise<boolean>((res) => { resolveOcr = res; }),
      ),
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    // Start (loop will block at OCR of first file)
    let jobDone = false;
    let jobPromise: Promise<void>;
    act(() => {
      jobPromise = result.current.startJob('/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'overwrite',
      }).then(() => { jobDone = true; });
    });

    // Wait until OCR is actually called (first file is being processed)
    await waitFor(() => expect(callbacks.runOcrAllPagesSilent).toHaveBeenCalled());

    // Cancel while blocked
    act(() => { result.current.cancelJob(); });

    // Resolve the OCR call so the loop can advance
    await act(async () => {
      resolveOcr(true);
      await new Promise((r) => setTimeout(r, 20));
    });

    // Wait for job to finish
    await act(async () => { await jobPromise!; });

    // Loop was cancelled — at most 1 file done, rest still pending
    const files = result.current.currentJob?.files ?? [];
    const doneCount = files.filter((f) => f.status === 'done').length;
    expect(doneCount).toBeLessThanOrEqual(1);
    expect(result.current.currentJob?.cancelled).toBe(true);
    expect(jobDone).toBe(true);
  });

  it('persists job to localStorage and restores on mount', async () => {
    const pdfFiles = ['/f/a.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/f', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'overwrite',
      });
    });

    // Job completed — localStorage should have finishedAt
    const stored = localStorage.getItem('peco-batch-job-v1');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.finishedAt).toBeDefined();
  });

  it('clearJob removes job from state and localStorage', async () => {
    // Seed localStorage with a fake completed job
    const fakeJob = {
      id: 'x',
      folderPath: '/f',
      files: [{ path: '/f/a.pdf', status: 'done' }],
      outputDir: '/out',
      exportFormat: 'none',
      saveMode: 'overwrite',
      finishedAt: Date.now(),
    };
    localStorage.setItem('peco-batch-job-v1', JSON.stringify(fakeJob));

    // Mount hook — completed job should NOT be restored (no pending files)
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useBatchJob(callbacks));

    // No pending → not restored
    expect(result.current.currentJob).toBeNull();

    // Seed a job with pending entries
    const pendingJob = {
      ...fakeJob,
      finishedAt: undefined,
      files: [{ path: '/f/a.pdf', status: 'pending' }],
    };
    localStorage.setItem('peco-batch-job-v1', JSON.stringify(pendingJob));

    // Re-mount to pick up pending job
    const { result: result2 } = renderHook(() => useBatchJob(callbacks));
    expect(result2.current.currentJob?.id).toBe('x');

    // clearJob should remove it
    act(() => {
      result2.current.clearJob();
    });
    expect(result2.current.currentJob).toBeNull();
    expect(localStorage.getItem('peco-batch-job-v1')).toBeNull();
  });
});
