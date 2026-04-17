import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { getAllTemporaryPageData } from '../utils/pdfLoader';
import { PageData } from '../types';
import { logger } from '../utils/logger';

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

// プロトタイプ汚染攻撃を防ぐため、キー名として危険なものを拒否する
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidBBox(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height)
  );
}

// 改ざんされた JSON からの不正な textBlocks 注入・プロトタイプ汚染を防ぐため、
// 読み込み時にスキーマを詳細に検証する。
function isValidBackupData(data: unknown): data is BackupData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.version !== 'number') return false;
  if (typeof d.timestamp !== 'string') return false;
  if (typeof d.originalFilePath !== 'string') return false;
  if (typeof d.pages !== 'object' || d.pages === null) return false;
  const pages = d.pages as Record<string, unknown>;
  // プロトタイプ汚染を防止: __proto__ / constructor / prototype のキーを拒否
  for (const key of Object.keys(pages)) {
    if (DANGEROUS_KEYS.has(key)) return false;
  }
  for (const page of Object.values(pages)) {
    if (typeof page !== 'object' || page === null) return false;
    const p = page as Record<string, unknown>;
    // pages は Partial<PageData> のため全フィールドは必須ではない
    if (p.textBlocks !== undefined) {
      if (!Array.isArray(p.textBlocks)) return false;
      for (const block of p.textBlocks) {
        if (typeof block !== 'object' || block === null) return false;
        const b = block as Record<string, unknown>;
        if (typeof b.id !== 'string' || typeof b.text !== 'string') return false;
        // bbox は必須ではないが、存在する場合は形状を検証する
        if (b.bbox !== undefined && !isValidBBox(b.bbox)) return false;
        // writingMode のリテラル narrow
        if (b.writingMode !== undefined && b.writingMode !== 'vertical' && b.writingMode !== 'horizontal') {
          return false;
        }
        // order は非負整数
        if (b.order !== undefined && (!Number.isInteger(b.order) || (b.order as number) < 0)) {
          return false;
        }
      }
    }
  }
  return true;
}

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
          const { thumbnail: _t, ...cleanPage } = page;
          // cleanPage は Partial のため PageData に満たない可能性があるが
          // バックアップ形式としては Partial 相当で許容する。
          dirtyPages[key] = cleanPage as Omit<PageData, 'thumbnail'>;
        }
      }

      if (Object.keys(dirtyPages).length === 0) return;

      const timestamp = new Date().toISOString();

      await invoke('save_backup', {
        filePath: document.filePath,
        timestamp,
        pagesJson: JSON.stringify(dirtyPages),
      });

      logger.log(`[AutoBackup] バックアップ完了 (${Object.keys(dirtyPages).length}ページ): ${timestamp}`);
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
      const parsed: unknown = JSON.parse(json);
      if (!isValidBackupData(parsed)) {
        console.warn('[AutoBackup] バックアップ JSON のスキーマ検証に失敗しました');
        return null;
      }
      return parsed;
    } catch (e) {
      console.warn('[AutoBackup] バックアップ読み込み失敗:', e);
      return null;
    }
  }, []);

  return { clearBackup, loadBackupData, performBackup };
}
