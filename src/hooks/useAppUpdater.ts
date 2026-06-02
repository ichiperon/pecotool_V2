import { useCallback, useRef, useState } from 'react';

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

export function useAppUpdater(
  checkAdapter: () => Promise<UpdaterUpdate | null> = checkForUpdateAdapter
): {
  state: AppUpdateState;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
} {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  // Holds the full update object so downloadAndInstall() can call it later
  const updateRef = useRef<UpdaterUpdate | null>(null);
  // Keep a stable ref to the adapter so it can change between renders without
  // triggering callback re-creation (tests can pass a mock without issues)
  const adapterRef = useRef(checkAdapter);
  adapterRef.current = checkAdapter;

  const checkForUpdate = useCallback(async () => {
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
      } else {
        updateRef.current = null;
        setState(s => ({ ...s, isChecking: false, available: null }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState(s => ({ ...s, isChecking: false, error: message }));
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState(s => ({ ...s, isDownloading: false, error: message }));
    }
  }, []);

  return { state, checkForUpdate, downloadAndInstall };
}
