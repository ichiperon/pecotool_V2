/**
 * Thin localStorage adapter for JSON serialization / deserialization.
 *
 * All three persistence sites (proofreadingRules, useBatchJob, ocrSettingsStore)
 * previously called localStorage directly with ad-hoc JSON.parse / JSON.stringify.
 * This module unifies that pattern so error handling and key naming are consistent
 * across the codebase. (#255)
 *
 * Usage:
 *   import { getJson, setJson, removeJson } from './jsonStorage';
 *
 *   const value = getJson<MyType>('my.key');   // null if missing or parse error
 *   setJson('my.key', value);                  // noop if quota exceeded (logs warn)
 *   removeJson('my.key');
 */

/**
 * Read and JSON-parse a value from localStorage.
 *
 * Returns `null` when the key is absent or the stored value cannot be parsed.
 * Never throws.
 */
export function getJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * JSON-serialize `value` and write it to localStorage.
 *
 * Failures (e.g. QuotaExceededError) are caught and logged as warnings.
 * Never throws.
 */
export function setJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`[jsonStorage] setJson failed for key "${key}":`, e);
  }
}

/**
 * Remove a key from localStorage.
 *
 * Never throws.
 */
export function removeJson(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn(`[jsonStorage] removeJson failed for key "${key}":`, e);
  }
}
