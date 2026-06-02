/**
 * #195: Batch job hook — folder-wide OCR + save + text export.
 *
 * Responsibilities:
 *   - Manage a BatchJob object (files, statuses, output options)
 *   - Persist job state to localStorage for resume-on-restart
 *   - Drive the execution loop: open PDF → OCR all pages → save PDF → export text
 *   - Produce a summary CSV on job completion
 *   - Support cancel and resume
 */

import { useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { usePecoStore } from '../store/pecoStore';
import { exportTextFromDocument } from '../utils/textExport';
import { getSharedPdfProxy } from '../utils/pdfLoader';

const STORAGE_KEY = 'peco-batch-job-v1';

// ── Types ────────────────────────────────────────────────────────────────────

export type ExportFormat = 'txt' | 'md' | 'json' | 'csv' | 'none';
export type SaveMode = 'overwrite' | 'sidecar';

export interface BatchFileEntry {
  path: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  /** Set on error. */
  error?: string;
  /** Page count (resolved after open). */
  pageCount?: number;
  /** OCR duration in ms. */
  ocrDurationMs?: number;
  /** Number of pages that had OCR errors. */
  ocrErrorCount?: number;
  /** Path to the exported text file (if any). */
  exportPath?: string;
}

export interface BatchJob {
  id: string;
  folderPath: string;
  files: BatchFileEntry[];
  outputDir: string;
  exportFormat: ExportFormat;
  saveMode: SaveMode;
  startedAt?: number;
  finishedAt?: number;
  cancelled?: boolean;
}

export interface JobOptions {
  outputDir: string;
  exportFormat: ExportFormat;
  saveMode: SaveMode;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function persistJob(job: BatchJob | null): void {
  try {
    if (job === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
    }
  } catch {
    // localStorage quota errors are non-fatal
  }
}

function loadPersistedJob(): BatchJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      return parsed as BatchJob;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Summary CSV ───────────────────────────────────────────────────────────────

function buildSummaryCsv(files: BatchFileEntry[]): string {
  const header = 'filename,pageCount,ocrDurationMs,ocrErrorCount,exportPath';
  const rows = files.map((f) => {
    const name = f.path.split(/[\\/]/).pop() ?? f.path;
    const cols = [
      name,
      String(f.pageCount ?? ''),
      String(f.ocrDurationMs ?? ''),
      String(f.ocrErrorCount ?? ''),
      f.exportPath ?? '',
    ];
    return cols
      .map((v) => (/[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
      .join(',');
  });
  return [header, ...rows].join('\r\n');
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseBatchJobCallbacks {
  /** Open a PDF and return true on success. Must use bypassOcrGuard. */
  openPdf: (filePath: string) => Promise<boolean>;
  /** Run OCR on all pages of the current document and return true on success. */
  runOcrAllPagesSilent: () => Promise<boolean>;
  /** Save the current document and return true on success. */
  savePdf: () => Promise<boolean>;
  /** Show a toast notification. */
  showToast: (msg: string, isError?: boolean) => void;
}

export function useBatchJob(callbacks: UseBatchJobCallbacks) {
  const [currentJob, setCurrentJob] = useState<BatchJob | null>(() => {
    // Restore an incomplete job on mount (resume-on-restart)
    const persisted = loadPersistedJob();
    if (!persisted) return null;
    // Only restore if there are still pending files
    const hasPending = persisted.files.some((f) => f.status === 'pending' || f.status === 'processing');
    if (!hasPending) return null;
    // Reset any "processing" entries back to "pending" (interrupted mid-run)
    const restored: BatchJob = {
      ...persisted,
      files: persisted.files.map((f) =>
        f.status === 'processing' ? { ...f, status: 'pending' } : f,
      ),
      cancelled: false,
    };
    return restored;
  });

  const cancelledRef = useRef(false);
  const isRunningRef = useRef(false);

  // ── Internal execution loop ─────────────────────────────────────────────

  const executeLoop = useCallback(
    async (job: BatchJob): Promise<void> => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      cancelledRef.current = false;

      const update = (updater: (j: BatchJob) => BatchJob) => {
        setCurrentJob((prev) => {
          if (!prev) return prev;
          const next = updater(prev);
          persistJob(next);
          return next;
        });
      };

      try {
        for (let i = 0; i < job.files.length; i++) {
          if (cancelledRef.current) break;

          const entry = job.files[i];
          if (entry.status !== 'pending') continue;

          // Mark as processing
          update((j) => ({
            ...j,
            files: j.files.map((f, idx) =>
              idx === i ? { ...f, status: 'processing' } : f,
            ),
          }));

          const filePath = entry.path;
          const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
          const ocrStart = performance.now();
          let ocrErrorCount = 0;
          let pageCount = 0;
          let exportPath: string | undefined;
          let errorMsg: string | undefined;

          try {
            // 1. Open PDF
            const opened = await callbacks.openPdf(filePath);
            if (!opened) {
              throw new Error('PDFを開けませんでした');
            }

            // 2. Get page count from store
            const doc = usePecoStore.getState().document;
            if (!doc || doc.filePath !== filePath) {
              throw new Error('PDFのロードに失敗しました');
            }
            pageCount = doc.totalPages;

            // 3. Count pages with existing OCR errors before OCR
            const preOcrErrorCount = Array.from(doc.pages.values()).filter(
              (p) => (p.textBlocks?.length ?? 0) === 0,
            ).length;

            // 4. Run OCR all pages
            const ocrOk = await callbacks.runOcrAllPagesSilent();
            if (cancelledRef.current) break;

            if (!ocrOk) {
              throw new Error('OCRに失敗しました');
            }

            // 5. Measure OCR error count (pages still empty after OCR)
            const postDoc = usePecoStore.getState().document;
            if (postDoc && postDoc.filePath === filePath) {
              ocrErrorCount = Array.from(postDoc.pages.values()).filter(
                (p) => (p.textBlocks?.length ?? 0) === 0,
              ).length;
              // Clamp: only count pages that were newly empty (not pre-existing empties)
              ocrErrorCount = Math.max(0, ocrErrorCount - preOcrErrorCount);
            }

            // 6. Save PDF
            let savePath = filePath;
            if (job.saveMode === 'sidecar') {
              const stem = fileName.replace(/\.pdf$/i, '');
              savePath = await join(job.outputDir, `${stem}.peco.pdf`);
            }

            const saveOk =
              job.saveMode === 'overwrite'
                ? await callbacks.savePdf()
                : await saveSidecar(savePath, callbacks.showToast);

            if (!saveOk) {
              throw new Error('PDFの保存に失敗しました');
            }

            // 7. Export text (if requested)
            if (job.exportFormat !== 'none') {
              const exportDoc = usePecoStore.getState().document;
              if (exportDoc && exportDoc.filePath === filePath) {
                const stem = fileName.replace(/\.pdf$/i, '');
                const ext = job.exportFormat;
                const exportFileName = `${stem}.ocr.${ext}`;
                exportPath = await join(job.outputDir, exportFileName);
                const text = exportTextFromDocument(exportDoc, job.exportFormat as 'txt' | 'md' | 'json' | 'csv');
                await writeTextFile(exportPath, text);
              }
            }

            // Mark done
            const ocrMs = Math.round(performance.now() - ocrStart);
            update((j) => ({
              ...j,
              files: j.files.map((f, idx) =>
                idx === i
                  ? {
                      ...f,
                      status: 'done',
                      pageCount,
                      ocrDurationMs: ocrMs,
                      ocrErrorCount,
                      exportPath,
                    }
                  : f,
              ),
            }));
          } catch (e) {
            errorMsg = e instanceof Error ? e.message : String(e);
            console.error(`[BatchJob] ${fileName} failed:`, e);
            update((j) => ({
              ...j,
              files: j.files.map((f, idx) =>
                idx === i
                  ? { ...f, status: 'error', error: errorMsg, pageCount, ocrDurationMs: Math.round(performance.now() - ocrStart), ocrErrorCount }
                  : f,
              ),
            }));
          }
        } // end for loop

        // Finalize
        const wasCancelled = cancelledRef.current;
        let finalJob: BatchJob | null = null;
        update((j) => {
          const next: BatchJob = { ...j, finishedAt: Date.now(), cancelled: wasCancelled };
          finalJob = next;
          return next;
        });

        // Write summary CSV
        if (finalJob) {
          const { outputDir, files } = finalJob as BatchJob;
          try {
            const csvPath = await join(outputDir, '_summary.csv');
            await writeTextFile(csvPath, buildSummaryCsv(files));
            callbacks.showToast(`バッチ処理完了。サマリ: ${csvPath}`);
          } catch (e) {
            console.warn('[BatchJob] summary CSV write failed:', e);
            callbacks.showToast(wasCancelled ? 'バッチ処理をキャンセルしました' : 'バッチ処理が完了しました');
          }
        }
      } finally {
        isRunningRef.current = false;
      }
    },
    [callbacks],
  );

  // ── Public API ──────────────────────────────────────────────────────────

  const startJob = useCallback(
    async (folderPath: string, options: JobOptions): Promise<void> => {
      if (isRunningRef.current) return;

      let pdfFiles: string[];
      try {
        pdfFiles = await invoke<string[]>('list_pdf_files_in_folder', {
          folderPath,
        });
      } catch (e) {
        callbacks.showToast(`PDF一覧の取得に失敗しました: ${e}`, true);
        return;
      }

      if (pdfFiles.length === 0) {
        callbacks.showToast('フォルダ内にPDFが見つかりませんでした。');
        return;
      }

      const job: BatchJob = {
        id: crypto.randomUUID(),
        folderPath,
        files: pdfFiles.map((p) => ({ path: p, status: 'pending' })),
        outputDir: options.outputDir,
        exportFormat: options.exportFormat,
        saveMode: options.saveMode,
        startedAt: Date.now(),
      };

      persistJob(job);
      setCurrentJob(job);
      await executeLoop(job);
    },
    [callbacks, executeLoop],
  );

  const cancelJob = useCallback((): void => {
    cancelledRef.current = true;
  }, []);

  const resumeJob = useCallback(async (): Promise<void> => {
    if (isRunningRef.current) return;
    const job = currentJob;
    if (!job) return;
    // Reset any stuck processing entries
    const resumable: BatchJob = {
      ...job,
      cancelled: false,
      files: job.files.map((f) =>
        f.status === 'processing' ? { ...f, status: 'pending' } : f,
      ),
    };
    persistJob(resumable);
    setCurrentJob(resumable);
    await executeLoop(resumable);
  }, [currentJob, executeLoop]);

  const clearJob = useCallback((): void => {
    persistJob(null);
    setCurrentJob(null);
  }, []);

  return {
    currentJob,
    isRunning: isRunningRef.current,
    startJob,
    cancelJob,
    resumeJob,
    clearJob,
  };
}

// ── Sidecar save helper ───────────────────────────────────────────────────────

/**
 * Save the current document to a custom path (sidecar mode).
 * This is a simplified path that writes the PDF bytes to the given target.
 * Returns true on success.
 */
async function saveSidecar(
  targetPath: string,
  showToast: (msg: string, isError?: boolean) => void,
): Promise<boolean> {
  try {
    const doc = usePecoStore.getState().document;
    if (!doc) return false;

    // Get PDF bytes via pdfjs proxy
    const pdf = await getSharedPdfProxy(doc.filePath);
    // pdfjs PDFDocumentProxy.getData() returns the original bytes
    const data = await (pdf as { getData(): Promise<Uint8Array> }).getData();

    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(targetPath, data);
    return true;
  } catch (e) {
    console.error('[BatchJob] sidecar save failed:', e);
    showToast(`サイドカー保存に失敗しました: ${e}`, true);
    return false;
  }
}
