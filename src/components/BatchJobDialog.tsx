/**
 * #195: BatchJobDialog — UI for folder-wide OCR batch processing.
 *
 * Lets the user select:
 *   - Folder (source PDFs)
 *   - Output directory (for exported text files and summary CSV)
 *   - Export format (txt / md / json / csv / none)
 *   - Save mode (overwrite original / sidecar .peco.pdf)
 *
 * Shows a per-file progress table while running.
 */

import React, { useCallback, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Play, X, RefreshCw } from 'lucide-react';
import type { BatchJob, ExportFormat, SaveMode } from '../hooks/useBatchJob';

interface BatchJobDialogProps {
  onClose: () => void;
  currentJob: BatchJob | null;
  isRunning: boolean;
  onStart: (folderPath: string, options: { outputDir: string; exportFormat: ExportFormat; saveMode: SaveMode }) => Promise<void>;
  onCancel: () => void;
  onResume: () => Promise<void>;
  onClear: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待機',
  processing: '処理中',
  done: '完了',
  error: 'エラー',
};

const STATUS_COLOR: Record<string, string> = {
  pending: '#9ca3af',
  processing: '#3b82f6',
  done: '#22c55e',
  error: '#ef4444',
};

export const BatchJobDialog: React.FC<BatchJobDialogProps> = ({
  onClose,
  currentJob,
  isRunning,
  onStart,
  onCancel,
  onResume,
  onClear,
}) => {
  const [folderPath, setFolderPath] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt');
  const [saveMode, setSaveMode] = useState<SaveMode>('overwrite');
  const [isStarting, setIsStarting] = useState(false);

  const handleBrowseFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === 'string') {
      setFolderPath(selected);
      if (!outputDir) setOutputDir(selected);
    }
  }, [outputDir]);

  const handleBrowseOutput = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === 'string') {
      setOutputDir(selected);
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!folderPath || !outputDir || isStarting || isRunning) return;
    setIsStarting(true);
    try {
      await onStart(folderPath, { outputDir, exportFormat, saveMode });
    } finally {
      setIsStarting(false);
    }
  }, [folderPath, outputDir, exportFormat, saveMode, isStarting, isRunning, onStart]);

  const handleResume = useCallback(async () => {
    await onResume();
  }, [onResume]);

  // ── Compute summary stats ─────────────────────────────────────────────
  const files = currentJob?.files ?? [];
  const doneCount = files.filter((f) => f.status === 'done').length;
  const errorCount = files.filter((f) => f.status === 'error').length;
  const totalCount = files.length;
  const hasIncomplete = files.some((f) => f.status === 'pending' || f.status === 'processing');
  const isFinished = currentJob?.finishedAt !== undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="フォルダ一括バッチ処理"
      className="batch-job-dialog-backdrop"
      // PCT-056: バッチ実行中はバックドロップクリックでダイアログを閉じない
      onClick={(e) => { if (e.target === e.currentTarget && !isRunning) onClose(); }}
    >
      <div
        className="batch-job-dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            フォルダ一括バッチ処理
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 4 }}
            title="閉じる"
          >
            <X size={18} />
          </button>
        </div>

        {/* Config form — only when no active job */}
        {!currentJob && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Folder */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              <span style={{ color: '#d1d5db' }}>対象フォルダ</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={folderPath}
                  readOnly
                  placeholder="フォルダを選択してください"
                  style={{
                    flex: 1,
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={handleBrowseFolder}
                  style={{
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12,
                  }}
                >
                  <FolderOpen size={14} />
                  参照
                </button>
              </div>
            </label>

            {/* Output dir */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              <span style={{ color: '#d1d5db' }}>出力先フォルダ</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={outputDir}
                  readOnly
                  placeholder="出力先を選択してください（省略時は対象フォルダと同じ）"
                  style={{
                    flex: 1,
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={handleBrowseOutput}
                  style={{
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12,
                  }}
                >
                  <FolderOpen size={14} />
                  参照
                </button>
              </div>
            </label>

            {/* Options row */}
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: 1 }}>
                <span style={{ color: '#d1d5db' }}>テキストエクスポート</span>
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  style={{
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    fontSize: 12,
                  }}
                >
                  <option value="txt">TXT</option>
                  <option value="md">Markdown</option>
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="none">エクスポートなし</option>
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: 1 }}>
                <span style={{ color: '#d1d5db' }}>PDF保存モード</span>
                <select
                  value={saveMode}
                  onChange={(e) => setSaveMode(e.target.value as SaveMode)}
                  style={{
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#f9fafb',
                    fontSize: 12,
                  }}
                >
                  <option value="overwrite">上書き保存</option>
                  <option value="sidecar">サイドカー (.peco.pdf)</option>
                </select>
              </label>
            </div>

            {/* Start button */}
            <button
              onClick={handleStart}
              disabled={!folderPath || !outputDir || isStarting}
              style={{
                background: folderPath && outputDir && !isStarting ? '#3b82f6' : '#374151',
                border: 'none',
                borderRadius: 4,
                padding: '8px 16px',
                color: '#f9fafb',
                cursor: folderPath && outputDir && !isStarting ? 'pointer' : 'not-allowed',
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <Play size={14} />
              {isStarting ? '開始中...' : '一括処理を開始'}
            </button>
          </div>
        )}

        {/* Job status */}
        {currentJob && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Summary bar */}
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#d1d5db' }}>
              <span>合計: {totalCount} 件</span>
              <span style={{ color: '#22c55e' }}>完了: {doneCount}</span>
              {errorCount > 0 && <span style={{ color: '#ef4444' }}>エラー: {errorCount}</span>}
              {isFinished && !currentJob.cancelled && <span style={{ color: '#22c55e', fontWeight: 600 }}>処理完了</span>}
              {currentJob.cancelled && <span style={{ color: '#f59e0b', fontWeight: 600 }}>キャンセル済み</span>}
            </div>

            {/* Progress table */}
            <div
              style={{
                overflowY: 'auto',
                maxHeight: 340,
                border: '1px solid #374151',
                borderRadius: 4,
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#111827', position: 'sticky', top: 0 }}>
                    <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca3af', fontWeight: 500 }}>ファイル名</th>
                    <th style={{ textAlign: 'center', padding: '6px 10px', color: '#9ca3af', fontWeight: 500 }}>状態</th>
                    <th style={{ textAlign: 'right', padding: '6px 10px', color: '#9ca3af', fontWeight: 500 }}>ページ数</th>
                    <th style={{ textAlign: 'right', padding: '6px 10px', color: '#9ca3af', fontWeight: 500 }}>OCR時間</th>
                    <th style={{ textAlign: 'right', padding: '6px 10px', color: '#9ca3af', fontWeight: 500 }}>エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {currentJob.files.map((f, idx) => {
                    const name = f.path.split(/[\\/]/).pop() ?? f.path;
                    return (
                      <tr
                        key={idx}
                        title={f.error ?? ''}
                        style={{
                          background: idx % 2 === 0 ? '#1f2937' : '#111827',
                          borderBottom: '1px solid #374151',
                        }}
                      >
                        <td style={{ padding: '5px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {name}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'center' }}>
                          <span style={{ color: STATUS_COLOR[f.status] ?? '#9ca3af' }}>
                            {STATUS_LABEL[f.status] ?? f.status}
                          </span>
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#d1d5db' }}>
                          {f.pageCount !== undefined ? f.pageCount : '-'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#d1d5db' }}>
                          {f.ocrDurationMs !== undefined
                            ? `${(f.ocrDurationMs / 1000).toFixed(1)}s`
                            : '-'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: f.ocrErrorCount ? '#f59e0b' : '#d1d5db' }}>
                          {f.ocrErrorCount !== undefined ? f.ocrErrorCount : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              {isRunning && (
                <button
                  onClick={onCancel}
                  style={{
                    background: '#dc2626',
                    border: 'none',
                    borderRadius: 4,
                    padding: '7px 14px',
                    color: '#f9fafb',
                    cursor: 'pointer',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <X size={13} />
                  キャンセル
                </button>
              )}
              {!isRunning && hasIncomplete && (
                <button
                  onClick={handleResume}
                  style={{
                    background: '#059669',
                    border: 'none',
                    borderRadius: 4,
                    padding: '7px 14px',
                    color: '#f9fafb',
                    cursor: 'pointer',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <RefreshCw size={13} />
                  再開
                </button>
              )}
              {!isRunning && !hasIncomplete && (
                <button
                  onClick={onClear}
                  style={{
                    background: '#374151',
                    border: '1px solid #4b5563',
                    borderRadius: 4,
                    padding: '7px 14px',
                    color: '#f9fafb',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  クリア
                </button>
              )}
            </div>

            {/* Output dir info */}
            {currentJob.outputDir && (
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                出力先: {currentJob.outputDir}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
