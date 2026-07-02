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
  // issue #431 (FB-6): 回転状態をシリアライズしたプリミティブのみ購読する。
  // dirtyPagesSerialized と同じ設計 (issue #35) — document 全体購読を避け、
  // rotation が変化したときだけ effect を再実行する。
  const rotationsSerialized = usePecoStore((s) => {
    const doc = s.document;
    if (!doc) return '';
    const parts: number[] = [];
    doc.pages.forEach((page, idx) => { parts[idx] = page.rotation ?? 0; });
    return parts.join(',');
  });
  // Dirty なページインデックス一覧を追跡
  const prevDirtyRef = useRef<string>('');
  const prevPageOrderRef = useRef<string>('');
  // 直近で通知した表示 (pageOrder) 順 rotations 文字列 (emit 内容の重複排除用)
  const prevRotationsRef = useRef<string>('');
  // rotationsSerialized (pages Map の displayIndex キー順) の直近値。effect の再実行判定用。
  const prevRotationsSourceRef = useRef<string>('');

  const getDirtyPages = useCallback((): number[] => {
    const doc = usePecoStore.getState().document;
    if (!doc) return [];
    const result: number[] = [];
    doc.pages.forEach((page, idx) => { if (page.isDirty) result.push(idx); });
    return result;
  }, []);

  // issue #431 (FB-6): 表示順 (display index) に沿って rotation 値を並べた配列を返す。
  // document.pages Map は displayIndex キー (movePage / deletePages / reorder undo が
  // すべて display index で再構築、内蔵の ThumbnailPanel も pages.get(displayIndex) 参照)。
  // pageOrder の中身 (source page index) で引くと、並べ替え・削除後に別ページの
  // rotation を返してしまう (pageOrder が identity のうちだけ偶然一致していた)。
  // 表示スロット数 (= pageOrder.length) 分、displayIndex 0..n-1 で引く。
  const getRotations = useCallback((pageOrder: number[]): number[] => {
    const doc = usePecoStore.getState().document;
    if (!doc) return [];
    return pageOrder.map((_, displayIdx) => doc.pages.get(displayIdx)?.rotation ?? 0);
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
            rotations: getRotations(pageOrder),
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
  }, [getDirtyPages, getRotations]);

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
      const rotations = getRotations(pageOrder);
      emit('thumbnail:file-opened', {
        filePath: document.filePath,
        documentEpoch,
        currentPageIndex,
        totalPages: document.totalPages,
        dirtyPages: getDirtyPages(),
        pageOrder,
        rotations,
      }).catch(logUnlessTauriWindowNotFound);
      prevPageOrderRef.current = pageOrder.join(',');
      prevRotationsRef.current = rotations.join(',');
      prevRotationsSourceRef.current = rotationsSerialized;
    } else {
      emit('thumbnail:file-closed').catch(logUnlessTauriWindowNotFound);
      prevPageOrderRef.current = '';
      prevRotationsRef.current = '';
      prevRotationsSourceRef.current = '';
    }
    prevDirtyRef.current = '';
  }, [document?.filePath, openDocumentEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- ページ順変更をサムネイル窓に通知 ---
  useEffect(() => {
    if (pageOrderSerialized === prevPageOrderRef.current) return;
    prevPageOrderRef.current = pageOrderSerialized;
    const { document: doc, currentPageIndex: page, pageOrder } = usePecoStore.getState();
    if (!doc) return;
    const rotations = getRotations(pageOrder);
    prevRotationsRef.current = rotations.join(',');
    prevRotationsSourceRef.current = rotationsSerialized;
    emit('thumbnail:page-order-changed', {
      currentPageIndex: page,
      totalPages: doc.totalPages,
      dirtyPages: getDirtyPages(),
      pageOrder,
      rotations,
    }).catch(logUnlessTauriWindowNotFound);
  }, [pageOrderSerialized, getDirtyPages, getRotations, rotationsSerialized]);

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

  // --- 回転状態の変化をサムネイル窓に通知 (issue #431 / FB-6) ---
  // dirty-update と同じ設計 (issue #35): 回転値をシリアライズしたプリミティブのみ
  // 購読することで、rotation に無関係な store 更新では effect が再実行されない。
  // rotationsSerialized (購読トリガー、source page index 順) が変化した時だけ
  // 実行し、実際に emit する payload は表示 (pageOrder) 順に変換する。
  // prevRotationsRef は常に「直近で通知した表示順 rotations の文字列」を保持する
  // (thumbnail:file-opened / thumbnail:page-order-changed の emit 時にも更新される)。
  useEffect(() => {
    if (rotationsSerialized === prevRotationsSourceRef.current) return;
    prevRotationsSourceRef.current = rotationsSerialized;
    const pageOrder = usePecoStore.getState().pageOrder;
    const rotations = getRotations(pageOrder);
    const nextSerialized = rotations.join(',');
    // pageOrder 変更由来の effect (上の thumbnail:file-opened / page-order-changed) が
    // 同一レンダーで既に同じ内容を通知済みなら重複 emit しない。
    if (nextSerialized === prevRotationsRef.current) return;
    prevRotationsRef.current = nextSerialized;
    emit('thumbnail:rotation-update', { rotations }).catch(logUnlessTauriWindowNotFound);
  }, [rotationsSerialized, getRotations]);

  return { initThumbnailWindow, isThumbnailOpen, toggleThumbnailWindow };
}
