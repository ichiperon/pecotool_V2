import { useEffect, useCallback, useRef } from 'react';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';
import { usePecoStore } from '../store/pecoStore';

const WINDOW_LABEL = 'thumbnail-window';

export function useThumbnailWindow() {
  const { document, currentPageIndex } = usePecoStore();
  // Dirty なページインデックス一覧を追跡
  const prevDirtyRef = useRef<string>('');

  const getDirtyPages = useCallback((): number[] => {
    const doc = usePecoStore.getState().document;
    if (!doc) return [];
    const result: number[] = [];
    doc.pages.forEach((page, idx) => { if (page.isDirty) result.push(idx); });
    return result;
  }, []);

  // --- サムネイルウィンドウを取得して位置を調整し表示する ---
  const showThumbnailWindow = useCallback(async () => {
    try {
      const windows = await getAllWindows();
      const win = windows.find(w => w.label === WINDOW_LABEL);
      if (!win) return;

      // メインウィンドウの左隣に配置
      const mainWin = getCurrentWindow();
      const pos = await mainWin.outerPosition();
      const size = await win.outerSize();
      const x = Math.max(0, pos.x - size.width - 4);
      const y = pos.y;
      await win.setPosition(new PhysicalPosition(x, y));
      await win.show();
    } catch (e) {
      console.error('[useThumbnailWindow] show error:', e);
    }
  }, []);

  // --- ウィンドウ初期化（アプリ起動時）---
  const initThumbnailWindow = useCallback(async () => {
    // tauri.conf.json で pre-configure 済みのため作成は不要。何もしない。
  }, []);

  // --- サムネイル窓からの状態要求に応答 ---
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('thumbnail:request-state', () => {
      const doc = usePecoStore.getState().document;
      const { currentPageIndex: page } = usePecoStore.getState();
      if (doc) {
        emit('thumbnail:file-opened', {
          filePath: doc.filePath,
          currentPageIndex: page,
          totalPages: doc.totalPages,
          dirtyPages: getDirtyPages(),
        }).catch(console.error);
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [getDirtyPages]);

  // --- ページ選択をサムネイル窓から受け取る ---
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ pageIndex: number }>('thumbnail:page-selected', (e) => {
      usePecoStore.getState().setCurrentPage(e.payload.pageIndex);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // --- ファイル開閉をサムネイル窓に通知（ファイルオープン時は自動表示）---
  useEffect(() => {
    if (document) {
      showThumbnailWindow(); // ファイルを開いたら自動表示・位置調整
      emit('thumbnail:file-opened', {
        filePath: document.filePath,
        currentPageIndex,
        totalPages: document.totalPages,
        dirtyPages: getDirtyPages(),
      }).catch(console.error);
    } else {
      emit('thumbnail:file-closed').catch(console.error);
    }
    prevDirtyRef.current = '';
  }, [document?.filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- ページ変更をサムネイル窓に通知 ---
  useEffect(() => {
    emit('thumbnail:page-changed', { pageIndex: currentPageIndex }).catch(console.error);
  }, [currentPageIndex]);

  // --- Dirty状態の変化をサムネイル窓に通知 ---
  useEffect(() => {
    if (!document) return;
    const dirty = getDirtyPages();
    const serialized = dirty.join(',');
    if (serialized === prevDirtyRef.current) return;
    prevDirtyRef.current = serialized;
    emit('thumbnail:dirty-update', { dirtyPages: dirty }).catch(console.error);
  });

  return { initThumbnailWindow };
}
