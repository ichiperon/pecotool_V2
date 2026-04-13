import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ThumbnailPanel } from '../Sidebar/ThumbnailPanel';
import '../../App.css';

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

export function ThumbnailWindow() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const [dirtyPages, setDirtyPages] = useState<Set<number>>(new Set());

  // --- Worker management ---
  const workerRef = useRef<Worker | null>(null);
  // pageIndex → resolve callback（ワーカーからの THUMBNAIL_DONE/ERROR 待ち）
  const pendingRef = useRef<Map<number, (url: string | null) => void>>(new Map());
  // PDF ロード完了待ち用の resolve callback
  const loadResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);

  // バツボタンで閉じず非表示にする
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Worker の初期化（マウント時1回）
  useEffect(() => {
    const worker = new Worker(
      new URL('../../utils/thumbnail.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const { type, pageIndex, bytes } = e.data;

      // PDF ロード完了通知
      if (type === 'LOAD_COMPLETE') {
        loadResolveRef.current?.(true);
        loadResolveRef.current = null;
        return;
      }
      if (type === 'LOAD_ERROR') {
        console.error('[ThumbnailWindow] Worker PDF load error:', e.data.message);
        loadResolveRef.current?.(false);
        loadResolveRef.current = null;
        return;
      }

      // サムネイル生成完了
      const resolve = pendingRef.current.get(pageIndex);
      if (!resolve) return;
      pendingRef.current.delete(pageIndex);

      if (type === 'THUMBNAIL_DONE' && bytes instanceof Uint8Array) {
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        resolve(URL.createObjectURL(blob));
      } else {
        resolve(null);
      }
    };

    worker.onerror = (err) => {
      console.error('[ThumbnailWindow] Worker error:', err);
      loadResolveRef.current?.(false);
      loadResolveRef.current = null;
      pendingRef.current.forEach(r => r(null));
      pendingRef.current.clear();
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
      loadResolveRef.current?.(false);
      loadResolveRef.current = null;
      pendingRef.current.forEach(r => r(null));
      pendingRef.current.clear();
    };
  }, []);

  // Worker に1ページ分のサムネイル生成を依頼し、完了を Promise で待つ
  const generateViaWorker = useCallback((pageIdx: number): Promise<string | null> => {
    return new Promise(resolve => {
      const worker = workerRef.current;
      if (!worker) { resolve(null); return; }

      // 既にリクエスト中の場合は重複回避
      if (pendingRef.current.has(pageIdx)) {
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        if (pendingRef.current.has(pageIdx)) {
          console.warn(`[ThumbnailWindow] Page ${pageIdx + 1} thumbnail timeout`);
          pendingRef.current.delete(pageIdx);
          resolve(null);
        }
      }, 15000);

      pendingRef.current.set(pageIdx, (url: string | null) => {
        clearTimeout(timeout);
        resolve(url);
      });
      worker.postMessage({ type: 'GENERATE_THUMBNAIL', pageIndex: pageIdx });
    });
  }, []);

  // キュー処理（stale closure を避けるため epoch を引数で受け取る）
  const processThumbnailQueue = useCallback(async (epoch: number) => {
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

  // --- Event listeners ---
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      // ファイルが開かれた
      unlisteners.push(await listen<ThumbnailFileOpenedPayload>('thumbnail:file-opened', (e) => {
        const { filePath: fp, currentPageIndex: page, totalPages: total, dirtyPages: dirty } = e.payload;

        epochRef.current++;
        const epoch = epochRef.current;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;

        // 前の PDF ロード待ちをキャンセル
        loadResolveRef.current?.(false);
        loadResolveRef.current = null;

        pendingRef.current.forEach(r => r(null));
        pendingRef.current.clear();

        setThumbnails(prev => {
          prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
          return new Map();
        });
        setFilePath(fp);
        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));

        // Worker に新しい PDF をロード
        const assetUrl = toAssetUrl(fp);
        workerRef.current?.postMessage({ type: 'LOAD_PDF', url: assetUrl });

        // LOAD_COMPLETE を受け取ったらキュー処理開始（Promise で確実に待つ）
        new Promise<boolean>(resolve => {
          loadResolveRef.current = resolve;
        }).then(ok => {
          if (!ok || epochRef.current !== epoch) return;
          processThumbnailQueue(epoch);
        });
      }));

      // ファイルが閉じられた
      unlisteners.push(await listen('thumbnail:file-closed', () => {
        epochRef.current++;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;
        loadResolveRef.current?.(false);
        loadResolveRef.current = null;
        pendingRef.current.forEach(r => r(null));
        pendingRef.current.clear();
        setThumbnails(prev => {
          prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
          return new Map();
        });
        setFilePath(null);
        setTotalPages(0);
        setCurrentPageIndex(0);
        setDirtyPages(new Set());
      }));

      // ページが変わった
      unlisteners.push(await listen<{ pageIndex: number }>('thumbnail:page-changed', (e) => {
        setCurrentPageIndex(e.payload.pageIndex);
      }));

      // Dirty状態が更新された
      unlisteners.push(await listen<{ dirtyPages: number[] }>('thumbnail:dirty-update', (e) => {
        setDirtyPages(new Set(e.payload.dirtyPages));
      }));

      // 全リスナー登録完了後に現在状態を要求
      await emit('thumbnail:request-state');
    };

    setup().catch(console.error);
    return () => { unlisteners.forEach(fn => fn()); };
  }, [processThumbnailQueue]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    setCurrentPageIndex(pageIndex);
    emit('thumbnail:page-selected', { pageIndex }).catch(console.error);
  }, []);

  // ThumbnailPanel の document 互換オブジェクト
  const fakeDocument = filePath
    ? { totalPages, pages: new Map(Array.from(dirtyPages).map(i => [i, { isDirty: true }])) }
    : null;

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ThumbnailPanel
        width={220}
        document={fakeDocument}
        currentPageIndex={currentPageIndex}
        thumbnails={thumbnails}
        onSelectPage={handleSelectPage}
        onRequestThumbnail={requestThumbnail}
      />
    </div>
  );
}
