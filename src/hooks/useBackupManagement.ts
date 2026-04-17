import { useState } from 'react';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { useAutoBackup, PendingBackup } from './useAutoBackup';

interface UseBackupManagementOptions {
  showToast: (message: string, isError?: boolean) => void;
  handleOpen: (path: string) => Promise<boolean | void>;
}

// バックアップ復元ダイアログ周りの state とハンドラを集約
export function useBackupManagement({ showToast, handleOpen }: UseBackupManagementOptions) {
  const [pendingBackups, setPendingBackups] = useState<PendingBackup[]>([]);
  const [processingBackupPath, setProcessingBackupPath] = useState<string | null>(null);

  const { clearBackup, loadBackupData } = useAutoBackup((backups) => setPendingBackups(backups));

  const handleRestoreBackup = async (backup: PendingBackup) => {
    if (processingBackupPath) return;
    const data = await loadBackupData(backup.file_path);
    if (!data?.pages) {
      showToast('バックアップデータの読み込みに失敗しました。', true);
      return;
    }
    setProcessingBackupPath(backup.file_path);
    try {
      usePecoStore.getState().setPendingRestoration(data.pages);
      const success = await handleOpen(backup.file_path);
      if (!success) {
        usePecoStore.getState().setPendingRestoration(null);
        return;
      }
      // IDB への復元書き込みが完了してからバックアップファイルを削除する
      await waitForPendingIdbSaves();
      await clearBackup(backup.file_path);
      setPendingBackups((prev) => prev.filter((b) => b.file_path !== backup.file_path));
    } finally {
      setProcessingBackupPath(null);
    }
  };

  const handleDiscardBackup = async (backup: PendingBackup) => {
    if (processingBackupPath) return;
    setProcessingBackupPath(backup.file_path);
    try {
      await clearBackup(backup.file_path);
      setPendingBackups((prev) => prev.filter((b) => b.file_path !== backup.file_path));
    } finally {
      setProcessingBackupPath(null);
    }
  };

  return {
    pendingBackups,
    setPendingBackups,
    processingBackupPath,
    handleRestoreBackup,
    handleDiscardBackup,
  };
}
