import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import { getAllTemporaryPageData } from '../utils/pdfLoader';
import { resolveDisplayIndex } from '../utils/pageOrder';
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
/**
 * 直近編集からこの時間以上経過していないとバックアップを実行しない（debounce）。
 * 5分間隔の固定タイマー (#24) で大型 PDF 編集中に UI スレッドを掴まないよう、
 * 「ユーザーが直近 N ms 操作していないとき」に限定する。
 */
const DEFAULT_QUIET_PERIOD_MS = 60 * 1000;

// プロトタイプ汚染攻撃を防ぐため、キー名として危険なものを拒否する
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * issue #144: textBlocks 配列内の任意 object も含めて再帰的に own-key を検査する。
 * 浅いチェック (page own-key のみ) だと、textBlock の任意プロパティ (bbox や
 * 将来追加される object) に __proto__: {...} を埋め込まれて
 * JSON.parse 経由でプロトタイプ汚染される余地が残るため、深さ制限付きで
 * 全 nested object/array を辿って危険キーを reject する。
 */
const MAX_RECURSION_DEPTH = 16;
function hasDangerousKeyDeep(value: unknown, depth = 0): boolean {
  if (depth > MAX_RECURSION_DEPTH) return true; // 深すぎる入力は安全側で reject
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasDangerousKeyDeep(item, depth + 1)) return true;
    }
    return false;
  }
  // own enumerable key のみを検査 (Object.keys は own enumerable string key)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKeyDeep((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

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
  // issue #18 / #144: プロトタイプ汚染を防止。pages 配下の textBlocks や
  // 任意 nested object まで再帰で危険キーを reject する。
  if (hasDangerousKeyDeep(pages)) return false;
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
  quietPeriodMs = DEFAULT_QUIET_PERIOD_MS,
  /**
   * issue #137: useFileOperations の保存中フラグ。手動保存と auto backup が
   * 同一ファイルへ並走するのを防ぐため、共有 ref を受け取って performBackup
   * 冒頭でガードする。未指定時は従来挙動 (auto backup のみのローカルガード)。
   */
  externalIsSavingRef?: RefObject<boolean>,
  /**
   * PCT-055: バックアップ完了時に呼ばれるコールバック。
   * 完了日時 (HH:MM 形式) を引数に取る。通知 UI の実装は呼び出し元に委ねる。
   */
  onBackupComplete?: (timeLabel: string) => void,
) {
  const isSavingRef = useRef(false);
  /**
   * PCT-055 (R04U-2): バックアップ実行中フラグ。
   * useTauriCloseGuard に渡してバックアップ中の window close を抑止する。
   */
  const isBackingUpRef = useRef(false);
  // 直近編集時刻 (epoch ms)。store の document.pages 参照が変わったタイミングで更新する。
  // 0 のときは「まだ編集なし」を意味し、performBackup はスキップする。
  const lastEditTimeRef = useRef(0);
  // コールバックを ref に保持して Effect の依存配列の問題を回避する
  const onBackupsFoundRef = useRef(onBackupsFound);
  onBackupsFoundRef.current = onBackupsFound;
  // PCT-055: onBackupComplete を ref に保持して performBackup の依存配列を安定させる。
  // 呼び出し元が useCallback を省略しても setInterval がリセットされない。
  const onBackupCompleteRef = useRef(onBackupComplete);
  onBackupCompleteRef.current = onBackupComplete;

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

  // 編集タイミングの追跡: store の document.pages 参照が変化したら lastEditTimeRef を更新する。
  // updatePageData は毎回 newPages Map を生成するため、参照変化 = 編集発生とみなせる。
  // ただし setDocument による新規 PDF オープンも pages 参照変化を伴うため、
  // filePath が同一 (= 既存ドキュメントへの編集) であることも併せて要求する (#67)。
  // これにより新規 PDF オープン直後の quietPeriodMs (60s) 期間中も
  // 編集発生時には正しく lastEditTimeRef が更新され、バックアップが取得できる。
  useEffect(() => {
    const unsubscribe = usePecoStore.subscribe((state, prev) => {
      const prevPath = prev.document?.filePath;
      const currPath = state.document?.filePath;
      // filePath が変わった (setDocument) 場合は編集とみなさない
      if (prevPath !== currPath) return;
      // filePath が同一かつ pages 参照が変わった = updatePageData 等による編集
      if (state.document?.pages !== prev.document?.pages) {
        lastEditTimeRef.current = Date.now();
      }
    });
    return () => { unsubscribe(); };
  }, []);

  /** ダーティページを収集してバックアップファイルへ書き出す */
  const performBackup = useCallback(async () => {
    if (isSavingRef.current) return;
    // issue #137: 手動保存中は同一ファイルへの並走を避けてスキップ
    if (externalIsSavingRef?.current) return;

    const state = usePecoStore.getState();
    const { document, isDirty } = state;

    // ダーティデータがなければスキップ (#24-b: Map 走査・stringify の前に早期 return)
    if (!document || !isDirty) return;

    // debounce: 直近編集から quietPeriodMs 以内なら待機 (#24-c)
    // ユーザーが連続編集中は重い JSON.stringify を走らせない。
    const lastEdit = lastEditTimeRef.current;
    if (lastEdit === 0 || Date.now() - lastEdit < quietPeriodMs) return;

    isSavingRef.current = true;
    // PCT-055 (R04U-2): バックアップ中フラグを立てて close guard に通知する
    isBackingUpRef.current = true;
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

      // PCT-104 (A-lite 段階2): IDB 退避済みのページをマージ（メモリ側が優先）。
      // idbDirtyPages は Map<pageId, Partial<PageData>> なので resolveDisplayIndex で変換。
      // dirtyPages のキーは displayIndex の文字列表現（復元時に parseInt で使われる）。
      {
        const pageOrder = usePecoStore.getState().pageOrder;
        for (const [pageId, page] of idbDirtyPages.entries()) {
          const display = resolveDisplayIndex(pageOrder, pageId);
          if (display < 0) continue;
          const key = String(display);
          if (!dirtyPages[key]) {
            const { thumbnail: _t, ...cleanPage } = page;
            // cleanPage は Partial のため PageData に満たない可能性があるが
            // バックアップ形式としては Partial 相当で許容する。
            dirtyPages[key] = cleanPage as Omit<PageData, 'thumbnail'>;
          }
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

      // PCT-055 (R04U-1): バックアップ完了を呼び出し元に通知する
      if (onBackupCompleteRef.current) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        onBackupCompleteRef.current(`${hh}:${mm}`);
      }
    } catch (e) {
      console.warn('[AutoBackup] バックアップ失敗:', e);
    } finally {
      isSavingRef.current = false;
      isBackingUpRef.current = false;
    }
  }, [quietPeriodMs, externalIsSavingRef]);

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

  return { clearBackup, loadBackupData, performBackup, isBackingUpRef };
}
