import { useEffect, useRef } from 'react';
import { useInfraStore } from '../store/infraStore';
import type { StorageWarning } from '../store/infraStore';

/** 使用率がこの値以上で 'warn' レベルの警告を出す */
const WARN_RATIO = 0.8;
/** 使用率がこの値以上で 'critical' レベルの警告を出す */
const CRITICAL_RATIO = 0.95;
/** 定期チェックの間隔（ミリ秒）。ドキュメントが表示中の場合のみ実行される。 */
const CHECK_INTERVAL_MS = 60_000;

/**
 * ストレージ容量の逼迫を定期的に監視し、infraStore の storageWarning を更新するフック。
 *
 * - navigator.storage が存在しない環境では完全に no-op となる（クラッシュしない）。
 * - 初回マウント時に navigator.storage.persist() を一度呼び、永続ストレージ権限を要求する。
 * - 使用率が閾値未満のときは storageWarning を null にリセットする。
 * - 同一レベルが続く場合は再 set しない（余分な再レンダーを抑制）。
 */
export function useStorageQuotaMonitor(): void {
  const setStorageWarning = useInfraStore(s => s.setStorageWarning);
  const clearStorageWarning = useInfraStore(s => s.clearStorageWarning);

  // 最後に設定したレベルを保持し、値が変わった時のみ set する
  const lastLevelRef = useRef<StorageWarning['level'] | 'none'>('none');

  useEffect(() => {
    // navigator.storage 非対応環境では完全 no-op
    if (typeof navigator === 'undefined' || !navigator.storage) return;

    // 永続ストレージ権限を要求（失敗は握りつぶす）
    navigator.storage.persist?.().catch(() => {
      // 権限取得失敗は無視する
    });

    const check = async () => {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;

        if (quota === 0) return;

        const ratio = usage / quota;

        let nextLevel: StorageWarning['level'] | 'none';
        if (ratio >= CRITICAL_RATIO) {
          nextLevel = 'critical';
        } else if (ratio >= WARN_RATIO) {
          nextLevel = 'warn';
        } else {
          nextLevel = 'none';
        }

        // 値が変わった時のみ store を更新（余分な再レンダーを抑制）
        if (nextLevel === lastLevelRef.current) return;

        lastLevelRef.current = nextLevel;

        if (nextLevel === 'none') {
          clearStorageWarning();
        } else {
          setStorageWarning({ ratio, level: nextLevel });
        }
      } catch {
        // estimate() 失敗は無視する（非対応環境でのフォールバック）
      }
    };

    // 初回チェック
    void check();

    // 定期チェック（ドキュメントが非表示の間はスキップ）
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [setStorageWarning, clearStorageWarning]);
}
