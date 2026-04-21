import { RefObject, useEffect, useRef, useState, MutableRefObject } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { getCachedPageProxy } from "../utils/pdfLoader";
import { getBitmapCache, setBitmapCache } from "../utils/bitmapCache";
import { usePecoStore } from "../store/pecoStore";
import { perf } from "../utils/perfLogger";

interface UsePdfRenderingParams {
  pdfCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  filePath: string | undefined;
  totalPages: number | undefined;
  pageIndex: number;
  zoom: number;
  onFirstRender?: () => void;
  /**
   * 実 render() が完了したタイミングで呼ばれる。
   * usePageNavigation の isLoadingPageRender を false にするのに使う。
   * bitmapCache ヒット時も同様に完了扱いで呼ばれる。
   */
  onRenderComplete?: () => void;
  renderOverlaysRef: MutableRefObject<(() => void) | null>;
}

interface UsePdfRenderingResult {
  pdfPage: pdfjsLib.PDFPageProxy | null;
  loadError: boolean;
  setLoadError: (v: boolean) => void;
  retry: () => void;
}

// PDF main render + bitmapCache + viewport/page proxy 管理
//
// チラつき対策方針:
//  - ファイル/ページ切替時に setPdfPage(null) しない。
//  - 新ページ proxy を取得 → render 完了 → setPdfPage(new) + canvas swap という順序を守る。
//  - 旧 render はこの effect の cleanup で cancel する (race 防止)。
//  - proxy 取得は store の currentPageProxy を優先的に共有して二重 fetch を回避。
export function usePdfRendering(params: UsePdfRenderingParams): UsePdfRenderingResult {
  const {
    pdfCanvasRef,
    overlayCanvasRef,
    wrapperRef,
    filePath,
    pageIndex,
    zoom,
    onFirstRender,
    onRenderComplete,
    renderOverlaysRef,
  } = params;

  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasCalledFirstRenderRef = useRef<string | null>(null);
  const prevPdfPageRef = useRef<pdfjsLib.PDFPageProxy | null>(null);
  const [pdfPage, setPdfPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // PDFページの取得
  // ファイル or ページ切替時: 旧 pdfPage は即座にクリアせず、新ページ proxy の
  // 取得と render 完了を待って置換する（Canvas チラつき抑止）。
  useEffect(() => {
    if (!filePath) {
      hasCalledFirstRenderRef.current = null;
      // ファイル未選択時は即クリア (表示するものがないため)
      setPdfPage(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // 共有チャネル (store.currentPageProxy) が同じ filePath/pageIndex を
        // 指していれば二重 fetch を回避して即座に使う。
        const state = usePecoStore.getState();
        const expectedKey = `${filePath}:${pageIndex}`;
        let page: pdfjsLib.PDFPageProxy | null = null;
        if (state.currentPageProxyKey === expectedKey && state.currentPageProxy) {
          page = state.currentPageProxy;
        } else {
          page = await getCachedPageProxy(filePath, pageIndex);
        }
        if (cancelled) return;
        setPdfPage(page);
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.message.includes("file switched"))) {
          console.error("Error loading PDF page:", err);
          setLoadError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, pageIndex, retryCount]);

  // store.currentPageProxy の更新を subscribe: usePageNavigation が later に
  // proxy を publish したケース (未ロードページで effect 側が先行した場合など) に対応。
  useEffect(() => {
    if (!filePath) return;
    const expectedKey = `${filePath}:${pageIndex}`;
    const unsubscribe = usePecoStore.subscribe((state, prev) => {
      if (state.currentPageProxy === prev.currentPageProxy) return;
      if (state.currentPageProxyKey !== expectedKey) return;
      if (!state.currentPageProxy) return;
      // 同じ proxy 参照なら skip
      setPdfPage((current) => current === state.currentPageProxy ? current : state.currentPageProxy);
    });
    return () => { unsubscribe(); };
  }, [filePath, pageIndex]);

  // PDFレンダリング
  useEffect(() => {
    if (!pdfPage || !pdfCanvasRef.current) return;

    // この render 試行がアクティブかどうかのフラグ。cleanup で false になる。
    let active = true;

    const renderPdf = async () => {
      const canvas = pdfCanvasRef.current!;
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: false })!;

      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

      const cacheKey = `${pageIndex}:${zoom}`;
      const cached = getBitmapCache(cacheKey);
      if (cached && cached.width === w && cached.height === h) {
        // キャッシュヒット: 進行中の古い render があればキャンセルしてから
        // サイズ適用 + 即時描画することでチラつきゼロで差し替える。
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
        canvas.width = w;
        canvas.height = h;
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.width = w;
          overlayCanvasRef.current.height = h;
        }
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        canvas.style.display = "block";
        if (overlayCanvasRef.current) {
          overlayCanvasRef.current.style.width = `${w}px`;
          overlayCanvasRef.current.style.height = `${h}px`;
        }
        if (wrapperRef.current) {
          wrapperRef.current.style.width = `${w}px`;
          wrapperRef.current.style.height = `${h}px`;
        }
        context.drawImage(cached.bitmap, 0, 0);
        perf.mark('render.drawn', { page: pageIndex, cacheHit: true });
        if (hasCalledFirstRenderRef.current !== filePath) {
          hasCalledFirstRenderRef.current = filePath ?? null;
          onFirstRender?.();
        }
        renderOverlaysRef.current?.();
        perf.mark('render.complete', { page: pageIndex, cacheHit: true });
        onRenderComplete?.();
        return;
      }

      // キャッシュミス: オフスクリーンに描画してから on-screen に swap することで
      // 描画途中の「真っ白→じわっ」状態をユーザーに見せない。
      const offscreen = window.document.createElement("canvas");
      offscreen.width = w;
      offscreen.height = h;
      const offctx = offscreen.getContext("2d", { alpha: false, willReadFrequently: false })!;
      offctx.fillStyle = "#ffffff";
      offctx.fillRect(0, 0, w, h);

      const renderContext = {
        canvasContext: offctx,
        viewport: viewport,
        canvas: offscreen,
      };

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      if ((pdfPage as any)._transport?.destroyed) return;
      perf.mark('render.start', { page: pageIndex, zoom, w, h });
      renderTaskRef.current = pdfPage.render(renderContext);

      try {
        await renderTaskRef.current.promise;
        perf.mark('render.taskDone', { page: pageIndex });
      } catch (err: any) {
        if (err.name === "RenderingCancelledException") return;
        if (err instanceof TypeError && err.message.includes("sendWithPromise")) return;
        console.error("PDF render error:", err);
        setLoadError(true);
        return;
      }

      // cleanup 済み (例: さらに新ページに切り替わった) なら on-screen に反映しない
      if (!active) return;

      // on-screen canvas にサイズ適用してオフスクリーンから一括コピー
      canvas.width = w;
      canvas.height = h;
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = w;
        overlayCanvasRef.current.height = h;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.display = "block";
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.style.width = `${w}px`;
        overlayCanvasRef.current.style.height = `${h}px`;
      }
      if (wrapperRef.current) {
        wrapperRef.current.style.width = `${w}px`;
        wrapperRef.current.style.height = `${h}px`;
      }
      context.drawImage(offscreen, 0, 0);
      perf.mark('render.drawn', { page: pageIndex });

      if (hasCalledFirstRenderRef.current !== filePath) {
        hasCalledFirstRenderRef.current = filePath ?? null;
        onFirstRender?.();
      }

      try {
        const bitmap = await createImageBitmap(offscreen);
        setBitmapCache(cacheKey, { bitmap, zoom, width: w, height: h });
      } catch {
        /* ビットマップ作成失敗は無視 */
      }

      renderOverlaysRef.current?.();
      perf.mark('render.complete', { page: pageIndex, cacheHit: false });
      onRenderComplete?.();
      // prefetch は pdfjs worker のタスクキューを占有して現在ページ描画を遅延させるため廃止
    };

    const isPageChange = prevPdfPageRef.current !== pdfPage;
    prevPdfPageRef.current = pdfPage;

    // ページ切替直後は isAutoFit 有効時に fitToScreen が ResizeObserver 経由で
    // 後続して zoom を確定させる (最大 ~50ms 程度)。この間に古い zoom で
    // render を開始すると pdfjs worker が無駄に占有され、確定 zoom の
    // render 開始が遅延する。そのため page 切替時は 50ms 待って zoom が
    // 確定してから 1 回だけ render する (50ms 以内に zoom が再変更されたら
    // 新しい zoom で再スタートする: effect の再実行がそれを担う)。
    //
    // 通常の zoom 操作 (wheel / button) も 30ms の短 debounce で連続入力を
    // 束ねて 1 回の render にする。
    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    const delay = isPageChange ? 50 : 30;
    renderDebounceRef.current = setTimeout(() => {
      renderDebounceRef.current = null;
      if (!active) return;
      renderPdf();
    }, delay);

    return () => {
      active = false;
      if (renderDebounceRef.current) {
        clearTimeout(renderDebounceRef.current);
        renderDebounceRef.current = null;
      }
      renderTaskRef.current?.cancel();
    };
  }, [pdfPage, zoom]);

  return {
    pdfPage,
    loadError,
    setLoadError,
    retry: () => setRetryCount((c) => c + 1),
  };
}
