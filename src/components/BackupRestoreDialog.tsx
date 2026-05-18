import { X, RotateCcw, Trash2 } from 'lucide-react';
import type { PendingBackup } from '../hooks/useAutoBackup';
import { Modal, useModalTitleId } from './ui/Modal';

interface BackupRestoreDialogProps {
  backups: PendingBackup[];
  onRestore: (backup: PendingBackup) => void;
  onDiscard: (backup: PendingBackup) => void;
  onClose: () => void;
  processingFilePath?: string | null;
  /** Issue #42: 処理中に close 要求が来た時の通知 (Toast) ハンドラ */
  onCloseSuppressed?: () => void;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function shortenPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return filePath;
  return `.../${parts.slice(-2).join('/')}`;
}

export function BackupRestoreDialog({
  backups,
  onRestore,
  onDiscard,
  onClose,
  processingFilePath,
  onCloseSuppressed,
}: BackupRestoreDialogProps) {
  const titleId = useModalTitleId();
  // Issue #42: 復元 or 破棄処理が進行中なら、Esc / backdrop / ✕ どれでも閉じさせない
  const isAnyProcessing = processingFilePath != null;

  return (
    <Modal
      onClose={onClose}
      titleId={titleId}
      disableClose={isAnyProcessing}
      onCloseSuppressed={onCloseSuppressed}
      backdropClassName="backup-restore-backdrop"
      dialogClassName="backup-restore-dialog"
      backdropStyle={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      dialogStyle={{
        background: '#1e1e2e',
        border: '1px solid #3b3b52',
        borderRadius: '8px',
        width: '480px',
        maxWidth: '90vw',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        color: '#cdd6f4',
        fontFamily: 'inherit',
      }}
    >
        {/* ヘッダー */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid #3b3b52',
        }}>
          <div id={titleId} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 600 }}>
            <span style={{ fontSize: '16px' }}>⚠️</span>
            未保存の内容があります
          </div>
          <button
            onClick={() => {
              // Issue #42: 処理中は ✕ も握りつぶす (UI が disabled 表現も持つ)
              if (isAnyProcessing) {
                onCloseSuppressed?.();
                return;
              }
              onClose();
            }}
            disabled={isAnyProcessing}
            aria-label="閉じる"
            style={{
              background: 'none', border: 'none',
              cursor: isAnyProcessing ? 'not-allowed' : 'pointer',
              color: '#6c7086', padding: '2px',
              opacity: isAnyProcessing ? 0.4 : 1,
            }}
            title={isAnyProcessing ? '復元中は閉じられません' : '閉じる（破棄しない）'}
          >
            <X size={18} />
          </button>
        </div>

        {/* 本文 */}
        <div style={{ padding: '16px' }}>
          <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#a6adc8', lineHeight: 1.6 }}>
            前回の終了時に保存されなかった編集内容が見つかりました。復元するファイルを選択してください。
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {backups.map((backup) => {
              const isProcessing = processingFilePath === backup.file_path;
              return (
                <div key={backup.file_path} style={{
                  background: '#181825',
                  border: '1px solid #313244',
                  borderRadius: '6px',
                  padding: '12px 14px',
                  opacity: isAnyProcessing && !isProcessing ? 0.5 : 1,
                }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px', wordBreak: 'break-all' }}
                    title={backup.file_path}>
                    {shortenPath(backup.file_path)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6c7086', marginBottom: '10px' }}>
                    バックアップ日時: {formatTimestamp(backup.timestamp)}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => onRestore(backup)}
                      disabled={isAnyProcessing}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '6px 12px', border: 'none', borderRadius: '4px',
                        background: '#89b4fa', color: '#1e1e2e',
                        fontSize: '12px', fontWeight: 600,
                        cursor: isAnyProcessing ? 'not-allowed' : 'pointer',
                        opacity: isAnyProcessing ? 0.6 : 1,
                      }}
                    >
                      <RotateCcw size={13} />
                      {isProcessing ? '復元中...' : '復元する'}
                    </button>
                    <button
                      onClick={() => onDiscard(backup)}
                      disabled={isAnyProcessing}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '6px 12px', border: '1px solid #45475a', borderRadius: '4px',
                        background: 'transparent', color: '#f38ba8',
                        fontSize: '12px',
                        cursor: isAnyProcessing ? 'not-allowed' : 'pointer',
                        opacity: isAnyProcessing ? 0.6 : 1,
                      }}
                    >
                      <Trash2 size={13} />
                      破棄する
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* フッター */}
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid #3b3b52',
          fontSize: '11px', color: '#585b70', textAlign: 'right',
        }}>
          ✕ で閉じても、バックアップファイルは削除されません
        </div>
    </Modal>
  );
}
