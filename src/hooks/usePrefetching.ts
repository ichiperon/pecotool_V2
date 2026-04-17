import { useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { getCachedPageProxy } from "../utils/pdfLoader";
import { getBitmapCache, setBitmapCache } from "../utils/bitmapCache";

// ±1,±2ページのビットマップを OffscreenCanvas で事前描画（キャンセル/タイムアウト付き）
export function usePrefetching() {
  const prefetchTasksRef = useRef<
    Array<{
      task: pdfjsLib.RenderTask;
      cancelled: boolean;
      timeoutId: ReturnType<typeof setTimeout> | null;
    }>
  >([]);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchIdleHandleRef = useRef<number | null>(null);

  const cancelAll = () => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
    if (
      prefetchIdleHandleRef.current !== null &&
      typeof (window as any).cancelIdleCallback === "function"
    ) {
      (window as any).cancelIdleCallback(prefetchIdleHandleRef.current);
      prefetchIdleHandleRef.current = null;
    }
    for (const wrapper of prefetchTasksRef.current) {
      wrapper.cancelled = true;
      if (wrapper.timeoutId !== null) clearTimeout(wrapper.timeoutId);
      try {
        wrapper.task.cancel();
      } catch {
        /* ignore */
      }
    }
    prefetchTasksRef.current = [];
  };

  const schedule = (params: {
    filePath: string | undefined;
    totalPages: number | undefined;
    pageIndex: number;
    zoom: number;
    isCancelled: () => boolean;
  }) => {
    if (typeof OffscreenCanvas === "undefined") return;
    if (!params.filePath) return;
    const filePath = params.filePath;
    const capturedPageIndex = params.pageIndex;
    const capturedZoom = params.zoom;
    const totalPages = params.totalPages;

    const runPrefetch = async () => {
      const offsets = [1, -1, 2, -2];
      for (const offset of offsets) {
        if (params.isCancelled()) return;
        const targetPageIndex = capturedPageIndex + offset;
        if (targetPageIndex < 0) continue;
        if (totalPages && targetPageIndex >= totalPages) continue;

        const key = `${targetPageIndex}:${capturedZoom}`;
        if (getBitmapCache(key)) continue;

        try {
          const page = await getCachedPageProxy(filePath, targetPageIndex);
          if (params.isCancelled()) return;
          if ((page as any)._transport?.destroyed) return;

          const viewport = page.getViewport({ scale: capturedZoom / 100 });
          const tw = Math.floor(viewport.width);
          const th = Math.floor(viewport.height);
          let off: OffscreenCanvas | null = new OffscreenCanvas(tw, th);
          let offCtx: OffscreenCanvasRenderingContext2D | null = off.getContext("2d", { alpha: false });
          if (!offCtx) continue;
          offCtx.fillStyle = "#ffffff";
          offCtx.fillRect(0, 0, tw, th);

          const task = page.render({
            canvasContext: offCtx as any,
            viewport,
            canvas: off as any,
          });
          const wrapper: {
            task: pdfjsLib.RenderTask;
            cancelled: boolean;
            timeoutId: ReturnType<typeof setTimeout> | null;
          } = {
            task,
            cancelled: false,
            timeoutId: null,
          };
          prefetchTasksRef.current.push(wrapper);

          // 3秒でタイムアウト: OffscreenCanvas内部処理がハングした場合の強制解放
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            wrapper.timeoutId = setTimeout(() => resolve("timeout"), 3000);
          });

          let timedOut = false;
          try {
            const result = await Promise.race([
              task.promise
                .then(() => "done" as const)
                .catch((e) => {
                  throw e;
                }),
              timeoutPromise,
            ]);
            if (result === "timeout") {
              timedOut = true;
              wrapper.cancelled = true;
              try {
                task.cancel();
              } catch {
                /* ignore */
              }
              // OffscreenCanvas / 2D context への参照を落として GC を促す
              offCtx = null;
              off = null;
            }
          } catch {
            if (wrapper.timeoutId !== null) clearTimeout(wrapper.timeoutId);
            prefetchTasksRef.current = prefetchTasksRef.current.filter(
              (w) => w !== wrapper
            );
            if (params.isCancelled() || wrapper.cancelled) return;
            continue;
          }

          if (wrapper.timeoutId !== null) clearTimeout(wrapper.timeoutId);
          prefetchTasksRef.current = prefetchTasksRef.current.filter(
            (w) => w !== wrapper
          );

          if (params.isCancelled() || wrapper.cancelled) return;
          if (timedOut) continue;
          if (getBitmapCache(key)) continue;

          try {
            const bitmap = off!.transferToImageBitmap();
            setBitmapCache(key, {
              bitmap,
              zoom: capturedZoom,
              width: tw,
              height: th,
            });
          } catch {
            /* ignore */
          }
        } catch {
          if (params.isCancelled()) return;
        }
      }
    };

    // 既存のプリフェッチ予約をクリア
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
    if (
      prefetchIdleHandleRef.current !== null &&
      typeof (window as any).cancelIdleCallback === "function"
    ) {
      (window as any).cancelIdleCallback(prefetchIdleHandleRef.current);
      prefetchIdleHandleRef.current = null;
    }

    // ページ送り即応性を重視し、現在ページ描画完了直後に即時起動する。
    queueMicrotask(() => {
      runPrefetch();
    });
  };

  // unmount 検知: consumer が cancelAll を忘れても残存タスクを確実にキャンセル
  useEffect(() => {
    return () => {
      cancelAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { schedule, cancelAll };
}
