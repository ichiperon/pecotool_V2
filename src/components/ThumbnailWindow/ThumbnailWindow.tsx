import { useState, useEffect, useRef, useCallback, memo } from 'react';
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
  index, currentPageIndex, thumbnailUrl, isDirty, onSelect, onRequest,
}: {
  index: number;
  currentPageIndex: number;
  thumbnailUrl?: string;
  isDirty?: boolean;
  onSelect: (i: number) => void;
  onRequest: (i: number) => void;
}) => {
  useEffect(() => {
    if (!thumbnailUrl) onRequest(index);
  }, [index, thumbnailUrl, onRequest]);

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
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const [dirtyPages, setDirtyPages] = useState<Set<number>>(new Set());

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
            const url = await generateViaWorker(pageIdx);
            if (!url) return;
            if (epochRef.current === epoch) {
              setThumbnails(prev => {
                if (prev.has(pageIdx)) { URL.revokeObjectURL(url); return prev; }
                const next = new Map(prev);
                next.set(pageIdx, url);
                return next;
              });
            } else {
              URL.revokeObjectURL(url);
            }
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
    setThumbnails(prev => {
      if (prev.has(pageIndex)) return prev;
      if (!thumbnailQueueRef.current.includes(pageIndex)) {
        thumbnailQueueRef.current.push(pageIndex);
      }
      const epoch = epochRef.current;
      setTimeout(() => processThumbnailQueue(epoch), 0);
      return prev;
    });
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

        setThumbnails(prev => {
          prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
          return new Map();
        });
        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));

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
        setThumbnails(prev => {
          prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
          return new Map();
        });
        setTotalPages(0);
        setCurrentPageIndex(0);
        setDirtyPages(new Set());
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
              thumbnailUrl={thumbnails.get(i)}
              isDirty={dirtyPages.has(i)}
              onSelect={handleSelectPage}
              onRequest={requestThumbnail}
            />
          )}
        />
      ) : (
        <div className="placeholder">ファイルを開いてください</div>
      )}
    </div>
  );
}
