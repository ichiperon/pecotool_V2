/** 並び替え閾値の localStorage キー名 */
export const REORDER_THRESHOLD_STORAGE_KEY = 'peco-reorder-threshold';

/** 並び替え閾値のデフォルト値（％） */
export const DEFAULT_REORDER_THRESHOLD = 50;

/** 並び替え閾値の有効範囲 */
export const REORDER_THRESHOLD_MIN = 1;
export const REORDER_THRESHOLD_MAX = 100;

/**
 * localStorage から並び替え閾値を読み出して有効範囲に clamp する。
 * - 未保存 / NaN / 不正値の場合は DEFAULT_REORDER_THRESHOLD を返す。
 * - 範囲外の場合は [MIN, MAX] に clamp する。
 */
export function readReorderThreshold(): number {
  try {
    const stored = localStorage.getItem(REORDER_THRESHOLD_STORAGE_KEY);
    if (!stored) return DEFAULT_REORDER_THRESHOLD;
    const parsed = parseInt(stored, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REORDER_THRESHOLD;
    return Math.min(REORDER_THRESHOLD_MAX, Math.max(REORDER_THRESHOLD_MIN, parsed));
  } catch {
    // localStorage アクセスが拒否される環境へのフォールバック
    return DEFAULT_REORDER_THRESHOLD;
  }
}

/** 閾値を有効範囲に clamp して localStorage に保存する。clamped 値を返す。 */
export function writeReorderThreshold(value: number): number {
  const clamped = Math.min(
    REORDER_THRESHOLD_MAX,
    Math.max(REORDER_THRESHOLD_MIN, value),
  );
  try {
    localStorage.setItem(REORDER_THRESHOLD_STORAGE_KEY, clamped.toString());
  } catch {
    // 書き込み失敗は呼び出し側で clamp 値を使い続ける
  }
  return clamped;
}
