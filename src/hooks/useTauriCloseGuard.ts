import { useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { usePecoStore } from '../store/pecoStore';

// Tauriウィンドウのクローズ要求時に未保存変更を確認するガード
export function useTauriCloseGuard() {
  useEffect(() => {
    if (window.location.hash === '#preview') return;
    const currentWindow = getCurrentWindow();
    const setupCloseListener = async () => {
      await currentWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        const state = usePecoStore.getState();
        const hasDirtyPages = Array.from(state.document?.pages.values() || []).some((p) => p.isDirty);
        if (state.isDirty || hasDirtyPages) {
          const confirmed = await ask('未保存の変更があります。終了してもよろしいですか？', {
            title: '終了の確認',
            kind: 'warning',
          });
          if (!confirmed) return;
        }
        const windows = await getAllWindows();
        for (const w of windows) {
          if (w.label !== currentWindow.label) {
            await w.destroy();
          }
        }
        await currentWindow.destroy();
      });
    };
    setupCloseListener();
  }, []);
}
