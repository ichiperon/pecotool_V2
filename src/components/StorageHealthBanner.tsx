import { useCallback } from 'react';
import {
  useInfraStore,
  selectLastIdbError,
  selectStorageWarning,
  selectBboxMetaUnreadable,
} from '../store/infraStore';

/**
 * ストレージ健全性・ファイル健全性に関する警告バナー。
 *
 * 優先順位:
 *   1. IDB 書込失敗（lastIdbError が非 null）→ 失敗通知
 *   2. OCR メタ decode 不能（bboxMetaUnreadable）→ 編集が保存に反映されない旨（#392）
 *   3. 容量逼迫 critical → 強い警告
 *   4. 容量逼迫 warn → 軽い警告
 *
 * いずれも無ければ何も表示しない。
 */
export function StorageHealthBanner() {
  const lastIdbError = useInfraStore(selectLastIdbError);
  const bboxMetaUnreadable = useInfraStore(selectBboxMetaUnreadable);
  const storageWarning = useInfraStore(selectStorageWarning);
  const clearLastIdbError = useInfraStore(s => s.clearLastIdbError);
  const setBboxMetaUnreadable = useInfraStore(s => s.setBboxMetaUnreadable);

  const handleDismiss = useCallback(() => {
    clearLastIdbError();
  }, [clearLastIdbError]);

  // IDB 書込失敗が最優先
  if (lastIdbError !== null) {
    return (
      <div
        className="storage-health-banner storage-health-banner--error"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        <span className="storage-health-banner__icon" aria-hidden="true">⚠</span>
        <span className="storage-health-banner__message">
          一時データの保存に失敗しました。編集内容を失わないよう、ファイルを保存してください。
        </span>
        <button
          type="button"
          className="storage-health-banner__close"
          onClick={handleDismiss}
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
    );
  }

  // #392: 開いているファイルの OCR メタが decode 不能 → 編集が保存に反映されない旨を警告
  if (bboxMetaUnreadable) {
    return (
      <div
        className="storage-health-banner storage-health-banner--warn"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="storage-health-banner__icon" aria-hidden="true">ℹ</span>
        <span className="storage-health-banner__message">
          このPDFには、本バージョンで読み込めないOCRデータが含まれています。編集内容はこのファイルには保存されません（必要な変更は別名で書き出してください）。
        </span>
        <button
          type="button"
          className="storage-health-banner__close"
          onClick={() => setBboxMetaUnreadable(false)}
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
    );
  }

  // 容量逼迫の警告
  if (storageWarning !== null) {
    const percent = Math.round(storageWarning.ratio * 100);
    const isCritical = storageWarning.level === 'critical';

    return (
      <div
        className={`storage-health-banner ${isCritical ? 'storage-health-banner--critical' : 'storage-health-banner--warn'}`}
        role={isCritical ? 'alert' : 'status'}
        aria-live={isCritical ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <span className="storage-health-banner__icon" aria-hidden="true">
          {isCritical ? '⚠' : 'ℹ'}
        </span>
        <span className="storage-health-banner__message">
          {isCritical
            ? `ストレージ残量がわずかです（使用率 ${percent}%）。データ保護のため、いま編集中のファイルを保存することを強く推奨します。`
            : `ストレージの空き容量が少なくなっています（使用率 ${percent}%）。編集中のファイルは早めに保存してください。`}
        </span>
      </div>
    );
  }

  return null;
}
