import { useState, useRef, useCallback, useEffect } from 'react';
import { usePecoStore, selectDocument, selectCurrentPageIndex, selectPageOrder } from '../store/pecoStore';
import { useInfraStore, selectDocumentEpoch } from '../store/infraStore';
import { convertFileSrc } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';
import { perf } from '../utils/perfLogger';
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from '../utils/thumbnailWorkerTypes';

// サムネイル生成を thumbnail.worker.ts (OffscreenCanvas) に委譲することで
// メインスレッドのブロックを回避する。
// ThumbnailWindow.tsx と同じ Worker プール方式を採用。

const NUM_WORKERS = 1;
const CONCURRENCY = 4;
const BATCH_FLUSH_MS = 50;

function toAssetUrl(filePath: string): string {
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) url = 'http://' + url;
  return url;
}

// issue #11: thumbnails Map のキーを epoch:pageIndex 複合キーに。
// ファイル切替直後の Race で「前ファイルの pageIndex 0 を新ファイルの 0 として hit させる」事故を防ぐ。
function makeKey(epoch: number, pageIndex: number): string {
  return `${epoch}:${pageIndex}`;
}

type PendingThumbnail = {
  pageIndex: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (url: string | null) => void;
};

export function useThumbnailPanel() {
  const document = usePecoStore(selectDocument);
  const documentEpoch = useInfraStore(selectDocumentEpoch);
  const openDocumentEpoch = document ? documentEpoch : 0;
  const currentPageIndex = usePecoStore(selectCurrentPageIndex);
  const pageOrder = usePecoStore(selectPageOrder);

  // サムネイルデータはRefで保持（Reactの外）— 更新時に全アイテム再レンダリングを防ぐ
  // キーは makeKey(epoch, pageIndex) (issue #11)。
  const thumbnailsRef = useRef<Map<string, string>>(new Map());
  // アイテムごとの購読コールバック: index → Set<forceUpdate>
  const itemListenersRef = useRef<Map<number, Set<() => void>>>(new Map());
  // issue #68: アクティブページ変更通知も index 単位で購読する。
  // 全アイテムに prop drill すると、Virtuoso 可視範囲全件が再レンダされる。
  // active 状態が変わるのは "前のアクティブ" と "新しいアクティブ" の 2 件だけなので
  // その 2 件だけにピンポイント通知する。
  const activeListenersRef = useRef<Map<number, Set<() => void>>>(new Map());
  // 現在の active page index を ref で保持（リスナーが pull する形）。
  const activePageRef = useRef<number>(0);
  // issue #173: dirty 状態も index 単位で購読する。
  // 旧実装は itemContent useCallback の依存に `document` を入れていたため、
  // updatePageData で document 参照が新規になる度に itemContent identity が変わり、
  // Virtuoso 可視範囲の全 ThumbnailItemNode が unmount→remount され
  // サムネ画像が一瞬消える問題が起きていた。active と同形の pub/sub に分離する。
  const dirtyListenersRef = useRef<Map<number, Set<() => void>>>(new Map());
  const dirtyPagesRef = useRef<Set<number>>(new Set());

  const [loadEpoch, setLoadEpoch] = useState(0);

  // Worker プール
  const workersRef = useRef<Worker[]>([]);
  // Worker ごとの未完了コールバック map: requestId -> pending
  const pendingsByWorkerRef = useRef<Array<Map<number, PendingThumbnail>>>([]);
  const pendingRequestIdByPageRef = useRef<Map<number, number>>(new Map());
  // Worker ごとの LOAD_COMPLETE 解決用 resolve
  const loadResolvesRef = useRef<Array<((ok: boolean) => void) | null>>(
    new Array(NUM_WORKERS).fill(null)
  );
  const loadRequestIdsRef = useRef<Array<number | null>>(
    new Array(NUM_WORKERS).fill(null)
  );
  const nextWorkerRequestIdRef = useRef(0);

  const epochRef = useRef(0);
  const thumbnailEpochRef = useRef(0);
  // キュー処理専用の epoch。epochRef はファイル切替の識別 (LOAD_PDF フローの
  // ガード) を兼ねているため、pageOrder 変更のたびにここを bump すると
  // ロード中の startWorkerLoad/kickoff (epochRef 依存) まで巻き込んで
  // 中断してしまう。ThumbnailWindow.tsx は epochRef (キュー用) と
  // pdfLoadEpochRef (ロード用) を最初から分離しているため、対称化のため
  // ここでも processThumbnailQueue/requestThumbnail が読む epoch だけを
  // 分離する。pageOrder 変更 effect はこの queueEpochRef のみを bump する。
  const queueEpochRef = useRef(0);
  const pageOrderRef = useRef<number[]>(usePecoStore.getState().pageOrder);
  const pageOrderKeyRef = useRef(usePecoStore.getState().pageOrder.join(','));
  const isPdfReadyRef = useRef(false);
  const queueRef = useRef<number[]>([]);
  const queueSetRef = useRef<Set<number>>(new Set());
  const isProcessingRef = useRef(false);
  // (deferred load mode廃止により未使用、削除)

  // バッチ更新用: [pageIdx, url, epoch]
  const pendingBatchRef = useRef<Array<[number, string, number]>>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // サムネイルが届いたとき: refを更新し、そのアイテムのリスナーだけ呼ぶ（O(1)）
  const flushBatch = useCallback(() => {
    batchTimerRef.current = null;
    const entries = pendingBatchRef.current.splice(0);
    if (entries.length === 0) return;
    for (const [idx, url, batchEpoch] of entries) {
      // epoch 不一致 → 前ファイルの遅延応答。混入させず revoke。
      if (batchEpoch !== thumbnailEpochRef.current) {
        URL.revokeObjectURL(url);
        continue;
      }
      const key = makeKey(batchEpoch, idx);
      if (thumbnailsRef.current.has(key)) {
        URL.revokeObjectURL(url);
      } else {
        thumbnailsRef.current.set(key, url);
        itemListenersRef.current.get(idx)?.forEach(cb => cb());
      }
    }
  }, []);

  // アイテムが自分のサムネイル更新を購読する
  const subscribeThumbnail = useCallback((index: number, cb: () => void) => {
    if (!itemListenersRef.current.has(index)) {
      itemListenersRef.current.set(index, new Set());
    }
    itemListenersRef.current.get(index)!.add(cb);
    return () => {
      itemListenersRef.current.get(index)?.delete(cb);
    };
  }, []);

  // アイテムが自分のサムネイルデータを取得する
  const getThumbnail = useCallback((index: number) => {
    return thumbnailsRef.current.get(makeKey(thumbnailEpochRef.current, index));
  }, []);

  // issue #68: アイテムが自分の active 状態を購読する。
  // subscribeThumbnail と同形のため、ThumbnailItemNode 側で同じパターンで使える。
  const subscribeActivePage = useCallback((index: number, cb: () => void) => {
    if (!activeListenersRef.current.has(index)) {
      activeListenersRef.current.set(index, new Set());
    }
    activeListenersRef.current.get(index)!.add(cb);
    return () => {
      activeListenersRef.current.get(index)?.delete(cb);
    };
  }, []);

  // アイテムが自分の active 状態を取得する
  const getIsActivePage = useCallback((index: number) => {
    return activePageRef.current === index;
  }, []);

  // issue #173: dirty 状態の pub/sub。subscribe/get の関数 identity は不変なので
  // itemContent useCallback の依存も安定し、document 更新で再生成されない。
  const subscribeDirtyPage = useCallback((index: number, cb: () => void) => {
    if (!dirtyListenersRef.current.has(index)) {
      dirtyListenersRef.current.set(index, new Set());
    }
    dirtyListenersRef.current.get(index)!.add(cb);
    return () => {
      dirtyListenersRef.current.get(index)?.delete(cb);
    };
  }, []);

  const getIsDirtyPage = useCallback((index: number) => {
    return dirtyPagesRef.current.has(index);
  }, []);

  // pecoStore.subscribe で document を監視し、各ページの isDirty 差分を計算して
  // 変化した index のリスナーだけに通知する。Virtuoso 可視範囲外のアイテムは
  // 通知されてもまだ subscribe しておらず無害。
  useEffect(() => {
    const recompute = (doc: ReturnType<typeof selectDocument>) => {
      const next = new Set<number>();
      if (doc) {
        doc.pages.forEach((page, idx) => {
          if (page.isDirty) next.add(idx);
        });
      }
      const prev = dirtyPagesRef.current;
      const changed: number[] = [];
      next.forEach((idx) => { if (!prev.has(idx)) changed.push(idx); });
      prev.forEach((idx) => { if (!next.has(idx)) changed.push(idx); });
      dirtyPagesRef.current = next;
      changed.forEach((idx) => dirtyListenersRef.current.get(idx)?.forEach((cb) => cb()));
    };
    // 初期同期
    recompute(usePecoStore.getState().document);
    return usePecoStore.subscribe((state, prevState) => {
      if (state.document !== prevState.document) recompute(state.document);
    });
  }, []);

  // currentPageIndex 変更時、変化した 2 件 (旧アクティブ / 新アクティブ) だけに通知する。
  // これにより Virtuoso 可視範囲の全 ThumbnailItemNode が再レンダされる問題を回避する。
  useEffect(() => {
    const prev = activePageRef.current;
    if (prev === currentPageIndex) return;
    activePageRef.current = currentPageIndex;
    activeListenersRef.current.get(prev)?.forEach(cb => cb());
    activeListenersRef.current.get(currentPageIndex)?.forEach(cb => cb());
  }, [currentPageIndex]);

  // ページをワーカーに分散してサムネイル生成
  const generateViaWorker = useCallback((pageIdx: number): Promise<string | null> => {
    return new Promise(resolve => {
      const workers = workersRef.current;
      const pendingsByWorker = pendingsByWorkerRef.current;
      if (workers.length === 0) { resolve(null); return; }

      const workerIdx = pageIdx % workers.length;
      const worker = workers[workerIdx];
      const myPending = pendingsByWorker[workerIdx];

      if (pendingRequestIdByPageRef.current.has(pageIdx)) { resolve(null); return; }

      const requestId = ++nextWorkerRequestIdRef.current;
      const timeout = setTimeout(() => {
        const pending = myPending.get(requestId);
        if (pending) {
          myPending.delete(requestId);
          if (pendingRequestIdByPageRef.current.get(pageIdx) === requestId) {
            pendingRequestIdByPageRef.current.delete(pageIdx);
          }
          resolve(null);
        }
      }, 15000);

      myPending.set(requestId, {
        pageIndex: pageIdx,
        timeout,
        resolve,
      });
      pendingRequestIdByPageRef.current.set(pageIdx, requestId);
      const sourcePageIndex = pageOrderRef.current[pageIdx];
      const req: ThumbnailWorkerRequest = sourcePageIndex === undefined
        ? { type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx, requestId }
        : { type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx, sourcePageIndex, requestId };
      perf.mark('thumb.genStart', { page: pageIdx, workerIdx });
      worker.postMessage(req);
    });
  }, []);

  // キュー処理
  const processThumbnailQueue = useCallback(async (epoch: number) => {
    logger.log(`[ThumbnailPanel] processThumbnailQueue epoch=${epoch}, isPdfReady=${isPdfReadyRef.current}, isProcessing=${isProcessingRef.current}, queueLen=${queueRef.current.length}`);
    if (!isPdfReadyRef.current) return;
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        if (queueEpochRef.current !== epoch) break;

        const batch: number[] = [];
        while (batch.length < CONCURRENCY && queueRef.current.length > 0) {
          const pageIdx = queueRef.current.shift()!;
          queueSetRef.current.delete(pageIdx);
          batch.push(pageIdx);
        }
        if (batch.length === 0) continue;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            const thumbEpoch = thumbnailEpochRef.current;
            const url = await generateViaWorker(pageIdx);
            if (!url) return;
            if (queueEpochRef.current === epoch && thumbnailEpochRef.current === thumbEpoch) {
              pendingBatchRef.current.push([pageIdx, url, thumbEpoch]);
              if (!batchTimerRef.current) {
                batchTimerRef.current = setTimeout(flushBatch, BATCH_FLUSH_MS);
              }
            } else {
              URL.revokeObjectURL(url);
            }
          })
        );
      }
    } finally {
      isProcessingRef.current = false;
      if (queueRef.current.length > 0 && queueEpochRef.current === epoch) {
        setTimeout(() => processThumbnailQueue(epoch), 0);
      }
    }
  }, [generateViaWorker, flushBatch]);

  // Worker プール初期化（マウント時1回）
  useEffect(() => {
    const pendingsByWorker: Array<Map<number, PendingThumbnail>> = [];
    const workers: Worker[] = [];

    for (let wi = 0; wi < NUM_WORKERS; wi++) {
      const myPending = new Map<number, PendingThumbnail>();
      pendingsByWorker.push(myPending);

      const worker = new Worker(
        new URL('../utils/thumbnail.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const workerIndex = wi;
      worker.onmessage = (e: MessageEvent<ThumbnailWorkerResponse>) => {
        const msg = e.data;

        if (msg.type === 'LOAD_COMPLETE' || msg.type === 'LOAD_ERROR') {
          if (msg.requestId !== loadRequestIdsRef.current[workerIndex]) return;
          if (msg.type === 'LOAD_COMPLETE') {
            perf.mark('thumb.loadComplete', { workerIdx: workerIndex, numPages: msg.numPages, workerPerfNow: msg.workerPerfNow });
          }
          logger.log(`[ThumbnailPanel] Worker ${workerIndex} ${msg.type}`);
          if (msg.type === 'LOAD_ERROR') {
            console.error(`[useThumbnailPanel] Worker ${workerIndex} load error:`, msg.message);
          }
          const resolve = loadResolvesRef.current[workerIndex];
          if (resolve) {
            loadResolvesRef.current[workerIndex] = null;
            loadRequestIdsRef.current[workerIndex] = null;
            resolve(msg.type === 'LOAD_COMPLETE');
          } else {
            console.warn(`[ThumbnailPanel] Worker ${workerIndex} LOAD_COMPLETE but no resolve`);
          }
          return;
        }

        if (msg.type === 'THUMBNAIL_DONE') {
          if (msg.requestId === undefined) return;
          perf.mark('thumb.genDone', {
            page: msg.pageIndex,
            workerGenStart: msg.workerGenStart,
            workerGenDone: msg.workerGenDone,
            workerMs: msg.workerGenStart != null && msg.workerGenDone != null
              ? Math.round((msg.workerGenDone - msg.workerGenStart) * 1000) / 1000
              : undefined,
          });
          const pending = myPending.get(msg.requestId);
          if (!pending) return;
          myPending.delete(msg.requestId);
          clearTimeout(pending.timeout);
          if (pendingRequestIdByPageRef.current.get(pending.pageIndex) === msg.requestId) {
            pendingRequestIdByPageRef.current.delete(pending.pageIndex);
          }

          if (msg.bytes instanceof Uint8Array) {
            const blob = new Blob([msg.bytes], { type: 'image/jpeg' });
            pending.resolve(URL.createObjectURL(blob));
          } else {
            console.warn(`[ThumbnailPanel] Worker ${workerIndex} THUMBNAIL_DONE without Uint8Array`);
            pending.resolve(null);
          }
          return;
        }

        if (msg.type === 'THUMBNAIL_ERROR') {
          if (msg.requestId === undefined) return;
          const pending = myPending.get(msg.requestId);
          if (!pending) return;
          myPending.delete(msg.requestId);
          clearTimeout(pending.timeout);
          if (pendingRequestIdByPageRef.current.get(pending.pageIndex) === msg.requestId) {
            pendingRequestIdByPageRef.current.delete(pending.pageIndex);
          }
          console.error(`[ThumbnailPanel] Worker ${workerIndex} page ${msg.pageIndex + 1} render error:`, msg.error);
          pending.resolve(null);
          return;
        }

        // 網羅性チェック: 未知メッセージを static に検出
        const _exhaustive: never = msg;
        return _exhaustive;
      };

      worker.onerror = (ev) => {
        console.error(`[useThumbnailPanel] Worker ${workerIndex} onerror:`, ev);
        // 未完了のサムネイル要求を全て null で解決
        myPending.forEach((p, requestId) => {
          clearTimeout(p.timeout);
          if (pendingRequestIdByPageRef.current.get(p.pageIndex) === requestId) {
            pendingRequestIdByPageRef.current.delete(p.pageIndex);
          }
          p.resolve(null);
        });
        myPending.clear();
        // LOAD_PDF 応答待ちのプロミスも false で解決しないと isPdfReadyRef が
        // 永久に false のまま → 以降全てのサムネイル要求が処理されなくなる。
        const loadResolve = loadResolvesRef.current[workerIndex];
        if (loadResolve) {
          loadResolvesRef.current[workerIndex] = null;
          loadRequestIdsRef.current[workerIndex] = null;
          loadResolve(false);
        }
      };
      worker.onmessageerror = (ev) => {
        console.error(`[useThumbnailPanel] Worker ${workerIndex} onmessageerror:`, ev);
      };

      workers.push(worker);
    }

    workersRef.current = workers;
    pendingsByWorkerRef.current = pendingsByWorker;

    return () => {
      workers.forEach(w => w.terminate());
      workersRef.current = [];
      pendingsByWorker.forEach(p => {
        p.forEach(pending => {
          clearTimeout(pending.timeout);
          pending.resolve(null);
        });
        p.clear();
      });
      pendingsByWorkerRef.current = [];
      pendingRequestIdByPageRef.current.clear();
      loadResolvesRef.current.forEach((r, i) => {
        if (r) { loadResolvesRef.current[i] = null; loadRequestIdsRef.current[i] = null; r(false); }
      });
      // バッチタイマー・pending URL も確実に解放
      if (batchTimerRef.current) { clearTimeout(batchTimerRef.current); batchTimerRef.current = null; }
      pendingBatchRef.current.forEach(([, url]) => URL.revokeObjectURL(url));
      pendingBatchRef.current = [];
      // 保持中の ObjectURL を全て解放（リーク防止）
      thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
      thumbnailsRef.current = new Map();
    };
  }, []);

  // ファイル切り替え
  const prevDocumentIdentityRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const documentIdentity = document?.filePath ? `${document.filePath}:${openDocumentEpoch}` : undefined;
    if (documentIdentity === prevDocumentIdentityRef.current) return;
    prevDocumentIdentityRef.current = documentIdentity;
    const currentPageOrder = usePecoStore.getState().pageOrder;
    pageOrderRef.current = currentPageOrder;
    pageOrderKeyRef.current = currentPageOrder.join(',');

    epochRef.current++;
    thumbnailEpochRef.current++;
    queueEpochRef.current++;
    const epoch = epochRef.current;
    queueRef.current = [];
    queueSetRef.current.clear();
    isProcessingRef.current = false;
    isPdfReadyRef.current = false;

    // 前のロード resolve をキャンセル
    loadResolvesRef.current.forEach((r, i) => {
      if (r) { loadResolvesRef.current[i] = null; loadRequestIdsRef.current[i] = null; r(false); }
    });
    pendingsByWorkerRef.current.forEach(p => {
      p.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.resolve(null);
      });
      p.clear();
    });
    pendingRequestIdByPageRef.current.clear();

    // バッチタイマーをクリアし、pending URL も revoke
    pendingBatchRef.current.forEach(([, url]) => URL.revokeObjectURL(url));
    pendingBatchRef.current = [];
    if (batchTimerRef.current) { clearTimeout(batchTimerRef.current); batchTimerRef.current = null; }

    // サムネイルrefをクリアし、全登録アイテムに通知（プレースホルダー表示へ）
    thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
    thumbnailsRef.current = new Map();
    itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));

    // loadEpoch を増加させてアイテムの再リクエストを促す
    setLoadEpoch(prev => prev + 1);

    if (!document?.filePath) {
      // PCT-073: ファイルクローズ時は worker が保持する PDF リソース
      // （pdfDoc / 進行中の loadingTask）を明示解放する。旧実装は UI 状態の
      // クリアのみで worker へ何も送らず、次の LOAD_PDF まで閉じた PDF の
      // 解析構造が worker メモリに残留していた。
      // CLOSE_PDF 後に届く旧応答は、上で実施済みの epoch++ / pending クリア /
      // loadRequestIds クリアにより既存機構で無視される。
      const closeReq: ThumbnailWorkerRequest = { type: 'CLOSE_PDF' };
      workersRef.current.forEach(w => w.postMessage(closeReq));
      return;
    }
    if (workersRef.current.length === 0) return;

    const capturedFilePath = document.filePath;
    const capturedDocumentIdentity = documentIdentity;
    const capturedEpoch = epoch;
    const capturedQueueEpoch = queueEpochRef.current;

    const startWorkerLoad = async () => {
      if (epochRef.current !== capturedEpoch) return;
      const workers = workersRef.current;

      // bytes IPC 転送経路は Tauri v2 で低速のため廃止。
      // URL (asset protocol) を直接 Worker に渡し、Worker 側 pdfjs の Range fetch に任せる。
      const url = toAssetUrl(capturedFilePath);
      const perWorkerPromises = workers.map((_, i) =>
        new Promise<boolean>(resolve => {
          loadRequestIdsRef.current[i] = ++nextWorkerRequestIdRef.current;
          loadResolvesRef.current[i] = resolve;
        })
      );

      logger.log('[ThumbnailPanel] Posting LOAD_PDF (URL) to', workers.length, 'worker(s)');
      workers.forEach((worker, i) => {
        const requestId = loadRequestIdsRef.current[i]!;
        const req: ThumbnailWorkerRequest = { type: 'LOAD_PDF', url, requestId };
        worker.postMessage(req);
      });

      Promise.all(perWorkerPromises).then((results) => {
        logger.log(`[ThumbnailPanel] All workers ready, results=${JSON.stringify(results)}, epoch=${capturedEpoch}, current=${epochRef.current}, queue=${queueRef.current.length}`);
        if (epochRef.current !== capturedEpoch) return;
        isPdfReadyRef.current = true;
        processThumbnailQueue(capturedQueueEpoch);
      });
    };

    logger.log(`[ThumbnailPanel] Starting worker load for ${capturedFilePath}`);
    // メイン pdfjs の初回 render (~500ms) と、サムネ worker 側 pdfjs の
    // 初期化 (LOAD_COMPLETE 実測 ~8.7s) が同時実行されると CPU を奪い合い、
    // メイン側のページ遷移 render が 1,564ms まで悪化する。
    // requestIdleCallback でメイン render の山が落ち着く idle 時間まで
    // 遅延させて起動する。未対応環境 (jsdom / 旧 WebView) では 800ms の
    // setTimeout フォールバックで同等の遅延を与える。
    // PCT-054: timeout は重量 PDF の初回 render (実測 ~1.5s) より長く取る。
    // idle になれば timeout より前に即起動するため通常 PDF の挙動は不変。
    type IdleGlobal = typeof globalThis & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const g = globalThis as IdleGlobal;
    const kickoff = () => {
      if (epochRef.current !== capturedEpoch) return;
      if (prevDocumentIdentityRef.current !== capturedDocumentIdentity) return;
      startWorkerLoad();
    };

    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (typeof g.requestIdleCallback === 'function') {
      idleHandle = g.requestIdleCallback(kickoff, { timeout: 3000 });
    } else {
      timeoutHandle = setTimeout(kickoff, 800);
    }
    return () => {
      if (idleHandle !== null && typeof g.cancelIdleCallback === 'function') {
        g.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };
  }, [document?.filePath, openDocumentEpoch, processThumbnailQueue]);

  useEffect(() => {
    const pageOrderKey = pageOrder.join(',');
    if (pageOrderKey === pageOrderKeyRef.current) {
      pageOrderRef.current = pageOrder;
      return;
    }

    // Differential cache invalidation (PCT-perf-delete):
    // Instead of revoking all N thumbnails and re-generating N-1 from scratch,
    // we only revoke the removed pages' entries and remap surviving pages to their
    // new display indices. This reduces the cost from O(N) revoke + O(N-1) re-gen
    // to O(deleted) revoke + O(survived) key-remap.
    const oldPageOrder = pageOrderRef.current;
    const oldEpoch = thumbnailEpochRef.current;
    const newEpoch = oldEpoch + 1;

    // Build sourcePageIndex → { oldDisplayIndex, url } lookup from the old cache.
    // Keys in thumbnailsRef are "epoch:displayIndex".
    const sourceToEntry = new Map<number, { oldDisplayIdx: number; url: string }>();
    for (let oldIdx = 0; oldIdx < oldPageOrder.length; oldIdx++) {
      const srcPage = oldPageOrder[oldIdx];
      const key = makeKey(oldEpoch, oldIdx);
      const url = thumbnailsRef.current.get(key);
      if (url !== undefined) {
        sourceToEntry.set(srcPage, { oldDisplayIdx: oldIdx, url });
      }
    }

    // Build the new cache map: for each new display index, try to reuse the
    // cached URL that was generated for the same source page.
    const newMap = new Map<string, string>();
    const reusedSources = new Set<number>();
    for (let newIdx = 0; newIdx < pageOrder.length; newIdx++) {
      const srcPage = pageOrder[newIdx];
      const entry = sourceToEntry.get(srcPage);
      if (entry !== undefined) {
        newMap.set(makeKey(newEpoch, newIdx), entry.url);
        reusedSources.add(srcPage);
      }
    }

    // Revoke only the URLs that could not be remapped (deleted pages).
    sourceToEntry.forEach((entry, srcPage) => {
      if (!reusedSources.has(srcPage)) {
        URL.revokeObjectURL(entry.url);
      }
    });

    pageOrderRef.current = pageOrder;
    pageOrderKeyRef.current = pageOrderKey;
    thumbnailEpochRef.current = newEpoch;
    thumbnailsRef.current = newMap;

    queueRef.current = [];
    queueSetRef.current.clear();
    isProcessingRef.current = false;
    // 横展開漏れ修正 (Fix1): 旧 processThumbnailQueue ループは epoch 引数として
    // queueEpochRef の値をクロージャに持っている。ここを bump しないと、上の
    // isProcessingRef 強制リセット後に新しいキュー処理が始まっても、旧ループが
    // 自身の epoch チェックを通過し続けて同じ queueRef を取り合い、
    // CONCURRENCY が実質 2 倍になってしまう (ThumbnailWindow.tsx の
    // page-order-changed ハンドラの epochRef++ と対称の bump)。
    queueEpochRef.current++;

    // Cancel all in-flight worker requests (their sourcePageIndex mapping may
    // have changed; re-requests will be issued via setLoadEpoch → requestThumbnail).
    pendingsByWorkerRef.current.forEach(p => {
      p.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.resolve(null);
      });
      p.clear();
    });
    pendingRequestIdByPageRef.current.clear();
    pendingBatchRef.current.forEach(([, url]) => URL.revokeObjectURL(url));
    pendingBatchRef.current = [];
    if (batchTimerRef.current) { clearTimeout(batchTimerRef.current); batchTimerRef.current = null; }

    // Notify all item listeners so each item pulls its (possibly remapped) thumbnail.
    // Items with a cache hit will render immediately; items without will re-request.
    itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));
    setLoadEpoch(prev => prev + 1);
  }, [pageOrder]);

  const requestThumbnail = useCallback((pageIndex: number) => {
    // issue #11: 現在 epoch のエントリだけをキャッシュヒットとして扱う。
    // 前ファイルの遺残エントリは無視して新規キューイングする。
    if (thumbnailsRef.current.has(makeKey(thumbnailEpochRef.current, pageIndex))) return;
    if (!queueSetRef.current.has(pageIndex) && !pendingRequestIdByPageRef.current.has(pageIndex)) {
      queueRef.current.push(pageIndex);
      queueSetRef.current.add(pageIndex);
    }
    const epoch = queueEpochRef.current;
    setTimeout(() => processThumbnailQueue(epoch), 0);
  }, [processThumbnailQueue]);

  // 後方互換のためno-op (旧APIシグネチャを保つ)
  const triggerThumbnailLoad = useCallback(() => {
    // deferred load mode廃止により、現在は何もしない。
    // App.tsx 等の呼び出し側互換のために関数だけ残す。
  }, []);

  const handleSelectPage = useCallback((pageIndex: number) => {
    usePecoStore.getState().setCurrentPage(pageIndex);
  }, []);

  const fakeDocument = document
    ? { totalPages: document.totalPages, pages: document.pages }
    : null;

  return { loadEpoch, subscribeThumbnail, getThumbnail, subscribeActivePage, getIsActivePage, subscribeDirtyPage, getIsDirtyPage, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument, triggerThumbnailLoad };
}
