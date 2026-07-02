import { useState, useEffect, useRef, useCallback, useReducer, memo } from 'react';
import type { CSSProperties } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from '../../utils/thumbnailWorkerTypes';
import { logUnlessTauriWindowNotFound } from '../../utils/tauriWindowErrors';
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
  pageOrder: number[];
  // issue #431 (FB-6): 表示 (pageOrder) 順の回転角度一覧。未着手だった旧バージョンとの
  // 互換のため任意フィールドとして扱い、未受信時は 0 度扱いにフォールバックする。
  rotations?: number[];
}

interface ThumbnailPageOrderChangedPayload {
  currentPageIndex: number;
  totalPages: number;
  dirtyPages: number[];
  pageOrder: number[];
  rotations?: number[];
}

type PendingThumbnail = {
  pageIndex: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (url: string | null) => void;
};

// ---- Thumbnail アイテム ----
const ThumbnailItem = memo(({
  index, currentPageIndex, isDirty, loadEpoch, rotation, onSelect, onRequest,
  onSubscribeThumbnail, onGetThumbnail,
}: {
  index: number;
  currentPageIndex: number;
  isDirty?: boolean;
  loadEpoch: number;
  // issue #431 (FB-6): 内蔵パネル (ThumbnailPanel.tsx) と対称の UI 回転反映
  rotation: number;
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

  // issue #207 由来・ThumbnailPanel.tsx と同じ CSS variable 方式。
  // 90/270 度では元の縦横比が入れ替わるため box の枠を回転後の向きに合わせる。
  const THUMB_W = 120;
  const THUMB_H = 160;
  const isLandscape = rotation === 90 || rotation === 270;
  const boxVarStyle: CSSProperties | undefined = isLandscape
    ? { '--thumb-box-w': `${THUMB_H}px`, '--thumb-box-h': `${THUMB_W}px` } as CSSProperties
    : undefined;
  const rotationVarStyle: CSSProperties | undefined = rotation !== 0
    ? { '--thumbnail-rotation': `${rotation}deg` } as CSSProperties
    : undefined;
  const imgClassName = rotation !== 0 ? 'thumbnail-img thumbnail-img--rotated' : 'thumbnail-img';

  return (
    <div
      className={`thumbnail-item ${index === currentPageIndex ? 'active' : ''}`}
      onClick={() => onSelect(index)}
    >
      <div className="thumbnail-box" style={boxVarStyle}>
        {thumbnailUrl ? (
          <img
            className={imgClassName}
            src={thumbnailUrl}
            alt={`Page ${index + 1}`}
            style={rotationVarStyle}
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
  // issue #431 (FB-6): 表示 (pageOrder) 順の回転角度一覧
  const [rotations, setRotations] = useState<number[]>([]);

  // サムネイルデータはRefで保持（Reactの外）
  const thumbnailsRef = useRef<Map<number, string>>(new Map());
  const itemListenersRef = useRef<Map<number, Set<() => void>>>(new Map());
  // ページごとの最新生成番号。古いレスポンスを判別してrevokeするために使う
  const pageGenerationRef = useRef<Map<number, number>>(new Map());
  // Map に格納した URL の生成番号（新旧どちらが最新か比較用）
  const storedGenerationRef = useRef<Map<number, number>>(new Map());
  const pageOrderRef = useRef<number[]>([]);

  // ★ Worker プール
  const workersRef = useRef<Worker[]>([]);
  const pendingsByWorkerRef = useRef<Array<Map<number, PendingThumbnail>>>([]);
  const pendingRequestIdByPageRef = useRef<Map<number, number>>(new Map());
  const loadResolvesRef = useRef<Array<((ok: boolean) => void) | null>>(
    new Array(NUM_WORKERS).fill(null)
  );
  const loadRequestIdsRef = useRef<Array<number | null>>(
    new Array(NUM_WORKERS).fill(null)
  );
  const nextWorkerRequestIdRef = useRef(0);
  // ★ 全 Worker が LOAD_COMPLETE するまでキュー処理をブロックするフラグ
  const isPdfReadyRef = useRef(false);

  const thumbnailQueueRef = useRef<number[]>([]);
  // issue #181: requestThumbnail の重複チェックを O(N) includes から O(1) Set lookup に。
  // キュー操作 (push/shift/clear) と必ず同期して更新すること。
  const thumbnailQueueSetRef = useRef<Set<number>>(new Set());
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);
  const pdfLoadEpochRef = useRef(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // バツボタンで閉じず非表示にする
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide().catch(logUnlessTauriWindowNotFound);
      emit('thumbnail:hidden').catch(logUnlessTauriWindowNotFound);
    }).then(fn => { unlisten = fn; }).catch(logUnlessTauriWindowNotFound);
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
    const pendingsByWorker: Array<Map<number, PendingThumbnail>> = [];
    const workers: Worker[] = [];

    for (let wi = 0; wi < NUM_WORKERS; wi++) {
      const myPending = new Map<number, PendingThumbnail>();
      pendingsByWorker.push(myPending);

      const worker = new Worker(
        new URL('../../utils/thumbnail.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const workerIndex = wi;
      worker.onmessage = (e: MessageEvent<ThumbnailWorkerResponse>) => {
        const msg = e.data;

        if (msg.type === 'LOAD_COMPLETE' || msg.type === 'LOAD_ERROR') {
          if (msg.requestId !== loadRequestIdsRef.current[workerIndex]) return;
          if (msg.type === 'LOAD_ERROR') {
            console.error(`[ThumbnailWindow] Worker ${workerIndex} load error:`, msg.message);
          }
          // ★ per-worker resolve（古い LOAD_COMPLETE は null のため無害）
          const resolve = loadResolvesRef.current[workerIndex];
          if (resolve) {
            loadResolvesRef.current[workerIndex] = null;
            loadRequestIdsRef.current[workerIndex] = null;
            resolve(msg.type === 'LOAD_COMPLETE');
          }
          return;
        }

        if (msg.type === 'THUMBNAIL_DONE') {
          if (msg.requestId === undefined) return;
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
          pending.resolve(null);
          return;
        }

        // 網羅性チェック
        const _exhaustive: never = msg;
        return _exhaustive;
      };

      worker.onerror = () => {
        myPending.forEach((pending, requestId) => {
          clearTimeout(pending.timeout);
          if (pendingRequestIdByPageRef.current.get(pending.pageIndex) === requestId) {
            pendingRequestIdByPageRef.current.delete(pending.pageIndex);
          }
          pending.resolve(null);
        });
        myPending.clear();
        const loadResolve = loadResolvesRef.current[workerIndex];
        if (loadResolve) {
          loadResolvesRef.current[workerIndex] = null;
          loadRequestIdsRef.current[workerIndex] = null;
          loadResolve(false);
        }
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
      thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
      thumbnailsRef.current = new Map();
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

      if (pendingRequestIdByPageRef.current.has(pageIdx)) { resolve({ url: null, generation }); return; }

      const requestId = ++nextWorkerRequestIdRef.current;
      const timeout = setTimeout(() => {
        const pending = myPending.get(requestId);
        if (pending) {
          myPending.delete(requestId);
          if (pendingRequestIdByPageRef.current.get(pageIdx) === requestId) {
            pendingRequestIdByPageRef.current.delete(pageIdx);
          }
          resolve({ url: null, generation });
        }
      }, 15000);

      myPending.set(requestId, {
        pageIndex: pageIdx,
        timeout,
        resolve: (url: string | null) => {
          resolve({ url, generation });
        },
      });
      pendingRequestIdByPageRef.current.set(pageIdx, requestId);
      const sourcePageIndex = pageOrderRef.current[pageIdx] ?? pageIdx;
      const req: ThumbnailWorkerRequest = {
        type: 'GENERATE_THUMBNAIL',
        pageIndex: pageIdx,
        sourcePageIndex,
        requestId,
      };
      worker.postMessage(req);
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
          const idx = thumbnailQueueRef.current.shift()!;
          thumbnailQueueSetRef.current.delete(idx);
          batch.push(idx);
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
    if (!thumbnailQueueSetRef.current.has(pageIndex)) {
      thumbnailQueueRef.current.push(pageIndex);
      thumbnailQueueSetRef.current.add(pageIndex);
    }
    const epoch = epochRef.current;
    setTimeout(() => processThumbnailQueue(epoch), 0);
  }, [processThumbnailQueue]);

  // ---- Tauri イベントリスナー ----
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      unlisteners.push(await listen<ThumbnailFileOpenedPayload>('thumbnail:file-opened', (e) => {
        const { filePath: fp, currentPageIndex: page, totalPages: total, dirtyPages: dirty, pageOrder, rotations: rot } = e.payload;

        epochRef.current++;
        pdfLoadEpochRef.current++;
        const pdfLoadEpoch = pdfLoadEpochRef.current;
        thumbnailQueueRef.current = [];
        thumbnailQueueSetRef.current.clear();
        isProcessingRef.current = false;
        isPdfReadyRef.current = false; // ★ ファイル切り替え時にリセット

        // 前のロード resolve を全ワーカー分キャンセル
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

        // サムネイルrefをクリアし、全登録アイテムに通知（プレースホルダー表示へ）
        thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
        thumbnailsRef.current = new Map();
        pageGenerationRef.current = new Map();
        storedGenerationRef.current = new Map();
        pageOrderRef.current = [...pageOrder];
        itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));

        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));
        setRotations(rot ?? []);
        setLoadEpoch(prev => prev + 1);

        const workers = workersRef.current;
        const perWorkerPromises = workers.map((_, i) =>
          new Promise<boolean>(resolve => {
            loadRequestIdsRef.current[i] = ++nextWorkerRequestIdRef.current;
            loadResolvesRef.current[i] = resolve;
          })
        );
        const url = toAssetUrl(fp);
        workers.forEach((worker, i) => {
          const requestId = loadRequestIdsRef.current[i]!;
          const req: ThumbnailWorkerRequest = { type: 'LOAD_PDF', url, requestId };
          worker.postMessage(req);
        });

        Promise.all(perWorkerPromises).then(() => {
          if (pdfLoadEpochRef.current !== pdfLoadEpoch) return;
          isPdfReadyRef.current = true;
          processThumbnailQueue(epochRef.current);
        });
      }));

      unlisteners.push(await listen('thumbnail:file-closed', () => {
        epochRef.current++;
        pdfLoadEpochRef.current++;
        thumbnailQueueRef.current = [];
        thumbnailQueueSetRef.current.clear();
        isProcessingRef.current = false;
        isPdfReadyRef.current = false;
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
        // PCT-073: worker が保持する PDF リソース（pdfDoc / 進行中の loadingTask）を
        // 明示解放する。旧実装は UI 状態のクリアのみで、次の LOAD_PDF まで閉じた
        // PDF の解析構造が worker メモリ（最大3体分）に残留していた。
        // CLOSE_PDF 後に届く旧応答は、上で実施済みの epoch++ / pending クリア /
        // loadRequestIds クリアにより既存機構で無視される。
        const closeReq: ThumbnailWorkerRequest = { type: 'CLOSE_PDF' };
        workersRef.current.forEach(w => w.postMessage(closeReq));
        thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
        thumbnailsRef.current = new Map();
        pageGenerationRef.current = new Map();
        storedGenerationRef.current = new Map();
        pageOrderRef.current = [];
        itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));
        setTotalPages(0);
        setCurrentPageIndex(0);
        setDirtyPages(new Set());
        setRotations([]);
        setLoadEpoch(prev => prev + 1);
      }));

      unlisteners.push(await listen<ThumbnailPageOrderChangedPayload>('thumbnail:page-order-changed', (e) => {
        const { currentPageIndex: page, totalPages: total, dirtyPages: dirty, pageOrder, rotations: rot } = e.payload;
        const nextPageOrder = [...pageOrder];

        epochRef.current++;
        const epoch = epochRef.current;
        thumbnailQueueRef.current = [];
        thumbnailQueueSetRef.current.clear();
        isProcessingRef.current = false;
        pendingsByWorkerRef.current.forEach(p => {
          p.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.resolve(null);
          });
          p.clear();
        });
        pendingRequestIdByPageRef.current.clear();
        thumbnailsRef.current.forEach(url => { if (url) URL.revokeObjectURL(url); });
        thumbnailsRef.current = new Map();
        pageGenerationRef.current = new Map();
        storedGenerationRef.current = new Map();
        pageOrderRef.current = nextPageOrder;
        itemListenersRef.current.forEach(cbs => cbs.forEach(cb => cb()));
        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));
        setRotations(rot ?? []);
        setLoadEpoch(prev => prev + 1);
        if (isPdfReadyRef.current) {
          setTimeout(() => processThumbnailQueue(epoch), 0);
        }
      }));

      unlisteners.push(await listen<{ rotations: number[] }>('thumbnail:rotation-update', (e) => {
        setRotations(e.payload.rotations);
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

    setup().catch((err) => logUnlessTauriWindowNotFound(err, '[ThumbnailWindow] setup failed:'));
    return () => { unlisteners.forEach(fn => fn()); };
  }, [processThumbnailQueue]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
    emit('thumbnail:page-selected', { pageIndex }).catch(logUnlessTauriWindowNotFound);
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
              rotation={rotations[i] ?? 0}
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
