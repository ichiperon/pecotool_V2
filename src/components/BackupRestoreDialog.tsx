import { useState } from 'react';
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
  // Issue #169: 破棄ボタンは 2 段階確認方式。同時に確認状態に入れるのは 1 つのバックアップのみ。
  const [confirmDiscardPath, setConfirmDiscardPath] = useState<string | null>(null);

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
            前回の作業バックアップが見つかりました
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
            aria-label="閉じて次回起動時に再表示する"
            className="backup-restore-close-btn"
            style={{
              background: 'none', border: 'none',
              cursor: isAnyProcessing ? 'not-allowed' : 'pointer',
              color: '#6c7086', padding: '2px',
              opacity: isAnyProcessing ? 0.4 : 1,
            }}
            title={isAnyProcessing ? '復元中は閉じられません' : '保留する（次回起動時に再表示）'}
          >
            <X size={18} />
          </button>
        </div>

        {/* 本文 */}
        <div style={{ padding: '16px' }}>
          <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#a6adc8', lineHeight: 1.6 }}>
            前回の終了時に保存されなかった編集内容が見つかりました。
            <br />
            「復元する」「破棄する」または ✕（次回起動時に再表示）から操作を選んでください。
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {backups.map((backup) => {
              const isProcessing = processingFilePath === backup.file_path;
              const isConfirmingDiscard = confirmDiscardPath === backup.file_path;
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
                  {/* #364: 元 PDF がバックアップより新しい場合の注意喚起（自動破棄はしない） */}
                  {backup.is_stale && (
                    <div style={{ fontSize: '11px', color: '#f9e2af', marginBottom: '10px', lineHeight: 1.5 }}>
                      このバックアップより新しい保存済みファイルがあります。復元すると保存済みの内容より古い状態に戻る可能性があります。
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {isProcessing ? (
                      <button
                        type="button"
                        onClick={() => onRestore(backup)}
                        disabled={isAnyProcessing}
                        aria-busy="true"
                        className="backup-restore-action-btn backup-restore-action-btn--restore"
                      >
                        <RotateCcw size={13} />
                        復元中...
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRestore(backup)}
                        disabled={isAnyProcessing}
                        aria-busy="false"
                        className="backup-restore-action-btn backup-restore-action-btn--restore"
                      >
                        <RotateCcw size={13} />
                        復元する
                      </button>
                    )}
                    {isConfirmingDiscard ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDiscardPath(null);
                          onDiscard(backup);
                        }}
                        disabled={isAnyProcessing}
                        aria-pressed="true"
                        className="backup-restore-action-btn backup-restore-action-btn--discard-confirm"
                      >
                        <Trash2 size={13} />
                        本当に破棄する
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDiscardPath(backup.file_path)}
                        disabled={isAnyProcessing}
                        aria-pressed="false"
                        className="backup-restore-action-btn backup-restore-action-btn--discard"
                      >
                        <Trash2 size={13} />
                        破棄する
                      </button>
                    )}
                    {isConfirmingDiscard && (
                      <button
                        type="button"
                        onClick={() => setConfirmDiscardPath(null)}
                        disabled={isAnyProcessing}
                        className="backup-restore-action-btn backup-restore-action-btn--cancel"
                      >
                        キャンセル
                      </button>
                    )}
                    {isConfirmingDiscard && (
                      <span style={{ fontSize: '11px', color: '#f9e2af', marginLeft: '4px' }}>
                        もう一度押すと破棄します
                      </span>
                    )}
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
          fontSize: '11px', color: isAnyProcessing ? '#f9e2af' : '#585b70', textAlign: 'right',
        }}>
          {/* #83: 処理中は close 自体が disabled なので、文言も整合させる。 */}
          {isAnyProcessing
            ? '復元処理中はダイアログを閉じられません'
            : '✕ で閉じると次回起動時にも復元候補として表示されます'}
        </div>
    </Modal>
  );
}
