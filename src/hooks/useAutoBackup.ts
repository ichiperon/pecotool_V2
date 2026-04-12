import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { getAllTemporaryPageData } from '../utils/pdfLoader';
import { PageData } from '../types';

export interface PendingBackup {
  file_path: string;
  timestamp: string;
  backup_path: string;
}

export interface BackupData {
  version: number;
  timestamp: string;
  originalFilePath: string;
  pages: Record<string, Partial<PageData>>;
}

/** デフォルトバックアップ間隔: 5分 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 自動バックアップフック。
 * - マウント時: 前回クラッシュ等のバックアップを検索して onBackupsFound を呼ぶ
 * - 一定間隔: アイドル時にダーティページをバックアップファイルへ書き出す（Rust スレッド）
 * - 正常保存時: clearBackup() を呼んでバックアップを削除する
 */
export function useAutoBackup(
  onBackupsFound: (backups: PendingBackup[]) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
) {
  const isSavingRef = useRef(false);
  // コールバックを ref に保持して Effect の依存配列の問題を回避する
  const onBackupsFoundRef = useRef(onBackupsFound);
  onBackupsFoundRef.current = onBackupsFound;

  // 起動時: 未処理バックアップをチェック
  useEffect(() => {
    invoke<PendingBackup[]>('check_pending_backups')
      .then((backups) => {
        if (backups.length > 0) {
          onBackupsFoundRef.current(backups);
        }
      })
      .catch((e) => console.warn('[AutoBackup] 起動時チェック失敗:', e));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** ダーティページを収集してバックアップファイルへ書き出す */
  const performBackup = useCallback(async () => {
    if (isSavingRef.current) return;

    const state = usePecoStore.getState();
    const { document, isDirty } = state;

    // ダーティデータがなければスキップ
    if (!document || !isDirty) return;

    isSavingRef.current = true;
    try {
      // LRU 退避の IDB 書き込みが完了してから読み込む
      await waitForPendingIdbSaves();
      const idbDirtyPages = await getAllTemporaryPageData(document.filePath);

      // メモリ上のダーティページを収集（サムネイルは除外）
      const dirtyPages: Record<string, Omit<PageData, 'thumbnail'>> = {};

      for (const [idx, page] of document.pages.entries()) {
        if (page.isDirty) {
          const { thumbnail: _t, ...cleanPage } = page;
          dirtyPages[String(idx)] = cleanPage;
        }
      }

      // IDB 退避済みのページをマージ（メモリ側が優先）
      for (const [idx, page] of idbDirtyPages.entries()) {
        const key = String(idx);
        if (!dirtyPages[key]) {
          const { thumbnail: _t, ...cleanPage } = page as any;
          dirtyPages[key] = cleanPage;
        }
      }

      if (Object.keys(dirtyPages).length === 0) return;

      const timestamp = new Date().toISOString();

      await invoke('save_backup', {
        filePath: document.filePath,
        timestamp,
        pagesJson: JSON.stringify(dirtyPages),
      });

      console.log(`[AutoBackup] バックアップ完了 (${Object.keys(dirtyPages).length}ページ): ${timestamp}`);
    } catch (e) {
      console.warn('[AutoBackup] バックアップ失敗:', e);
    } finally {
      isSavingRef.current = false;
    }
  }, []);

  // 定期実行タイマーの設定
  useEffect(() => {
    const scheduleBackup = () => {
      // requestIdleCallback がある環境では UI アイドル時のみ実行する
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => void performBackup(), { timeout: 30_000 });
      } else {
        void performBackup();
      }
    };

    const timerId = setInterval(scheduleBackup, intervalMs);
    return () => clearInterval(timerId);
  }, [performBackup, intervalMs]);

  /** 正常保存後にバックアップファイルを削除する */
  const clearBackup = useCallback(async (filePath: string) => {
    try {
      await invoke('clear_backup', { filePath });
    } catch (e) {
      console.warn('[AutoBackup] バックアップクリア失敗:', e);
    }
  }, []);

  /**
   * バックアップファイルを読み込んで BackupData を返す。
   * 復元 UI から呼ばれる。
   */
  const loadBackupData = useCallback(async (filePath: string): Promise<BackupData | null> => {
    try {
      const json = await invoke<string>('load_backup', { filePath });
      return JSON.parse(json) as BackupData;
    } catch (e) {
      console.warn('[AutoBackup] バックアップ読み込み失敗:', e);
      return null;
    }
  }, []);

  return { clearBackup, loadBackupData, performBackup };
}
