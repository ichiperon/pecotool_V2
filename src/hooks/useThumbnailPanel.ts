import { useState, useRef, useCallback, useEffect } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { convertFileSrc } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';
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

export function useThumbnailPanel() {
  const { document, currentPageIndex } = usePecoStore();

  // サムネイルデータはRefで保持（Reactの外）— 更新時に全アイテム再レンダリングを防ぐ
  const thumbnailsRef = useRef<Map<number, string>>(new Map());
  // アイテムごとの購読コールバック: index → Set<forceUpdate>
  const itemListenersRef = useRef<Map<number, Set<() => void>>>(new Map());

  const [loadEpoch, setLoadEpoch] = useState(0);

  // Worker プール
  const workersRef = useRef<Worker[]>([]);
  // Worker ごとの未完了コールバック map: pageIndex -> resolve
  const pendingsByWorkerRef = useRef<Array<Map<number, (url: string | null) => void>>>([]);
  // Worker ごとの LOAD_COMPLETE 解決用 resolve
  const loadResolvesRef = useRef<Array<((ok: boolean) => void) | null>>(
    new Array(NUM_WORKERS).fill(null)
  );

  const epochRef = useRef(0);
  const isPdfReadyRef = useRef(false);
  const queueRef = useRef<number[]>([]);
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
      if (batchEpoch !== epochRef.current) {
        URL.revokeObjectURL(url);
        continue;
      }
      if (thumbnailsRef.current.has(idx)) {
        URL.revokeObjectURL(url);
      } else {
        thumbnailsRef.current.set(idx, url);
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
    return thumbnailsRef.current.get(index);
  }, []);

  // ページをワーカーに分散してサムネイル生成
  const generateViaWorker = useCallback((pageIdx: number): Promise<string | null> => {
    return new Promise(resolve => {
      const workers = workersRef.current;
      const pendingsByWorker = pendingsByWorkerRef.current;
      if (workers.length === 0) { resolve(null); return; }

      const workerIdx = pageIdx % workers.length;
      const worker = workers[workerIdx];
      const myPending = pendingsByWorker[workerIdx];

      if (myPending.has(pageIdx)) { resolve(null); return; }

      const timeout = setTimeout(() => {
        if (myPending.has(pageIdx)) {
          myPending.delete(pageIdx);
          resolve(null);
        }
      }, 15000);

      myPending.set(pageIdx, (url: string | null) => {
        clearTimeout(timeout);
        resolve(url);
      });
      const req: ThumbnailWorkerRequest = { type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx };
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
        if (epochRef.current !== epoch) break;

        const batch: number[] = [];
        while (batch.length < CONCURRENCY && queueRef.current.length > 0) {
          batch.push(queueRef.current.shift()!);
        }
        if (batch.length === 0) continue;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            const url = await generateViaWorker(pageIdx);
            if (!url) return;
            if (epochRef.current === epoch) {
              pendingBatchRef.current.push([pageIdx, url, epoch]);
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
      if (queueRef.current.length > 0 && epochRef.current === epoch) {
        setTimeout(() => processThumbnailQueue(epoch), 0);
      }
    }
  }, [generateViaWorker, flushBatch]);

  // Worker プール初期化（マウント時1回）
  useEffect(() => {
    const pendingsByWorker: Array<Map<number, (url: string | null) => void>> = [];
    const workers: Worker[] = [];

    for (let wi = 0; wi < NUM_WORKERS; wi++) {
      const myPending = new Map<number, (url: string | null) => void>();
      pendingsByWorker.push(myPending);

      const worker = new Worker(
        new URL('../utils/thumbnail.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const workerIndex = wi;
      worker.onmessage = (e: MessageEvent<ThumbnailWorkerResponse>) => {
        const msg = e.data;

        if (msg.type === 'LOAD_COMPLETE' || msg.type === 'LOAD_ERROR') {
          logger.log(`[ThumbnailPanel] Worker ${workerIndex} ${msg.type}`);
          if (msg.type === 'LOAD_ERROR') {
            console.error(`[useThumbnailPanel] Worker ${workerIndex} load error:`, msg.message);
          }
          const resolve = loadResolvesRef.current[workerIndex];
          if (resolve) {
            loadResolvesRef.current[workerIndex] = null;
            resolve(msg.type === 'LOAD_COMPLETE');
          } else {
            console.warn(`[ThumbnailPanel] Worker ${workerIndex} LOAD_COMPLETE but no resolve`);
          }
          return;
        }

        if (msg.type === 'THUMBNAIL_DONE') {
          const resolve = myPending.get(msg.pageIndex);
          if (!resolve) return;
          myPending.delete(msg.pageIndex);

          if (msg.bytes instanceof Uint8Array) {
            const blob = new Blob([msg.bytes], { type: 'image/jpeg' });
            resolve(URL.createObjectURL(blob));
          } else {
            console.warn(`[ThumbnailPanel] Worker ${workerIndex} THUMBNAIL_DONE without Uint8Array`);
            resolve(null);
          }
          return;
        }

        if (msg.type === 'THUMBNAIL_ERROR') {
          const resolve = myPending.get(msg.pageIndex);
          if (!resolve) return;
          myPending.delete(msg.pageIndex);
          console.error(`[ThumbnailPanel] Worker ${workerIndex} page ${msg.pageIndex + 1} render error:`, msg.error);
          resolve(null);
          return;
        }

        // 網羅性チェック: 未知メッセージを static に検出
        const _exhaustive: never = msg;
        return _exhaustive;
      };

      worker.onerror = (ev) => {
        console.error(`[useThumbnailPanel] Worker ${workerIndex} onerror:`, ev);
        // 未完了のサムネイル要求を全て null で解決
        myPending.forEach(r => r(null));
        myPending.clear();
        // LOAD_PDF 応答待ちのプロミスも false で解決しないと isPdfReadyRef が
        // 永久に false のまま → 以降全てのサムネイル要求が処理されなくなる。
        const loadResolve = loadResolvesRef.current[workerIndex];
        if (loadResolve) {
          loadResolvesRef.current[workerIndex] = null;
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
      pendingsByWorker.forEach(p => { p.forEach(r => r(null)); p.clear(); });
      pendingsByWorkerRef.current = [];
      loadResolvesRef.current.forEach((r, i) => {
        if (r) { loadResolvesRef.current[i] = null; r(false); }
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
  const prevFilePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (document?.filePath === prevFilePathRef.current) return;
    prevFilePathRef.current = document?.filePath;

    epochRef.current++;
    const epoch = epochRef.current;
    queueRef.current = [];
    isProcessingRef.current = false;
    isPdfReadyRef.current = false;

    // 前のロード resolve をキャンセル
    loadResolvesRef.current.forEach((r, i) => {
      if (r) { loadResolvesRef.current[i] = null; r(false); }
    });
    pendingsByWorkerRef.current.forEach(p => { p.forEach(r => r(null)); p.clear(); });

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

    if (!document?.filePath || workersRef.current.length === 0) return;

    const capturedFilePath = document.filePath;
    const capturedEpoch = epoch;

    const startWorkerLoad = async () => {
      if (epochRef.current !== capturedEpoch) return;
      const url = toAssetUrl(capturedFilePath);
      const workers = workersRef.current;

      // メインスレッドで1回だけfetchし、WorkerにはArrayBufferを渡す（重複ネットワークアクセス回避）
      let pdfBytes: ArrayBuffer;
      try {
        logger.log('[ThumbnailPanel] Fetching PDF for thumbnails:', url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        pdfBytes = await response.arrayBuffer();
        logger.log('[ThumbnailPanel] PDF bytes loaded:', pdfBytes.byteLength, 'bytes');
      } catch (e) {
        console.error('[useThumbnailPanel] PDF fetch failed:', e);
        // フォールバック: 従来通りURLを渡す
        const perWorkerPromises = workers.map((_, i) =>
          new Promise<boolean>(resolve => {
            loadResolvesRef.current[i] = resolve;
          })
        );
        workers.forEach(worker => {
          const req: ThumbnailWorkerRequest = { type: 'LOAD_PDF', url };
          worker.postMessage(req);
        });
        Promise.all(perWorkerPromises).then(() => {
          if (epochRef.current !== capturedEpoch) return;
          isPdfReadyRef.current = true;
          processThumbnailQueue(capturedEpoch);
        });
        return;
      }

      if (epochRef.current !== capturedEpoch) return;

      const perWorkerPromises = workers.map((_, i) =>
        new Promise<boolean>(resolve => {
          loadResolvesRef.current[i] = resolve;
        })
      );

      logger.log('[ThumbnailPanel] Posting LOAD_PDF to', workers.length, 'worker(s)');
      workers.forEach(worker => {
        // Worker が1つなのでコピー不要 — 元の ArrayBuffer を直接 transfer
        const req: ThumbnailWorkerRequest = { type: 'LOAD_PDF', bytes: pdfBytes };
        worker.postMessage(req, [pdfBytes]);
      });

      Promise.all(perWorkerPromises).then((results) => {
        logger.log(`[ThumbnailPanel] All workers ready, results=${JSON.stringify(results)}, epoch=${capturedEpoch}, current=${epochRef.current}, queue=${queueRef.current.length}`);
        if (epochRef.current !== capturedEpoch) return;
        isPdfReadyRef.current = true;
        processThumbnailQueue(capturedEpoch);
      });
    };

    // メインスレッドの1ページ目レンダ + テキスト抽出が落ち着いてから
    // LOAD_PDF を送る。初期の asset protocol I/O + CPU 競合を避け、
    // 「編集可能」までの体感時間を短縮する。
    // タイムアウトを 2000ms に設定: アイドルが来なければ必ず実行。
    logger.log(`[ThumbnailPanel] Scheduling worker load for ${capturedFilePath}`);
    const runDeferredLoad = () => {
      if (epochRef.current !== capturedEpoch) return;
      if (prevFilePathRef.current !== capturedFilePath) return;
      startWorkerLoad();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(runDeferredLoad, { timeout: 2000 });
    } else {
      setTimeout(runDeferredLoad, 1500);
    }
  }, [document?.filePath, processThumbnailQueue]);

  const requestThumbnail = useCallback((pageIndex: number) => {
    if (thumbnailsRef.current.has(pageIndex)) return;
    if (!queueRef.current.includes(pageIndex)) {
      queueRef.current.push(pageIndex);
    }
    const epoch = epochRef.current;
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

  return { loadEpoch, subscribeThumbnail, getThumbnail, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument, triggerThumbnailLoad };
}
