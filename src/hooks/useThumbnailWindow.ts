import { useEffect, useCallback, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows } from '@tauri-apps/api/window';
import { usePecoStore, selectDocument, selectCurrentPageIndex } from '../store/pecoStore';
import { useInfraStore, selectDocumentEpoch } from '../store/infraStore';
import { logUnlessTauriWindowNotFound } from '../utils/tauriWindowErrors';

export function useThumbnailWindow() {
  const [isThumbnailOpen, setIsThumbnailOpen] = useState(false);
  const document = usePecoStore(selectDocument);
  const documentEpoch = useInfraStore(selectDocumentEpoch);
  const openDocumentEpoch = document ? documentEpoch : 0;
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);
  const pageOrderSerialized = usePecoStore((s) => s.pageOrder.join(','));
  // dirty ページ一覧をシリアライズしたプリミティブのみ購読する。
  // document 全体を購読すると textBlocks 等 dirty に無関係なフィールド更新でも
  // effect が再実行されて Tauri IPC が走るため (issue #35)。
  const dirtyPagesSerialized = usePecoStore((s) => {
    const doc = s.document;
    if (!doc) return '';
    const parts: number[] = [];
    doc.pages.forEach((page, idx) => { if (page.isDirty) parts.push(idx); });
    return parts.join(',');
  });
  // Dirty なページインデックス一覧を追跡
  const prevDirtyRef = useRef<string>('');
  const prevPageOrderRef = useRef<string>('');

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
        const { currentPageIndex: page, pageOrder } = usePecoStore.getState();
        if (doc) {
          emit('thumbnail:file-opened', {
            filePath: doc.filePath,
            documentEpoch: useInfraStore.getState().documentEpoch,
            currentPageIndex: page,
            totalPages: doc.totalPages,
            dirtyPages: getDirtyPages(),
            pageOrder,
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
      const pageOrder = usePecoStore.getState().pageOrder;
      emit('thumbnail:file-opened', {
        filePath: document.filePath,
        documentEpoch,
        currentPageIndex,
        totalPages: document.totalPages,
        dirtyPages: getDirtyPages(),
        pageOrder,
      }).catch(logUnlessTauriWindowNotFound);
      prevPageOrderRef.current = pageOrder.join(',');
    } else {
      emit('thumbnail:file-closed').catch(logUnlessTauriWindowNotFound);
      prevPageOrderRef.current = '';
    }
    prevDirtyRef.current = '';
  }, [document?.filePath, openDocumentEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- ページ順変更をサムネイル窓に通知 ---
  useEffect(() => {
    if (pageOrderSerialized === prevPageOrderRef.current) return;
    prevPageOrderRef.current = pageOrderSerialized;
    const { document: doc, currentPageIndex: page, pageOrder } = usePecoStore.getState();
    if (!doc) return;
    emit('thumbnail:page-order-changed', {
      currentPageIndex: page,
      totalPages: doc.totalPages,
      dirtyPages: getDirtyPages(),
      pageOrder,
    }).catch(logUnlessTauriWindowNotFound);
  }, [pageOrderSerialized, getDirtyPages]);

  // --- ページ変更をサムネイル窓に通知 ---
  useEffect(() => {
    emit('thumbnail:page-changed', { pageIndex: currentPageIndex }).catch(logUnlessTauriWindowNotFound);
  }, [currentPageIndex]);

  // --- Dirty状態の変化をサムネイル窓に通知 ---
  // dirty ページ一覧のシリアライズ済みプリミティブのみ購読することで、
  // textBlocks 等 dirty に無関係な store 更新では effect が再実行されない (issue #35)。
  useEffect(() => {
    if (dirtyPagesSerialized === prevDirtyRef.current) return;
    prevDirtyRef.current = dirtyPagesSerialized;
    const dirty = dirtyPagesSerialized === '' ? [] : dirtyPagesSerialized.split(',').map(Number);
    emit('thumbnail:dirty-update', { dirtyPages: dirty }).catch(logUnlessTauriWindowNotFound);
  }, [dirtyPagesSerialized]);

  return { initThumbnailWindow, isThumbnailOpen, toggleThumbnailWindow };
}
