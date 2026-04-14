import { useState, useRef, useCallback, useEffect } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { convertFileSrc } from '@tauri-apps/api/core';

// サムネイル生成を thumbnail.worker.ts (OffscreenCanvas) に委譲することで
// メインスレッドのブロックを回避する。
// ThumbnailWindow.tsx と同じ Worker プール方式を採用。

const NUM_WORKERS = 2;
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

  // バッチ更新用
  const pendingBatchRef = useRef<Array<[number, string]>>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // サムネイルが届いたとき: refを更新し、そのアイテムのリスナーだけ呼ぶ（O(1)）
  const flushBatch = useCallback(() => {
    batchTimerRef.current = null;
    const entries = pendingBatchRef.current.splice(0);
    if (entries.length === 0) return;
    for (const [idx, url] of entries) {
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
      worker.postMessage({ type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx });
    });
  }, []);

  // キュー処理
  const processThumbnailQueue = useCallback(async (epoch: number) => {
    console.log(`[ThumbnailPanel] processThumbnailQueue epoch=${epoch}, isPdfReady=${isPdfReadyRef.current}, isProcessing=${isProcessingRef.current}, queueLen=${queueRef.current.length}`);
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
              pendingBatchRef.current.push([pageIdx, url]);
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
      worker.onmessage = (e: MessageEvent) => {
        const { type, pageIndex, bytes } = e.data;

        if (type === 'LOAD_COMPLETE' || type === 'LOAD_ERROR') {
          console.log(`[ThumbnailPanel] Worker ${workerIndex} ${type}`);
          if (type === 'LOAD_ERROR') {
            console.error(`[useThumbnailPanel] Worker ${workerIndex} load error:`, e.data.message);
          }
          const resolve = loadResolvesRef.current[workerIndex];
          if (resolve) {
            loadResolvesRef.current[workerIndex] = null;
            resolve(type === 'LOAD_COMPLETE');
          } else {
            console.warn(`[ThumbnailPanel] Worker ${workerIndex} LOAD_COMPLETE but no resolve`);
          }
          return;
        }

        const resolve = myPending.get(pageIndex);
        if (!resolve) return;
        myPending.delete(pageIndex);

        if (type === 'THUMBNAIL_DONE' && bytes instanceof Uint8Array) {
          const blob = new Blob([bytes as any], { type: 'image/jpeg' });
          resolve(URL.createObjectURL(blob));
        } else {
          console.warn(`[ThumbnailPanel] Worker ${workerIndex} unexpected: type=${type}, bytes instanceof Uint8Array=${bytes instanceof Uint8Array}`);
          resolve(null);
        }
      };

      worker.onerror = () => {
        myPending.forEach(r => r(null));
        myPending.clear();
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

    // バッチタイマーをクリア
    pendingBatchRef.current = [];
    if (batchTimerRef.current) { clearTimeout(batchTimerRef.current); batchTimerRef.current = null; }

    // サムネイルrefをクリアし、全登録アイテムに通知（プレースホルダー表示へ）
    thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
    thumbnailsRef.current = new Map();
    itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));

    // loadEpoch を増加させてアイテムの再リクエストを促す
    setLoadEpoch(prev => prev + 1);

    if (!document?.filePath || workersRef.current.length === 0) return;

    // URL を直接 Worker に渡す（pdfjs が range request でストリーミング取得）
    const url = toAssetUrl(document.filePath);
    const workers = workersRef.current;

    const perWorkerPromises = workers.map((_, i) =>
      new Promise<boolean>(resolve => {
        loadResolvesRef.current[i] = resolve;
      })
    );

    workers.forEach(worker => {
      worker.postMessage({ type: 'LOAD_PDF', url });
    });

    Promise.all(perWorkerPromises).then((results) => {
      console.log(`[ThumbnailPanel] All workers ready, results=${JSON.stringify(results)}, epoch=${epoch}, current=${epochRef.current}, queue=${queueRef.current.length}`);
      if (epochRef.current !== epoch) return;
      isPdfReadyRef.current = true;
      processThumbnailQueue(epoch);
    });
  }, [document?.filePath, processThumbnailQueue]);

  const requestThumbnail = useCallback((pageIndex: number) => {
    if (thumbnailsRef.current.has(pageIndex)) return;
    if (!queueRef.current.includes(pageIndex)) {
      queueRef.current.push(pageIndex);
    }
    const epoch = epochRef.current;
    setTimeout(() => processThumbnailQueue(epoch), 0);
  }, [processThumbnailQueue]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    usePecoStore.getState().setCurrentPage(pageIndex);
  }, []);

  const fakeDocument = document
    ? { totalPages: document.totalPages, pages: document.pages }
    : null;

  return { loadEpoch, subscribeThumbnail, getThumbnail, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument };
}
