import { useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { usePecoStore } from '../store/pecoStore';
import { perf } from '../utils/perfLogger';

// 指定ミリ秒でタイムアウトする Promise.race ヘルパ。
// タイムアウト時は fallback 値で解決する (reject しない)。
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return Promise.race<T>([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        console.warn(`[useTauriCloseGuard] ${label} timed out after ${ms}ms; using fallback`);
        resolve(fallback);
      }, ms);
    }),
  ]);
}

// Tauriウィンドウのクローズ要求時に未保存変更を確認するガード
interface UseTauriCloseGuardOptions {
  /**
   * issue #74 / 保存中ガード用の ref。
   * 保存中 (チャンク書込〜replace_pdf_file の rename 進行中) に window.destroy を
   * 許すと書込が中途で打ち切られるリスクがあるため、close 要求自体を suppress する。
   * (PCT-077 で置換は単一 atomic rename になり target 消失窓は解消済みだが、
   *  書込フェーズ全体の保護としてガードは引き続き必要)
   * 省略可 (旧 API 互換)。
   */
  isSavingRef?: React.RefObject<boolean>;
  /**
   * PCT-055 (R04U-2): 自動バックアップ実行中フラグ。
   * バックアップ書き込み中に window.destroy を許すとバックアップファイルが
   * 破損する可能性があるため、isSavingRef と同様に close 要求を suppress する。
   * 省略可。
   */
  isBackingUpRef?: React.RefObject<boolean>;
}

export function useTauriCloseGuard(options: UseTauriCloseGuardOptions = {}) {
  const { isSavingRef, isBackingUpRef } = options;
  useEffect(() => {
    if (window.location.hash === '#preview') return;
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const setupCloseListener = async () => {
      const closeUnlisten = await currentWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        // 保存中は close 要求を握りつぶす (再操作してもらう)。
        // rename(target→backup) 後 rename(temp→target) の間に destroy が走ると
        // target が消失する可能性があるため。
        if (isSavingRef?.current) {
          console.warn('[useTauriCloseGuard] close suppressed: save in progress');
          return;
        }
        // PCT-055 (R04U-2): バックアップ書き込み中も close を suppress する
        if (isBackingUpRef?.current) {
          console.warn('[useTauriCloseGuard] close suppressed: backup in progress');
          return;
        }
        // 「ユーザーが明示的にキャンセル」した場合のみ true。
        // それ以外 (正常フロー / 例外 / タイムアウト) では finally で必ず main を destroy する。
        let cancelled = false;
        try {
          const state = usePecoStore.getState();
          const hasDirtyPages = Array.from(state.document?.pages.values() || []).some((p) => p.isDirty);
          if (state.isDirty || hasDirtyPages) {
            // ask() が返らないと閉じ不能になるため 8 秒でタイムアウト。
            // タイムアウト時は安全側に倒して「キャンセル」扱い (false) で進める。
            // タイムアウトで閉じてしまうと未保存変更がそのまま消えるため、ユーザーに再操作させる。
            const confirmed = await withTimeout(
              ask('未保存の変更があります。終了してもよろしいですか？', {
                title: '終了の確認',
                kind: 'warning',
              }),
              8000,
              false,
              'ask()'
            );
            if (!confirmed) {
              cancelled = true;
              return;
            }
          }
          // 子ウィンドウを個別にタイムアウト付きで destroy。hang しても次へ進む。
          const windows = await withTimeout(getAllWindows(), 2000, [], 'getAllWindows()');
          for (const w of windows) {
            if (w.label !== currentWindow.label) {
              await withTimeout(
                Promise.resolve(w.destroy()),
                2000,
                undefined,
                `child window destroy (${w.label})`
              );
            }
          }

          // 操作ログを appLocalData/logs/ に書き出す (有効時のみ no-op でなくなる)。
          // 終了フローを詰まらせないよう 3 秒でタイムアウト、失敗時は警告だけで継続。
          if (perf.enabled) {
            perf.mark('app.closeRequested');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            try {
              await withTimeout(
                perf.sendOperationLog(`session-${ts}`),
                3000,
                '',
                'perf.sendOperationLog()'
              );
            } catch (e) {
              console.warn('[useTauriCloseGuard] operation log flush failed (ignored):', e);
            }
          }
        } catch (err) {
          console.error('[useTauriCloseGuard] close flow error:', err);
        } finally {
          if (!cancelled) {
            try {
              await withTimeout(
                Promise.resolve(currentWindow.destroy()),
                1000,
                undefined,
                'main window destroy'
              );
            } catch (err) {
              // Tauri に process.exit 相当の手段は無いため、ここで失敗してもログのみ。
              console.error('[useTauriCloseGuard] main destroy failed:', err);
            }
          }
        }
      });
      if (disposed) {
        closeUnlisten();
      } else {
        unlisten = closeUnlisten;
      }
    };
    setupCloseListener();
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    };
  }, []);
}
