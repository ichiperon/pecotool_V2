import { useEffect, useCallback, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows } from '@tauri-apps/api/window';
import { usePecoStore } from '../store/pecoStore';
import { logUnlessTauriWindowNotFound } from '../utils/tauriWindowErrors';

export function useThumbnailWindow() {
  const [isThumbnailOpen, setIsThumbnailOpen] = useState(false);
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

  // --- ウィンドウ初期化（遅延生成）---
  const thumbWinRef = useRef<WebviewWindow | null>(null);
  const initPromiseRef = useRef<Promise<WebviewWindow> | null>(null);

  const initThumbnailWindow = useCallback(async () => {
    if (thumbWinRef.current) return thumbWinRef.current;
    if (initPromiseRef.current) return initPromiseRef.current;

    initPromiseRef.current = (async () => {
      const windows = await getAllWindows();
      let win = windows.find(w => w.label === 'thumbnail-window') as WebviewWindow | undefined;
      if (!win) {
        win = new WebviewWindow('thumbnail-window', {
          url: '/#thumbnails',
          title: 'サムネイル一覧',
          width: 250,
          height: 800,
          visible: false,
          resizable: true,
          alwaysOnTop: true,
        });
      }
      thumbWinRef.current = win;
      return win;
    })();

    try {
      return await initPromiseRef.current;
    } finally {
      initPromiseRef.current = null;
    }
  }, []);

  const toggleThumbnailWindow = useCallback(async () => {
    try {
      const win = await initThumbnailWindow();
      if (win) {
        if (isThumbnailOpen) {
          await win.hide();
          setIsThumbnailOpen(false);
        } else {
          await win.show();
          await win.setFocus();
          setIsThumbnailOpen(true);
        }
      }
    } catch (e) {
      logUnlessTauriWindowNotFound(e);
    }
  }, [isThumbnailOpen, initThumbnailWindow]);

  // --- サムネイル窓からの状態要求に応答 ---
  useEffect(() => {
    const setup = async () => {
      const u1 = await listen('thumbnail:request-state', () => {
        const doc = usePecoStore.getState().document;
        const { currentPageIndex: page } = usePecoStore.getState();
        if (doc) {
          emit('thumbnail:file-opened', {
            filePath: doc.filePath,
            currentPageIndex: page,
            totalPages: doc.totalPages,
            dirtyPages: getDirtyPages(),
          }).catch(logUnlessTauriWindowNotFound);
        }
      });
      const u2 = await listen('thumbnail:hidden', () => {
        setIsThumbnailOpen(false);
      });
      return () => { u1(); u2(); };
    };
    let unlisten: (() => void) | undefined;
    const p = setup().then(fn => { unlisten = fn; }).catch(logUnlessTauriWindowNotFound);
    return () => { p.then(() => unlisten?.()); };
  }, [getDirtyPages]);

  // --- ページ選択をサムネイル窓から受け取る ---
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ pageIndex: number }>('thumbnail:page-selected', (e) => {
      usePecoStore.getState().setCurrentPage(e.payload.pageIndex);
    }).then(fn => { unlisten = fn; }).catch(logUnlessTauriWindowNotFound);
    return () => { unlisten?.(); };
  }, []);

  // --- ファイル開閉をサムネイル窓に通知（自動表示は行わず状態転送のみ）---
  useEffect(() => {
    if (document) {
      emit('thumbnail:file-opened', {
        filePath: document.filePath,
        currentPageIndex,
        totalPages: document.totalPages,
        dirtyPages: getDirtyPages(),
      }).catch(logUnlessTauriWindowNotFound);
    } else {
      emit('thumbnail:file-closed').catch(logUnlessTauriWindowNotFound);
    }
    prevDirtyRef.current = '';
  }, [document?.filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- ページ変更をサムネイル窓に通知 ---
  useEffect(() => {
    emit('thumbnail:page-changed', { pageIndex: currentPageIndex }).catch(logUnlessTauriWindowNotFound);
  }, [currentPageIndex]);

  // --- Dirty状態の変化をサムネイル窓に通知 ---
  useEffect(() => {
    if (!document) return;
    const dirty = getDirtyPages();
    const serialized = dirty.join(',');
    if (serialized === prevDirtyRef.current) return;
    prevDirtyRef.current = serialized;
    emit('thumbnail:dirty-update', { dirtyPages: dirty }).catch(logUnlessTauriWindowNotFound);
  }, [document, getDirtyPages]);

  return { initThumbnailWindow, isThumbnailOpen, toggleThumbnailWindow };
}
