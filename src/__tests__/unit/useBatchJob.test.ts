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
    savePdfAs: vi.fn().mockResolvedValue(true),
    // issue #252: getDocumentSnapshot delegates to the mocked store
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDocumentSnapshot: vi.fn(() => (usePecoStore.getState() as any).document ?? null),
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

  // ── wave 5 additions ──────────────────────────────────────────────────────

  it('resumeJob only processes pending entries, not already-done ones', async () => {
    // Seed localStorage with a job that has 1 done + 1 pending entry
    const seedJob = {
      id: 'resume-test',
      folderPath: '/f',
      files: [
        { path: '/f/done.pdf', status: 'done' },
        { path: '/f/pending.pdf', status: 'pending' },
      ],
      outputDir: '/out',
      exportFormat: 'none',
      saveMode: 'overwrite',
      startedAt: Date.now(),
    };
    localStorage.setItem('peco-batch-job-v1', JSON.stringify(seedJob));

    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    // Mount should restore the pending job
    expect(result.current.currentJob?.id).toBe('resume-test');

    await act(async () => {
      await result.current.resumeJob();
    });

    await waitFor(() => {
      expect(result.current.currentJob?.finishedAt).toBeDefined();
    });

    const files = result.current.currentJob?.files ?? [];
    // done.pdf must remain done (openPdf not called for it)
    expect(files[0].status).toBe('done');
    // pending.pdf must be processed
    expect(files[1].status).toBe('done');
    // openPdf must only have been called once (for pending.pdf)
    expect(callbacks.openPdf).toHaveBeenCalledTimes(1);
    expect(callbacks.openPdf).toHaveBeenCalledWith('/f/pending.pdf');
  });

  it('sidecar save mode: savePdfAs callback is called with sidecar path; savePdf is NOT called', async () => {
    const pdfFiles = ['/folder/a.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    const savePdfAs = vi.fn().mockResolvedValue(true);
    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
      savePdfAs,
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'sidecar',
      });
    });

    await waitFor(() => {
      expect(result.current.currentJob?.finishedAt).toBeDefined();
    });

    // issue #243: sidecar mode must use savePdfAs (OCR-aware), not raw savePdf
    expect(callbacks.savePdf).not.toHaveBeenCalled();
    expect(savePdfAs).toHaveBeenCalledTimes(1);
    // sidecar path must be <outputDir>/<stem>.peco.pdf
    expect(savePdfAs).toHaveBeenCalledWith('/out/a.peco.pdf');
  });

  it('sidecar save mode: shows toast and marks file error when savePdfAs is not provided', async () => {
    const pdfFiles = ['/folder/a.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
      savePdfAs: undefined,
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    await act(async () => {
      await result.current.startJob('/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'sidecar',
      });
    });

    await waitFor(() => {
      expect(result.current.currentJob?.finishedAt).toBeDefined();
    });

    expect(callbacks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('savePdfAs'),
      true,
    );
    expect(result.current.currentJob?.files[0].status).toBe('error');
  });

  it('clearJob after completed job removes localStorage entry', async () => {
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

    await waitFor(() => expect(result.current.currentJob?.finishedAt).toBeDefined());

    // localStorage should have the completed job
    expect(localStorage.getItem('peco-batch-job-v1')).not.toBeNull();

    // clearJob removes it
    act(() => {
      result.current.clearJob();
    });

    expect(result.current.currentJob).toBeNull();
    expect(localStorage.getItem('peco-batch-job-v1')).toBeNull();
  });

  it('processing-status entries are reset to pending on resume (interrupted job)', async () => {
    // Simulate a job that was interrupted mid-processing
    const seedJob = {
      id: 'interrupted',
      folderPath: '/f',
      files: [
        { path: '/f/a.pdf', status: 'processing' }, // was in-flight when app crashed
        { path: '/f/b.pdf', status: 'pending' },
      ],
      outputDir: '/out',
      exportFormat: 'none',
      saveMode: 'overwrite',
      startedAt: Date.now(),
    };
    localStorage.setItem('peco-batch-job-v1', JSON.stringify(seedJob));

    const callbacks = makeCallbacks({
      openPdf: vi.fn().mockImplementation(async (path: string) => {
        setStoreDoc(path);
        return true;
      }),
    });

    const { result } = renderHook(() => useBatchJob(callbacks));

    // On mount, processing → pending reset should happen
    const restored = result.current.currentJob;
    expect(restored).not.toBeNull();
    expect(restored?.files[0].status).toBe('pending');
    expect(restored?.files[1].status).toBe('pending');

    // Both files should be processed after resume
    await act(async () => {
      await result.current.resumeJob();
    });

    await waitFor(() => expect(result.current.currentJob?.finishedAt).toBeDefined());

    const files = result.current.currentJob?.files ?? [];
    expect(files.every((f) => f.status === 'done')).toBe(true);
    expect(callbacks.openPdf).toHaveBeenCalledTimes(2);
  });

  // ── issue #245: isRunning as React state ─────────────────────────────────

  it('isRunning is true while executeLoop is running, false after it finishes', async () => {
    const pdfFiles = ['/folder/a.pdf'];
    vi.mocked(invoke).mockResolvedValueOnce(pdfFiles);

    // Block OCR so we can observe isRunning=true mid-run
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

    // isRunning starts false
    expect(result.current.isRunning).toBe(false);

    let jobPromise: Promise<void>;
    act(() => {
      jobPromise = result.current.startJob('/folder', {
        outputDir: '/out',
        exportFormat: 'none',
        saveMode: 'overwrite',
      });
    });

    // Wait until OCR is blocked (loop is running)
    await waitFor(() => expect(callbacks.runOcrAllPagesSilent).toHaveBeenCalled());

    // isRunning must be true while loop is active
    expect(result.current.isRunning).toBe(true);

    // Unblock and finish
    await act(async () => {
      resolveOcr(true);
      await jobPromise!;
    });

    // isRunning must be false after loop finishes
    expect(result.current.isRunning).toBe(false);
  });
});
