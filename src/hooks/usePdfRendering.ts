import { RefObject, useEffect, useRef, useState, MutableRefObject } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { getCachedPageProxy } from "../utils/pdfLoader";
import { getBitmapCache, setBitmapCache } from "../utils/bitmapCache";
import { usePecoStore } from "../store/pecoStore";
import { perf } from "../utils/perfLogger";

interface UsePdfRenderingParams {
  pdfCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  // 静的層 (issue #90 で導入)。サイズ同期のために受け取り、optional とする
  // (既存呼び出しの後方互換と、テストでの省略を許容)。
  staticOverlayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  filePath: string | undefined;
  totalPages: number | undefined;
  pageIndex: number;
  documentEpoch?: number;
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

type RenderPageMeta = {
  filePath: string;
  pageIndex: number;
  documentEpoch: number;
};

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
    staticOverlayCanvasRef,
    wrapperRef,
    filePath,
    pageIndex,
    documentEpoch = 0,
    zoom,
    onFirstRender,
    onRenderComplete,
    renderOverlaysRef,
  } = params;

  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasCalledFirstRenderRef = useRef<string | null>(null);
  const prevPdfPageRef = useRef<pdfjsLib.PDFPageProxy | null>(null);
  const lastProxyRequestRef = useRef<{
    filePath: string;
    pageIndex: number;
    documentEpoch: number;
  } | null>(null);
  const [pdfPage, setPdfPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
  const [pdfPageMeta, setPdfPageMeta] = useState<RenderPageMeta | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // issue #94: 連続 zoom 変化 (ボタン連打 / Ctrl+wheel / fit-to-screen 切替) で
  // 30ms 以内に effect が再走したとき、cleanup で clearTimeout すると debounce が
  // 一度も発火せず render task が走らない window が発生する。一方 overlay 層は
  // RAF で即座に新 zoom 反映するため "画像 Canvas は古い zoom、BB overlay は新 zoom"
  // という乖離が起きる。対策:
  //   (1) 最新パラメータを ref に書き続け、debounce 中の effect 再実行では
  //       既存 timeout を破棄せずに温存。timeout 発火時に ref から最新値を読む。
  //   (2) effect 同期部で全 Canvas (pdfCanvas + 両 overlay + wrapper) のサイズを
  //       新 zoom の viewport 値に先取りで合わせる。これにより layer 間の
  //       size 乖離 window を 0 にする。
  //   (3) bitmapCache ヒット時は debounce を待たず同期 (同一フレーム) で
  //       描画まで完了させる。
  // 言葉: "mounted" は本コンポーネントがマウント中かどうかのフラグで、unmount 時
  // のみ false になる。effect 再走の cleanup では false にしない。
  const mountedRef = useRef(true);
  const latestParamsRef = useRef<{
    pdfPage: pdfjsLib.PDFPageProxy | null;
    renderMeta: RenderPageMeta | null;
    zoom: number;
  }>({ pdfPage: null, renderMeta: null, zoom });
  latestParamsRef.current = { pdfPage, renderMeta: pdfPageMeta, zoom };

  // PDFページの取得
  // ファイル or ページ切替時: 旧 pdfPage は即座にクリアせず、新ページ proxy の
  // 取得と render 完了を待って置換する（Canvas チラつき抑止）。
  useEffect(() => {
    if (!filePath) {
      hasCalledFirstRenderRef.current = null;
      // ファイル未選択時は即クリア (表示するものがないため)
      setPdfPage(null);
      setPdfPageMeta(null);
      setLoadError(false);
      return;
    }

    let cancelled = false;
    const previousProxyRequest = lastProxyRequestRef.current;
    const shouldBypassSharedProxy =
      previousProxyRequest?.filePath === filePath &&
      previousProxyRequest.pageIndex === pageIndex &&
      previousProxyRequest.documentEpoch !== documentEpoch;
    lastProxyRequestRef.current = { filePath, pageIndex, documentEpoch };

    (async () => {
      try {
        // 共有チャネル (store.currentPageProxy) が同じ filePath/pageIndex を
        // 指していれば二重 fetch を回避して即座に使う。
        const state = usePecoStore.getState();
        const expectedKey = `${filePath}:${pageIndex}`;
        let page: pdfjsLib.PDFPageProxy | null = null;
        if (!shouldBypassSharedProxy && state.currentPageProxyKey === expectedKey && state.currentPageProxy) {
          page = state.currentPageProxy;
        } else {
          page = await getCachedPageProxy(filePath, pageIndex);
        }
        if (cancelled) return;
        setLoadError(false);
        setPdfPageMeta({ filePath, pageIndex, documentEpoch });
        setPdfPage(page);
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.message.includes("file switched"))) {
          console.error("Error loading PDF page:", err);
          setPdfPage(null);
          setPdfPageMeta(null);
          setLoadError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, pageIndex, documentEpoch, retryCount]);

  // store.currentPageProxy の更新を subscribe: usePageNavigation が later に
  // proxy を publish したケース (未ロードページで effect 側が先行した場合など) に対応。
  useEffect(() => {
    if (!filePath) return;
    const expectedKey = `${filePath}:${pageIndex}`;
    const unsubscribe = usePecoStore.subscribe((state, prev) => {
      if (state.documentEpoch !== documentEpoch) return;
      if (state.currentPageProxy === prev.currentPageProxy) return;
      if (state.currentPageProxyKey !== expectedKey) return;
      if (!state.currentPageProxy) return;
      // 同じ proxy 参照なら skip
      setLoadError(false);
      setPdfPageMeta({ filePath, pageIndex, documentEpoch });
      setPdfPage((current) => current === state.currentPageProxy ? current : state.currentPageProxy);
    });
    return () => { unsubscribe(); };
  }, [filePath, pageIndex, documentEpoch]);

  // unmount 専用 cleanup: 残っている debounce / render task をここで破棄する。
  // effect 再走時の cleanup ではこれをしない (上記 issue #94 の (1))。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (renderDebounceRef.current) {
        clearTimeout(renderDebounceRef.current);
        renderDebounceRef.current = null;
      }
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, []);

  // PDFレンダリング
  useEffect(() => {
    if (!pdfPage || !pdfPageMeta || !pdfCanvasRef.current) return;

    // 同期サイズ同期 (issue #94 (2)): pdfCanvas + 両 overlay + wrapper を
    // 新 zoom の viewport サイズに先取りで合わせる。canvas.width/height への
    // 代入は canvas を白でクリアするので画像は一瞬空白になりうるが、後続の
    // render or bitmapCache 描画が同期 or 数フレーム以内に上書きするため、
    // 「BB overlay が新 zoom、画像が古い zoom サイズ」という乖離は起きない。
    const viewport = pdfPage.getViewport({ scale: zoom / 100 });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    const pdfCanvas = pdfCanvasRef.current;
    syncCanvasSizes({
      w,
      h,
      pdfCanvasRef,
      overlayCanvasRef,
      staticOverlayCanvasRef,
      wrapperRef,
    });

    // bitmapCache ヒット時は debounce を待たず同期で完了させる (issue #94 (3))。
    // 進行中の古い render があればキャンセルしてからキャッシュ画像を貼る。
    const cacheKey = renderCacheKey(pdfPageMeta, zoom);
    const cached = getBitmapCache(cacheKey);
    if (cached && cached.width === w && cached.height === h) {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      const context = pdfCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
      });
      if (context) {
        context.drawImage(cached.bitmap, 0, 0);
        if (perf.enabled) perf.mark('render.drawn', { page: pdfPageMeta.pageIndex, cacheHit: true });
      }
      if (hasCalledFirstRenderRef.current !== pdfPageMeta.filePath) {
        hasCalledFirstRenderRef.current = pdfPageMeta.filePath;
        onFirstRender?.();
      }
      renderOverlaysRef.current?.();
      if (perf.enabled) perf.mark('render.complete', { page: pdfPageMeta.pageIndex, cacheHit: true });
      onRenderComplete?.();
      // ページ切替時の prev 更新: cache hit でも次回判定に使うので忘れず更新。
      prevPdfPageRef.current = pdfPage;
      return;
    }

    // 注: cleanup では debounce timeout は破棄しない。timeout 発火時に
    // latestParamsRef を読んで最新 zoom/page を反映する (issue #94)。
    // 進行中の render task は new render 起動時 or unmount でのみ cancel する。

    const renderPdfTask = async () => {
      // ref から最新値を読む。debounce 中に zoom が連続変化したケースでも
      // 最後の値で 1 回だけ render する (coalesce)。
      const latest = latestParamsRef.current;
      const curPage = latest.pdfPage;
      const curMeta = latest.renderMeta;
      if (!curPage || !curMeta || !pdfCanvasRef.current) return;
      const curZoom = latest.zoom;

      const canvas = pdfCanvasRef.current;
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: false })!;

      const liveViewport = curPage.getViewport({ scale: curZoom / 100 });
      const lw = Math.floor(liveViewport.width);
      const lh = Math.floor(liveViewport.height);

      const liveCacheKey = renderCacheKey(curMeta, curZoom);
      const liveCached = getBitmapCache(liveCacheKey);
      if (liveCached && liveCached.width === lw && liveCached.height === lh) {
        // debounce 中にキャッシュが用意された (他経路) or 既に上の同期パスで
        // 描画済みの可能性。サイズだけ同期して即時描画。
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
        syncCanvasSizes({
          w: lw,
          h: lh,
          pdfCanvasRef,
          overlayCanvasRef,
          staticOverlayCanvasRef,
          wrapperRef,
        });
        context.drawImage(liveCached.bitmap, 0, 0);
        if (perf.enabled) perf.mark('render.drawn', { page: curMeta.pageIndex, cacheHit: true });
        if (hasCalledFirstRenderRef.current !== curMeta.filePath) {
          hasCalledFirstRenderRef.current = curMeta.filePath;
          onFirstRender?.();
        }
        renderOverlaysRef.current?.();
        if (perf.enabled) perf.mark('render.complete', { page: curMeta.pageIndex, cacheHit: true });
        onRenderComplete?.();
        return;
      }

      // キャッシュミス: オフスクリーンに描画してから on-screen に swap することで
      // 描画途中の「真っ白→じわっ」状態をユーザーに見せない。
      const offscreen = window.document.createElement("canvas");
      offscreen.width = lw;
      offscreen.height = lh;
      const offctx = offscreen.getContext("2d", { alpha: false, willReadFrequently: false })!;
      offctx.fillStyle = "#ffffff";
      offctx.fillRect(0, 0, lw, lh);

      try {
        const renderContext = {
          canvasContext: offctx,
          viewport: liveViewport,
          canvas: offscreen,
        };

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        if ((curPage as any)._transport?.destroyed) return;
        if (perf.enabled) perf.mark('render.start', { page: curMeta.pageIndex, zoom: curZoom, w: lw, h: lh });
        renderTaskRef.current = curPage.render(renderContext);

        try {
          await renderTaskRef.current.promise;
          if (perf.enabled) perf.mark('render.taskDone', { page: curMeta.pageIndex });
        } catch (err: any) {
          if (err.name === "RenderingCancelledException") return;
          if (err instanceof TypeError && err.message.includes("sendWithPromise")) return;
          console.error("PDF render error:", err);
          setLoadError(true);
          return;
        }

        // cleanup 済み (例: さらに新ページに切り替わった) なら on-screen に反映しない
        if (!mountedRef.current) return;
        // 直近 latestParams が更に変わっているならその差分を再描画させる
        // (effect の次回 run か、または既にスケジュールされた debounce が拾う)。
        const after = latestParamsRef.current;
        if (after.pdfPage !== curPage || after.renderMeta !== curMeta || after.zoom !== curZoom) {
          // 古い render 結果は捨てる。新しい parameter での render は次の effect run
          // / 既存 timeout の発火で改めて開始される。
          return;
        }

        // on-screen canvas にサイズ適用してオフスクリーンから一括コピー
        syncCanvasSizes({
          w: lw,
          h: lh,
          pdfCanvasRef,
          overlayCanvasRef,
          staticOverlayCanvasRef,
          wrapperRef,
        });
        context.drawImage(offscreen, 0, 0);
        if (perf.enabled) perf.mark('render.drawn', { page: curMeta.pageIndex });

        if (hasCalledFirstRenderRef.current !== curMeta.filePath) {
          hasCalledFirstRenderRef.current = curMeta.filePath;
          onFirstRender?.();
        }

        try {
          const bitmap = await createImageBitmap(offscreen);
          setBitmapCache(liveCacheKey, { bitmap, zoom: curZoom, width: lw, height: lh });
        } catch {
          /* ビットマップ作成失敗は無視 */
        }

        renderOverlaysRef.current?.();
        if (perf.enabled) perf.mark('render.complete', { page: curMeta.pageIndex, cacheHit: false });
        onRenderComplete?.();
        // prefetch は pdfjs worker のタスクキューを占有して現在ページ描画を遅延させるため廃止
      } finally {
        offscreen.width = 0;
        offscreen.height = 0;
      }
    };

    const isPageChange = prevPdfPageRef.current !== pdfPage;
    prevPdfPageRef.current = pdfPage;

    // ページ切替直後は isAutoFit 有効時に fitToScreen が ResizeObserver 経由で
    // 後続して zoom を確定させる (最大 ~50ms 程度)。この間に古い zoom で
    // render を開始すると pdfjs worker が無駄に占有され、確定 zoom の
    // render 開始が遅延する。そのため page 切替時は 50ms 待って zoom が
    // 確定してから 1 回だけ render する。
    //
    // 通常の zoom 操作 (wheel / button) も 30ms の短 debounce で連続入力を
    // 束ねて 1 回の render にする。
    //
    // issue #94: 既に timer が走っている場合は新規スケジュールしない。
    // timer は発火時に latestParamsRef から最新 zoom を読む。
    if (!renderDebounceRef.current) {
      const delay = isPageChange ? 50 : 30;
      renderDebounceRef.current = setTimeout(() => {
        renderDebounceRef.current = null;
        if (!mountedRef.current) return;
        renderPdfTask();
      }, delay);
    }

    // issue #94: effect 再走の cleanup では debounce を破棄しない。
    // 進行中の render task は新規 renderPdfTask 内で cancel する (latest と
    // 異なる zoom/page なら if (after.pdfPage !== curPage || ...) で
    // discard する) ため、ここでは何もしない。unmount 時の最終 cleanup は
    // mount-only effect が担う。
    return undefined;
  }, [pdfPage, pdfPageMeta, zoom]);

  return {
    pdfPage,
    loadError,
    setLoadError,
    retry: () => setRetryCount((c) => c + 1),
  };
}

function renderCacheKey(meta: RenderPageMeta, zoom: number): string {
  return `${meta.filePath}:${meta.pageIndex}:${meta.documentEpoch}:${zoom}`;
}

// 全 Canvas (pdfCanvas + overlay + 静的 overlay + wrapper) のサイズを
// 指定の viewport (w,h) に同期させる。
// issue #94: BB overlay と画像 Canvas のサイズ乖離 window を 0 にするため、
// effect 同期部 / cache hit / render 完了の各タイミングで呼び出す。
function syncCanvasSizes(opts: {
  w: number;
  h: number;
  pdfCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  staticOverlayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
}) {
  const { w, h, pdfCanvasRef, overlayCanvasRef, staticOverlayCanvasRef, wrapperRef } = opts;
  const pdfCanvas = pdfCanvasRef.current;
  if (pdfCanvas) {
    if (pdfCanvas.width !== w) pdfCanvas.width = w;
    if (pdfCanvas.height !== h) pdfCanvas.height = h;
    pdfCanvas.style.width = `${w}px`;
    pdfCanvas.style.height = `${h}px`;
    pdfCanvas.style.display = "block";
  }
  const overlay = overlayCanvasRef.current;
  if (overlay) {
    if (overlay.width !== w) overlay.width = w;
    if (overlay.height !== h) overlay.height = h;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
  }
  const staticOverlay = staticOverlayCanvasRef?.current;
  if (staticOverlay) {
    if (staticOverlay.width !== w) staticOverlay.width = w;
    if (staticOverlay.height !== h) staticOverlay.height = h;
    staticOverlay.style.width = `${w}px`;
    staticOverlay.style.height = `${h}px`;
  }
  const wrapper = wrapperRef.current;
  if (wrapper) {
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
  }
}
