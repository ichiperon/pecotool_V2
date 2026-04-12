import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { generateThumbnail, destroySharedPdfProxy } from '../../utils/pdfLoader';
import { ThumbnailPanel } from '../Sidebar/ThumbnailPanel';

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

  // --- Thumbnail generation ---
  const thumbnailQueueRef = useRef<number[]>([]);
  const isProcessingRef = useRef(false);
  const epochRef = useRef(0);
  const CONCURRENCY = 4;

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
              // 空文字列の場合は保存しない（toBlob失敗 → リトライ可能にするため）
              if (url && epochRef.current === epoch) {
                setThumbnails(prev => {
                  const next = new Map(prev);
                  next.set(pageIdx, url);
                  return next;
                });
              }
            } catch {
              // エラーは握りつぶし、次回のリクエストでリトライ可能にする
            }
          })
        );
      }
    } finally {
      isProcessingRef.current = false;
      if (thumbnailQueueRef.current.length > 0 && filePath) {
        setTimeout(() => processThumbnailQueue(fp, epoch), 0);
      }
    }
  }, [filePath]);

  const requestThumbnail = useCallback((pageIndex: number) => {
    if (!filePath) return;
    setThumbnails(prev => {
      if (prev.has(pageIndex)) return prev;
      if (!thumbnailQueueRef.current.includes(pageIndex)) {
        thumbnailQueueRef.current.push(pageIndex);
      }
      const fp = filePath;
      const epoch = epochRef.current;
      setTimeout(() => processThumbnailQueue(fp, epoch), 0);
      return prev;
    });
  }, [filePath, processThumbnailQueue]);

  // --- Event listeners ---
  // 全リスナー登録完了後にrequest-stateを投げる（登録前に投げると応答イベントを取り逃す）
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      // ファイルが開かれた
      unlisteners.push(await listen<ThumbnailFileOpenedPayload>('thumbnail:file-opened', (e) => {
        const { filePath: fp, currentPageIndex: page, totalPages: total, dirtyPages: dirty } = e.payload;
        epochRef.current++;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;
        destroySharedPdfProxy();
        setThumbnails(prev => {
          prev.forEach(url => { if (url) URL.revokeObjectURL(url); });
          return new Map();
        });
        setFilePath(fp);
        setTotalPages(total);
        setCurrentPageIndex(page);
        setDirtyPages(new Set(dirty));
      }));

      // ファイルが閉じられた
      unlisteners.push(await listen('thumbnail:file-closed', () => {
        epochRef.current++;
        thumbnailQueueRef.current = [];
        isProcessingRef.current = false;
        destroySharedPdfProxy();
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

      // 全リスナー登録完了後に現在状態を要求（ウィンドウ表示が遅延した場合の同期）
      await emit('thumbnail:request-state');
    };

    setup().catch(console.error);
    return () => { unlisteners.forEach(fn => fn()); };
  }, []);

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
