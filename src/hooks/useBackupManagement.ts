import { useState } from 'react';
import type { RefObject } from 'react';
import { waitForPendingIdbSaves } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import { useAutoBackup, PendingBackup } from './useAutoBackup';

interface UseBackupManagementOptions {
  showToast: (message: string, isError?: boolean) => void;
  handleOpen: (path: string) => Promise<boolean | void>;
  /**
   * issue #137: 手動保存中フラグ。useFileOperations の isSavingRef を渡して、
   * 自動バックアップが手動保存と並走しないようガードする。
   */
  externalIsSavingRef?: RefObject<boolean>;
}

// バックアップ復元ダイアログ周りの state とハンドラを集約
export function useBackupManagement({ showToast, handleOpen, externalIsSavingRef }: UseBackupManagementOptions) {
  const [pendingBackups, setPendingBackups] = useState<PendingBackup[]>([]);
  const [processingBackupPath, setProcessingBackupPath] = useState<string | null>(null);

  // PCT-055 (R04U-1): バックアップ完了時に控えめなトーストで通知する
  const handleBackupComplete = (timeLabel: string) => {
    showToast(`自動保存しました（${timeLabel}）`);
  };

  const { clearBackup, loadBackupData, isBackingUpRef } = useAutoBackup(
    (backups) => setPendingBackups(backups),
    undefined,
    undefined,
    externalIsSavingRef,
    handleBackupComplete,
  );

  const handleRestoreBackup = async (backup: PendingBackup) => {
    // PCT-207: 以前は processingBackupPath チェックの後に loadBackupData を await して
    // いたため、その await 窓の間に別の復元操作 (連打・別バックアップの選択) が
    // このガードを素通りして二重進入できた。setPendingRestoration は setDocument 側で
    // 「次に走った setDocument」が無条件に拾う共有ステートのため、二重進入すると
    // 復元データが別ファイルに誤って適用され得る。ガードを最初の await より前に置き、
    // 同期的に再入を閉じる。
    if (processingBackupPath) return;
    setProcessingBackupPath(backup.file_path);
    try {
      const data = await loadBackupData(backup.file_path);
      if (!data?.pages) {
        showToast('バックアップデータの読み込みに失敗しました。', true);
        return;
      }
      useInfraStore.getState().setPendingRestoration(data.pages);
      const success = await handleOpen(backup.file_path);
      if (!success) {
        useInfraStore.getState().setPendingRestoration(null);
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
    /** PCT-055 (R04U-2): バックアップ中フラグ。useTauriCloseGuard に渡して close 抑止に使う */
    isBackingUpRef,
  };
}
