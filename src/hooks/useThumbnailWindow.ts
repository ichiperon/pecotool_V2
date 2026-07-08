import { useEffect, useCallback, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows } from '@tauri-apps/api/window';
import { usePecoStore, selectDocument, selectCurrentPageIndex } from '../store/pecoStore';
import { useInfraStore, selectDocumentEpoch } from '../store/infraStore';
import { logUnlessTauriWindowNotFound } from '../utils/tauriWindowErrors';
import type { PecoDocument } from '../types';

interface FileOpenedPayload {
  filePath: string;
  documentEpoch: number;
  currentPageIndex: number;
  totalPages: number;
  dirtyPages: number[];
  pageOrder: number[];
  rotations: number[];
}

export function useThumbnailWindow() {
  const [isThumbnailOpen, setIsThumbnailOpen] = useState(false);
  const document = usePecoStore(selectDocument);
  const documentEpoch = useInfraStore(selectDocumentEpoch);
  const openDocumentEpoch = document ? documentEpoch : 0;
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);
  const pageOrderSerialized = usePecoStore((s) => s.pageOrder.join(','));
  // R22狩りWave4 (C-10): document.pages の Map 参照が変わらない限り再シリアライズ
  // しないメモ化キャッシュ。store 更新のたびに全ページ走査+join していた
  // O(N) コストを、実際に pages が変わった時だけに限定する。この codebase では
  // ページ更新は常に `new Map(oldPages)` の不変更新パターンを取るため
  // (pecoStore.ts 全体で一貫)、Map 参照の同一性は「中身が変わっていない」こと
  // の十分な判定条件になる。
  const dirtyCacheRef = useRef<{ pages: PecoDocument['pages'] | null; serialized: string }>({
    pages: null,
    serialized: '',
  });
  // dirty ページ一覧をシリアライズしたプリミティブのみを購読する。
  // document 全体を購読すると textBlocks 等 dirty に無関係なフィールド更新でも
  // effect が再実行されて Tauri IPC が走るため (issue #35)。
  const dirtyPagesSerialized = usePecoStore((s) => {
    const doc = s.document;
    const pagesMap = doc?.pages ?? null;
    const cache = dirtyCacheRef.current;
    if (cache.pages === pagesMap) return cache.serialized;
    if (!pagesMap) {
      cache.pages = null;
      cache.serialized = '';
      return '';
    }
    const parts: number[] = [];
    pagesMap.forEach((page, idx) => { if (page.isDirty) parts.push(idx); });
    const serialized = parts.join(',');
    cache.pages = pagesMap;
    cache.serialized = serialized;
    return serialized;
  });
  // issue #431 (FB-6): 回転状態をシリアライズしたプリミティブのみ購読する。
  // dirtyPagesSerialized と同じ設計 (issue #35) — document 全体購読を避け、
  // rotation が変化したときだけ effect を再実行する。
  // R22狩りWave4 (C-10): dirtyCacheRef と同様、pages Map 参照が同一なら
  // 再シリアライズをスキップする。
  const rotationsCacheRef = useRef<{ pages: PecoDocument['pages'] | null; serialized: string }>({
    pages: null,
    serialized: '',
  });
  const rotationsSerialized = usePecoStore((s) => {
    const doc = s.document;
    const pagesMap = doc?.pages ?? null;
    const cache = rotationsCacheRef.current;
    if (cache.pages === pagesMap) return cache.serialized;
    if (!pagesMap) {
      cache.pages = null;
      cache.serialized = '';
      return '';
    }
    const parts: number[] = [];
    pagesMap.forEach((page, idx) => { parts[idx] = page.rotation ?? 0; });
    const serialized = parts.join(',');
    cache.pages = pagesMap;
    cache.serialized = serialized;
    return serialized;
  });
  // Dirty なページインデックス一覧を追跡
  const prevDirtyRef = useRef<string>('');
  const prevPageOrderRef = useRef<string>('');
  // 直近で通知した表示 (pageOrder) 順 rotations 文字列 (emit 内容の重複排除用)
  const prevRotationsRef = useRef<string>('');
  // rotationsSerialized (pages Map の displayIndex キー順) の直近値。effect の再実行判定用。
  const prevRotationsSourceRef = useRef<string>('');
  // R22狩りWave4 (C-9): 直近で実際に emit した thumbnail:file-opened の
  // (filePath, documentEpoch) 複合キー。窓マウント時の request-state 応答と
  // doc-open 由来の effect emit が近接して両方走ると、同じ内容の
  // thumbnail:file-opened が2連発し、別窓側で LOAD_PDF が二重に走ってしまう。
  // 空文字を sentinel にすると dirty ゼロの正規シリアライズ ('') と衝突する
  // ため (C-7 で指摘済みの罠)、filePath+epoch の複合キー (NUL区切り) を使う。
  // emit 直後にマイクロタスクでキーを解除することで、真に近接した二重発火
  // だけを吸収し、後から改めて来る正当な request-state 応答まではブロック
  // しない。
  const lastFileOpenedKeyRef = useRef<string | null>(null);
  // R22狩りWave4 (C-4軽減): 別窓が非表示中に doc-open 由来の file-opened を
  // 保留したかどうかのフラグ。窓が再表示された時 (show 時 or request-state
  // 受信時) に最新状態を1回だけ flush する。
  const pendingFileOpenedRef = useRef(false);

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

  // 別窓が現在可視かどうかを判定する。窓がまだ生成されていない場合や
  // isVisible() の呼び出しに失敗した場合は安全側 (emit する = 可視扱い) に
  // フォールバックする。窓未生成のケースは同期的に true を返し、既存の
  // (窓を一度も生成しない) 呼び出し元では非同期ギャップを生じさせない。
  const checkThumbnailWindowVisible = useCallback((): true | Promise<boolean> => {
    const win = thumbWinRef.current;
    if (!win) return true;
    return win.isVisible().catch(() => true);
  }, []);

  // 同一 (filePath, documentEpoch) に対する thumbnail:file-opened の近接
  // 二重発火を1回に畳んで emit する。
  const emitFileOpenedDeduped = useCallback((payload: FileOpenedPayload) => {
    const key = `${payload.filePath}\u0000${payload.documentEpoch}`;
    if (lastFileOpenedKeyRef.current === key) return;
    lastFileOpenedKeyRef.current = key;
    Promise.resolve().then(() => {
      if (lastFileOpenedKeyRef.current === key) {
        lastFileOpenedKeyRef.current = null;
      }
    });
    emit('thumbnail:file-opened', payload).catch(logUnlessTauriWindowNotFound);
  }, []);

  // 別窓が非表示中なら emit を保留し、再表示時に flush する。
  const emitFileOpenedOrDefer = useCallback((payload: FileOpenedPayload) => {
    const visibleResult = checkThumbnailWindowVisible();
    if (visibleResult === true) {
      pendingFileOpenedRef.current = false;
      emitFileOpenedDeduped(payload);
      return;
    }
    visibleResult.then((visible) => {
      if (!visible) {
        pendingFileOpenedRef.current = true;
        return;
      }
      pendingFileOpenedRef.current = false;
      emitFileOpenedDeduped(payload);
    });
  }, [checkThumbnailWindowVisible, emitFileOpenedDeduped]);

  // store の最新状態から thumbnail:file-opened payload を組み立てる。
  // request-state 応答・非表示解除時の flush など、現在の store state を
  // その場で読み直す必要がある呼び出し元向け。
  const buildFileOpenedPayload = useCallback((): FileOpenedPayload | null => {
    const doc = usePecoStore.getState().document;
    if (!doc) return null;
    const { currentPageIndex: page, pageOrder } = usePecoStore.getState();
    return {
      filePath: doc.filePath,
      documentEpoch: useInfraStore.getState().documentEpoch,
      currentPageIndex: page,
      totalPages: doc.totalPages,
      dirtyPages: getDirtyPages(),
      pageOrder,
      rotations: getRotations(pageOrder),
    };
  }, [getDirtyPages, getRotations]);

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
          // 非表示中に保留していた file-opened があれば、再表示時に最新状態を
          // 1回だけ flush する。
          if (pendingFileOpenedRef.current) {
            pendingFileOpenedRef.current = false;
            const payload = buildFileOpenedPayload();
            if (payload) emitFileOpenedDeduped(payload);
          }
        }
      }
    } catch (e) {
      logUnlessTauriWindowNotFound(e);
    }
  }, [isThumbnailOpen, initThumbnailWindow, buildFileOpenedPayload, emitFileOpenedDeduped]);

  // --- サムネイル窓からの状態要求に応答 ---
  useEffect(() => {
    const setup = async () => {
      const u1 = await listen('thumbnail:request-state', () => {
        const payload = buildFileOpenedPayload();
        if (payload) {
          emitFileOpenedDeduped(payload);
        }
        // 窓から明示的に状態要求が来た = 窓は最新状態を受け取れる状態にある。
        // 保留中フラグがあればここで解消する。
        pendingFileOpenedRef.current = false;
      });
      const u2 = await listen('thumbnail:hidden', () => {
        setIsThumbnailOpen(false);
      });
      return () => { u1(); u2(); };
    };
    let unlisten: (() => void) | undefined;
    const p = setup().then(fn => { unlisten = fn; }).catch(logUnlessTauriWindowNotFound);
    return () => { p.then(() => unlisten?.()); };
  }, [buildFileOpenedPayload, emitFileOpenedDeduped]);

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
      const payload: FileOpenedPayload = {
        filePath: document.filePath,
        documentEpoch,
        currentPageIndex,
        totalPages: document.totalPages,
        dirtyPages: getDirtyPages(),
        pageOrder,
        rotations,
      };
      prevPageOrderRef.current = pageOrder.join(',');
      prevRotationsRef.current = rotations.join(',');
      prevRotationsSourceRef.current = rotationsSerialized;
      // 非表示の別窓には即時 emit せず、再表示時まで保留する (R22狩りWave4 C-4軽減)。
      emitFileOpenedOrDefer(payload);
    } else {
      emit('thumbnail:file-closed').catch(logUnlessTauriWindowNotFound);
      prevPageOrderRef.current = '';
      prevRotationsRef.current = '';
      prevRotationsSourceRef.current = '';
      pendingFileOpenedRef.current = false;
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
