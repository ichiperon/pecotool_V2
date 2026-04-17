import { useState, useEffect, useRef, useCallback, useReducer, memo } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import '../../App.css';

// ★ 高速化1: 3ワーカー並列
const NUM_WORKERS = 3;
const CONCURRENCY = 6;

function toAssetUrl(filePath: string): string {
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) url = 'http://' + url;
  return url;
}

interface ThumbnailFileOpenedPayload {
  filePath: string;
  currentPageIndex: number;
  totalPages: number;
  dirtyPages: number[];
}

// ---- Thumbnail アイテム ----
const ThumbnailItem = memo(({
  index, currentPageIndex, isDirty, loadEpoch, onSelect, onRequest,
  onSubscribeThumbnail, onGetThumbnail,
}: {
  index: number;
  currentPageIndex: number;
  isDirty?: boolean;
  loadEpoch: number;
  onSelect: (i: number) => void;
  onRequest: (i: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
}) => {
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  // このアイテム専用のサムネイル更新を購読
  useEffect(() => {
    return onSubscribeThumbnail(index, forceUpdate);
  }, [index, onSubscribeThumbnail]);

  const thumbnailUrl = onGetThumbnail(index);

  useEffect(() => {
    if (!thumbnailUrl) onRequest(index);
  // loadEpoch が変化したとき（ファイル切り替え後）に再リクエストを強制する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, thumbnailUrl, onRequest, loadEpoch]);

  return (
    <div
      className={`thumbnail-item ${index === currentPageIndex ? 'active' : ''}`}
      onClick={() => onSelect(index)}
    >
      <div className="thumbnail-box">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={`Page ${index + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <span style={{ color: '#d1d5db', fontSize: 24 }}>{index + 1}</span>
        )}
      </div>
      <div className="thumbnail-label">{index + 1} ページ {isDirty && '●'}</div>
    </div>
  );
});

// ---- ウィンドウコンポーネント ----
export function ThumbnailWindow() {
  const [totalPages, setTotalPages] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [dirtyPages, setDirtyPages] = useState<Set<number>>(new Set());
  const [loadEpoch, setLoadEpoch] = useState(0);

  // サムネイルデータはRefで保持（Reactの外）
  const thumbnailsRef = useRef<Map<number, string>>(new Map());
  const itemListenersRef = useRef<Map<number, Set<() => void>>>(new Map());
  // ページごとの最新生成番号。古いレスポンスを判別してrevokeするために使う
  const pageGenerationRef = useRef<Map<number, number>>(new Map());
  // Map に格納した URL の生成番号（新旧どちらが最新か比較用）
  const storedGenerationRef = useRef<Map<number, number>>(new Map());

  // ★ Worker プール
  const workersRef = useRef<Worker[]>([]);
  const pendingsByWorkerRef = useRef<Array<Map<number, (url: string | null) => void>>>([]);
  const loadResolvesRef = useRef<Array<((ok: boolean) => void) | null>>(
    new Array(NUM_WORKERS).fill(null)
  );
  // ★ 全 Worker が LOAD_COMPLETE するまでキュー処理をブロックするフラグ
  const isPdfReadyRef = useRef(false);

  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // バツボタンで閉じず非表示にする
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
      emit('thumbnail:hidden');
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // サムネイル取得 API（安定参照）
  const subscribeThumbnail = useCallback((index: number, cb: () => void) => {
    if (!itemListenersRef.current.has(index)) {
      itemListenersRef.current.set(index, new Set());
    }
    itemListenersRef.current.get(index)!.add(cb);
    return () => {
      itemListenersRef.current.get(index)?.delete(cb);
    };
  }, []);

  const getThumbnail = useCallback((index: number) => {
    return thumbnailsRef.current.get(index);
  }, []);

  // ---- Worker プール初期化（マウント時1回）----
  useEffect(() => {
    const pendingsByWorker: Array<Map<number, (url: string | null) => void>> = [];
    const workers: Worker[] = [];

    for (let wi = 0; wi < NUM_WORKERS; wi++) {
      const myPending = new Map<number, (url: string | null) => void>();
      pendingsByWorker.push(myPending);

      const worker = new Worker(
        new URL('../../utils/thumbnail.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const workerIndex = wi;
      worker.onmessage = (e: MessageEvent) => {
        const { type, pageIndex, bytes } = e.data;

        if (type === 'LOAD_COMPLETE' || type === 'LOAD_ERROR') {
          if (type === 'LOAD_ERROR') {
            console.error(`[ThumbnailWindow] Worker ${workerIndex} load error:`, e.data.message);
          }
          // ★ per-worker resolve（古い LOAD_COMPLETE は null のため無害）
          const resolve = loadResolvesRef.current[workerIndex];
          if (resolve) {
            loadResolvesRef.current[workerIndex] = null;
            resolve(type === 'LOAD_COMPLETE');
          }
          return;
        }

        const resolve = myPending.get(pageIndex);
        if (!resolve) return;
        myPending.delete(pageIndex);

        if (type === 'THUMBNAIL_DONE' && bytes instanceof Uint8Array) {
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          resolve(URL.createObjectURL(blob));
        } else {
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

  // ---- ページをワーカーに分散してサムネイル生成 ----
  // このリクエストの生成番号を返り値に含め、呼び出し側で古い応答を判定できるようにする
  const generateViaWorker = useCallback((pageIdx: number): Promise<{ url: string | null; generation: number }> => {
    const generation = (pageGenerationRef.current.get(pageIdx) ?? 0) + 1;
    pageGenerationRef.current.set(pageIdx, generation);
    return new Promise(resolve => {
      const workers = workersRef.current;
      const pendingsByWorker = pendingsByWorkerRef.current;
      if (workers.length === 0) { resolve({ url: null, generation }); return; }

      const workerIdx = pageIdx % workers.length;
      const worker = workers[workerIdx];
      const myPending = pendingsByWorker[workerIdx];

      if (myPending.has(pageIdx)) { resolve({ url: null, generation }); return; }

      const timeout = setTimeout(() => {
        if (myPending.has(pageIdx)) {
          myPending.delete(pageIdx);
          resolve({ url: null, generation });
        }
      }, 15000);

      myPending.set(pageIdx, (url: string | null) => {
        clearTimeout(timeout);
        resolve({ url, generation });
      });
      worker.postMessage({ type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx });
    });
  }, []);

  // ---- キュー処理 ----
  const processThumbnailQueue = useCallback(async (epoch: number) => {
    if (!isPdfReadyRef.current) return; // PDF ロード完了前はキューを処理しない
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    try {
      while (thumbnailQueueRef.current.length > 0) {
        if (epochRef.current !== epoch) break;
        const batch: number[] = [];
        while (batch.length < CONCURRENCY && thumbnailQueueRef.current.length > 0) {
          batch.push(thumbnailQueueRef.current.shift()!);
        }
        if (batch.length === 0) continue;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            const { url, generation } = await generateViaWorker(pageIdx);
            if (!url) return;
            // epoch が進んでいる or このページに対してより新しいリクエストが発行済みなら古い
            const latestGen = pageGenerationRef.current.get(pageIdx) ?? 0;
            if (epochRef.current !== epoch || generation !== latestGen) {
              URL.revokeObjectURL(url);
              return;
            }
            const storedGen = storedGenerationRef.current.get(pageIdx) ?? 0;
            if (generation < storedGen) {
              // 既により新しい生成のURLが保存済み → 新規URLを捨てる
              URL.revokeObjectURL(url);
              return;
            }
            const prev = thumbnailsRef.current.get(pageIdx);
            if (prev && prev !== url) {
              URL.revokeObjectURL(prev);
            }
            thumbnailsRef.current.set(pageIdx, url);
            storedGenerationRef.current.set(pageIdx, generation);
            itemListenersRef.current.get(pageIdx)?.forEach(cb => cb());
          })
        );
      }
    } finally {
      isProcessingRef.current = false;
      if (thumbnailQueueRef.current.length > 0 && epochRef.current === epoch) {
        setTimeout(() => processThumbnailQueue(epoch), 0);
      }
    }
  }, [generateViaWorker]);

  const requestThumbnail = useCallback((pageIndex: number) => {
    if (thumbnailsRef.current.has(pageIndex)) return;
    if (!thumbnailQueueRef.current.includes(pageIndex)) {
      thumbnailQueueRef.current.push(pageIndex);
    }
    const epoch = epochRef.current;
    setTimeout(() => processThumbnailQueue(epoch), 0);
  }, [processThumbnailQueue]);

  // ---- Tauri イベントリスナー ----
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      unlisteners.push(await listen<ThumbnailFileOpenedPayload>('thumbnail:file-opened', (e) => {
        const { filePath: fp, currentPageIndex: page, totalPages: total, dirtyPages: dirty } = e.payload;

        epochRef.current++;
        const epoch = epochRef.current;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;
        isPdfReadyRef.current = false; // ★ ファイル切り替え時にリセット

        // 前のロード resolve を全ワーカー分キャンセル
        loadResolvesRef.current.forEach((r, i) => {
          if (r) { loadResolvesRef.current[i] = null; r(false); }
        });
        pendingsByWorkerRef.current.forEach(p => { p.forEach(r => r(null)); p.clear(); });

        // サムネイルrefをクリアし、全登録アイテムに通知（プレースホルダー表示へ）
        thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
        thumbnailsRef.current = new Map();
        pageGenerationRef.current = new Map();
        storedGenerationRef.current = new Map();
        itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));

        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));
        setLoadEpoch(prev => prev + 1);

        // ★ 高速化3: メインスレッドで fetch → ArrayBuffer → 全ワーカーに零コピー転送
        fetch(toAssetUrl(fp))
          .then(res => {
            if (epochRef.current !== epoch) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer();
          })
          .then(buf => {
            if (!buf || epochRef.current !== epoch) return;

            const workers = workersRef.current;

            const perWorkerPromises = workers.map((_, i) =>
              new Promise<boolean>(resolve => {
                loadResolvesRef.current[i] = resolve;
              })
            );

            workers.forEach((worker, i) => {
              const bytes = (i < workers.length - 1) ? buf.slice(0) : buf;
              worker.postMessage({ type: 'LOAD_PDF', bytes }, [bytes]);
            });

            // ★ 全 Worker の LOAD_COMPLETE 後に isPdfReady=true→キュー処理
            Promise.all(perWorkerPromises).then(() => {
              if (epochRef.current !== epoch) return;
              isPdfReadyRef.current = true;
              processThumbnailQueue(epoch);
            });
          })
          .catch(err => {
            if (epochRef.current === epoch) {
              console.error('[ThumbnailWindow] Failed to fetch PDF:', err);
            }
          });
      }));

      unlisteners.push(await listen('thumbnail:file-closed', () => {
        epochRef.current++;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;
        isPdfReadyRef.current = false;
        loadResolvesRef.current.forEach((r, i) => {
          if (r) { loadResolvesRef.current[i] = null; r(false); }
        });
        pendingsByWorkerRef.current.forEach(p => { p.forEach(r => r(null)); p.clear(); });
        thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
        thumbnailsRef.current = new Map();
        pageGenerationRef.current = new Map();
        storedGenerationRef.current = new Map();
        itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));
        setTotalPages(0);
        setCurrentPageIndex(0);
        setDirtyPages(new Set());
        setLoadEpoch(prev => prev + 1);
      }));

      unlisteners.push(await listen<{ pageIndex: number }>('thumbnail:page-changed', (e) => {
        setCurrentPageIndex(e.payload.pageIndex);
        virtuosoRef.current?.scrollIntoView({
          index: e.payload.pageIndex,
          behavior: 'smooth',
          done: () => {},
        });
      }));

      unlisteners.push(await listen<{ dirtyPages: number[] }>('thumbnail:dirty-update', (e) => {
        setDirtyPages(new Set(e.payload.dirtyPages));
      }));

      await emit('thumbnail:request-state');
    };

    setup().catch(console.error);
    return () => { unlisteners.forEach(fn => fn()); };
  }, [processThumbnailQueue]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
    emit('thumbnail:page-selected', { pageIndex }).catch(console.error);
  }, []);

  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--panel-bg)',
    }}>
      <div className="panel-header">サムネイル</div>
      {totalPages > 0 ? (
        <Virtuoso
          ref={virtuosoRef}
          style={{ flex: 1, minHeight: 0 }}
          totalCount={totalPages}
          itemContent={(i) => (
            <ThumbnailItem
              index={i}
              currentPageIndex={currentPageIndex}
              isDirty={dirtyPages.has(i)}
              loadEpoch={loadEpoch}
              onSelect={handleSelectPage}
              onRequest={requestThumbnail}
              onSubscribeThumbnail={subscribeThumbnail}
              onGetThumbnail={getThumbnail}
            />
          )}
        />
      ) : (
        <div className="placeholder">ファイルを開いてください</div>
      )}
    </div>
  );
}
