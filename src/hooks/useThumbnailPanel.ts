import { useState, useRef, useCallback, useEffect } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { generateThumbnail } from '../utils/pdfLoader';

// loadPDF が完了した時点で globalSharedPdfProxy が既にロード済みになるため
// useThumbnailPanel はワーカーを使わず generateThumbnail() を直接呼び出す。
// これにより Worker-in-Worker (nested worker) の問題を回避できる。

const CONCURRENCY = 4;

export function useThumbnailPanel() {
  const { document, currentPageIndex } = usePecoStore();
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());

  // ファイル切り替えのたびにインクリメントし、requestThumbnail の参照を変えて
  // ThumbnailItemNode の useEffect を再発火させる（子エフェクト→親エフェクトの
  // 実行順序起因の Race Condition 対策）
  const [loadEpoch, setLoadEpoch] = useState(0);

  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);

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

        const filePath = usePecoStore.getState().document?.filePath;
        if (!filePath || epochRef.current !== epoch) break;

        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            try {
              const url = await generateThumbnail(filePath, pageIdx);
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
            } catch {
              // ファイル切り替え時に getCachedPageProxy がキャンセルエラーを投げる場合があるため無視
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
  }, []);

  // loadEpoch を deps に含めることで、ファイル切り替え後に requestThumbnail の参照が変わり
  // ThumbnailItemNode の onRequest dep が変化 → useEffect が再発火してキューに再追加される
  const requestThumbnail = useCallback((pageIndex: number) => {
    setThumbnails(prev => {
      if (prev.has(pageIndex)) return prev;
      if (!thumbnailQueueRef.current.includes(pageIndex)) {
        thumbnailQueueRef.current.push(pageIndex);
      }
      return prev;
    });
    const epoch = epochRef.current;
    setTimeout(() => processThumbnailQueue(epoch), 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processThumbnailQueue, loadEpoch]);

  // ファイル切り替え
  const prevFilePathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (document?.filePath === prevFilePathRef.current) return;
    prevFilePathRef.current = document?.filePath;

    epochRef.current++;
    thumbnailQueueRef.current = [];
    isProcessingRef.current = false;

    setThumbnails(prev => {
      prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
      return new Map();
    });
    // loadEpoch をインクリメントして requestThumbnail の参照を更新し、
    // 子コンポーネントの useEffect を再発火させる（Race Condition 解消）
    setLoadEpoch(prev => prev + 1);
  }, [document?.filePath]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    usePecoStore.getState().setCurrentPage(pageIndex);
  }, []);

  const fakeDocument = document
    ? { totalPages: document.totalPages, pages: document.pages }
    : null;

  return { thumbnails, loadEpoch, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument };
}
