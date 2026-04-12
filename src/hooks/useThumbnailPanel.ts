import { useState, useRef, useCallback, useEffect } from 'react';
import { generateThumbnail } from '../utils/pdfLoader';
import { usePecoStore } from '../store/pecoStore';

const CONCURRENCY = 4;

export function useThumbnailPanel() {
  const { document, currentPageIndex } = usePecoStore();
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());

  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);

  const processThumbnailQueue = useCallback(async (fp: string, epoch: number) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    try {
      while (thumbnailQueueRef.current.length > 0) {
        const batch: number[] = [];
        while (batch.length < CONCURRENCY && thumbnailQueueRef.current.length > 0) {
          batch.push(thumbnailQueueRef.current.shift()!);
        }
        if (batch.length === 0) continue;
        await Promise.allSettled(
          batch.map(async (pageIdx) => {
            try {
              const url = await generateThumbnail(fp, pageIdx);
              if (url && epochRef.current === epoch) {
                setThumbnails(prev => {
                  const next = new Map(prev);
                  next.set(pageIdx, url);
                  return next;
                });
              }
            } catch {
              // ignore, retryable on next request
            }
          })
        );
      }
    } finally {
      isProcessingRef.current = false;
      if (thumbnailQueueRef.current.length > 0) {
        setTimeout(() => processThumbnailQueue(fp, epoch), 0);
      }
    }
  }, []);

  const requestThumbnail = useCallback((pageIndex: number) => {
    const fp = usePecoStore.getState().document?.filePath;
    if (!fp) return;
    setThumbnails(prev => {
      if (prev.has(pageIndex)) return prev;
      if (!thumbnailQueueRef.current.includes(pageIndex)) {
        thumbnailQueueRef.current.push(pageIndex);
      }
      const epoch = epochRef.current;
      setTimeout(() => processThumbnailQueue(fp, epoch), 0);
      return prev;
    });
  }, [processThumbnailQueue]);

  // ファイルが切り替わったらサムネイルキャッシュをリセット
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
  }, [document?.filePath]);

  const handleSelectPage = useCallback((pageIndex: number) => {
    usePecoStore.getState().setCurrentPage(pageIndex);
  }, []);

  const fakeDocument = document
    ? { totalPages: document.totalPages, pages: document.pages }
    : null;

  return { thumbnails, requestThumbnail, handleSelectPage, currentPageIndex, fakeDocument };
}
