/**
 * Tauri ランタイム上で実行されているかどうかを判定する。
 *
 * @tauri-apps/api/core の isTauri() は window.isTauri フラグを参照するが、
 * このリポジトリの E2E モック (src/__tests__/e2e/helpers/tauriMock.ts) は
 * window.__TAURI_INTERNALS__ のみを設定し window.isTauri は設定しない。
 * そのため isTauri() をそのまま使うと E2E 上でランタイム判定が常に false になり、
 * Tauri 専用フック (close ガード等) が無効化されてしまう。
 *
 * ここでは Tauri が起動時に必ず注入する window.__TAURI_INTERNALS__ の有無を
 * 直接見て判定する。ブラウザ単体起動 (npm run dev をブラウザで開く場合) では
 * この値が存在しないため false を返す。
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
