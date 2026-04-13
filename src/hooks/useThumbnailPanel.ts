import { useState, useRef, useCallback, useEffect } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { convertFileSrc } from '@tauri-apps/api/core';

const CONCURRENCY = 6;

function toAssetUrl(filePath: string): string {
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) url = 'http://' + url;
  return url;
}

export function useThumbnailPanel() {
  const { document, currentPageIndex } = usePecoStore();
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());

  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  // pageIndex → Promise の resolve（ワーカーからの応答待ち）
  const pendingRef = useRef<Map<number, (url: string | null) => void>>(new Map());
  // PDF ロード完了待ち用の resolve callback
  const loadResolveRef = useRef<((ok: boolean) => void) | null>(null);

  // ワーカーの初期化（マウント時1回、アンマウント時に終了）
  useEffect(() => {
    const worker = new Worker(
      new URL('../utils/thumbnail.worker.ts', import.meta.url),
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
        console.error('[useThumbnailPanel] Worker PDF load error:', e.data.message);
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
      console.error('[useThumbnailPanel] Worker error:', err);
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

  // ワーカーに1ページ分のサムネイル生成を依頼し、完了を Promise で待つ
  const generateViaWorker = useCallback((pageIdx: number): Promise<string | null> => {
    return new Promise(resolve => {
      const worker = workerRef.current;
      if (!worker) { resolve(null); return; }

      // 既にリクエスト中の場合は新しい Promise を作らずに無視（重複回避）
      if (pendingRef.current.has(pageIdx)) {
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        if (pendingRef.current.has(pageIdx)) {
          console.warn(`[useThumbnailPanel] Page ${pageIdx + 1} timeout`);
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

        // 既に生成済みのページを除外（setThumbnails コールバック外でチェックしてスタベーション防止）
        if (batch.length === 0) continue;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            const url = await generateViaWorker(pageIdx);
            if (!url) return;
            if (epochRef.current === epoch) {
              setThumbnails(prev => {
                if (prev.has(pageIdx)) {
                  URL.revokeObjectURL(url); // 重複生成の場合は破棄
                  return prev;
                }
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

  // ファイル切り替え：キャッシュリセット＋ワーカーに新PDFをロード
  const prevFilePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (document?.filePath === prevFilePathRef.current) return;
    prevFilePathRef.current = document?.filePath;

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

    if (document?.filePath) {
      const url = toAssetUrl(document.filePath);
      workerRef.current?.postMessage({ type: 'LOAD_PDF', url });

      // LOAD_COMPLETE を受け取ったらキュー処理開始
      new Promise<boolean>(resolve => {
        loadResolveRef.current = resolve;
      }).then(ok => {
        if (!ok || epochRef.current !== epoch) return;
        processThumbnailQueue(epoch);
      });
    }
  }, [document?.filePath, processThumbnailQueue]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    usePecoStore.getState().setCurrentPage(pageIndex);
  }, []);

  const fakeDocument = document
    ? { totalPages: document.totalPages, pages: document.pages }
    : null;

  return { thumbnails, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument };
}
