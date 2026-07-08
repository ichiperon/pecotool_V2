import { useCallback, useRef, useState } from 'react';

/**
 * 自動更新機能の有効フラグ。
 * 起動時チェックと「アップデート確認」ボタンの両方がこのフラグに従う。
 * v2.0.15 で署名鍵 (pubkey) を設定し、配布専用 public リポジトリ
 * (abroadcrew02-spec/pecotool-releases) を endpoint として有効化した。
 * リリース手順は docs/UPDATER.md を参照。
 */
export const UPDATER_ENABLED = true;

export interface AppUpdateState {
  isChecking: boolean;
  available: { version: string; notes?: string } | null;
  isDownloading: boolean;
  downloadProgress: { current: number; total: number } | null;
  error: string | null;
}

// Minimal shape of a Tauri updater update object.
// The real type comes from @tauri-apps/plugin-updater at runtime.
export interface UpdaterUpdate {
  available: boolean;
  version: string;
  body: string | null;
  downloadAndInstall(
    onProgress?: (progress: { chunkLength: number; contentLength: number | null }) => void
  ): Promise<void>;
}

// Adapter that wraps the Tauri plugin import.
// Exported so tests can vi.mock('../../hooks/useAppUpdater') and replace it,
// while production code defers the real plugin load to runtime (Tauri IPC).
export async function checkForUpdateAdapter(): Promise<UpdaterUpdate | null> {
  // Dynamic import so the module is only resolved inside the Tauri runtime.
  // In non-Tauri environments (tests, browser) the import throws — callers handle that.
  const { check } = await (import('@tauri-apps/plugin-updater') as Promise<typeof import('@tauri-apps/plugin-updater')>);
  // #263: The plugin's check() return type is not identical to UpdaterUpdate | null
  // at the TypeScript level, so we use a double-cast to narrow safely without
  // suppressing the actual runtime value.
  return check() as unknown as Promise<UpdaterUpdate | null>;
}

const INITIAL_STATE: AppUpdateState = {
  isChecking: false,
  available: null,
  isDownloading: false,
  downloadProgress: null,
  error: null,
};

/** PCT-093: checkForUpdate の結果種別。手動チェック時のフィードバック表示に使う。 */
export type UpdateCheckResult = 'available' | 'latest' | 'error';

/**
 * Wave4: downloadAndInstall の結果種別。呼び出し元 (App.tsx) が成否に応じた
 * トースト表示を出し分けるために使う。'busy' は多重起動ガードで弾かれたケース
 * (実際のダウンロード処理は開始されていない) を区別する。
 */
export type DownloadInstallResult = 'success' | 'error' | 'busy';

export function useAppUpdater(
  checkAdapter: () => Promise<UpdaterUpdate | null> = checkForUpdateAdapter
): {
  state: AppUpdateState;
  checkForUpdate: () => Promise<UpdateCheckResult>;
  downloadAndInstall: () => Promise<DownloadInstallResult>;
} {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  // Holds the full update object so downloadAndInstall() can call it later
  const updateRef = useRef<UpdaterUpdate | null>(null);
  // Keep a stable ref to the adapter so it can change between renders without
  // triggering callback re-creation (tests can pass a mock without issues)
  const adapterRef = useRef(checkAdapter);
  adapterRef.current = checkAdapter;
  // Wave4: 二重ダウンロード防止用の再入ガード。state.isDownloading は setState
  // 経由で非同期にしか反映されないため、同一 tick 内での多重呼び出しを確実に
  // 弾くには ref を使う (state だけだと React のバッチ更新前に素通りしうる)。
  const isDownloadingRef = useRef(false);

  const checkForUpdate = useCallback(async (): Promise<UpdateCheckResult> => {
    setState(s => ({ ...s, isChecking: true, error: null }));
    try {
      const update = await adapterRef.current();
      if (update && update.available) {
        updateRef.current = update;
        setState(s => ({
          ...s,
          isChecking: false,
          available: { version: update.version, notes: update.body ?? undefined },
        }));
        return 'available';
      } else {
        updateRef.current = null;
        setState(s => ({ ...s, isChecking: false, available: null }));
        return 'latest';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // PCT-093: silent 握りつぶしを廃止。エラーは console にも残す
      // (updater capability 欠如が無反応として隠蔽されていた実例があるため)。
      console.error('[updater] check failed:', message);
      setState(s => ({ ...s, isChecking: false, error: message }));
      return 'error';
    }
  }, []);

  const downloadAndInstall = useCallback(async (): Promise<DownloadInstallResult> => {
    const update = updateRef.current;
    if (!update) return 'error';
    // Wave4: 再入ガード。ダウンロード中に (トーストの多重クリック・複数経路からの
    // 呼び出し等で) 再度呼ばれても、実際のプラグイン呼び出しは1回に限定する。
    if (isDownloadingRef.current) return 'busy';
    isDownloadingRef.current = true;

    setState(s => ({ ...s, isDownloading: true, downloadProgress: null, error: null }));
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((progress) => {
        downloaded += progress.chunkLength;
        if (progress.contentLength != null) {
          total = progress.contentLength;
        }
        setState(s => ({
          ...s,
          downloadProgress: { current: downloaded, total },
        }));
      });
      // The app typically restarts after install. If we reach here, reset state.
      setState(s => ({ ...s, isDownloading: false, downloadProgress: null }));
      return 'success';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Wave4: 従来はここで state.error に入れるだけで、呼び出し元 (App.tsx) は
      // updateState.available しか見ていなかったため失敗が完全にサイレントだった。
      // 戻り値で成否を明示し、呼び出し元がトースト表示を出し分けられるようにする。
      setState(s => ({ ...s, isDownloading: false, error: message }));
      return 'error';
    } finally {
      isDownloadingRef.current = false;
    }
  }, []);

  return { state, checkForUpdate, downloadAndInstall };
}
