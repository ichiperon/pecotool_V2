import { RefObject, useEffect, useRef, useState, MutableRefObject } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { getCachedPageProxy } from "../utils/pdfLoader";
import { getBitmapCache, setBitmapCache } from "../utils/bitmapCache";

interface UsePdfRenderingParams {
  pdfCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  filePath: string | undefined;
  totalPages: number | undefined;
  pageIndex: number;
  zoom: number;
  onFirstRender?: () => void;
  renderOverlaysRef: MutableRefObject<(() => void) | null>;
}

interface UsePdfRenderingResult {
  pdfPage: pdfjsLib.PDFPageProxy | null;
  loadError: boolean;
  setLoadError: (v: boolean) => void;
  retry: () => void;
}

// PDF main render + bitmapCache + viewport/page proxy 管理
export function usePdfRendering(params: UsePdfRenderingParams): UsePdfRenderingResult {
  const {
    pdfCanvasRef,
    overlayCanvasRef,
    wrapperRef,
    filePath,
    pageIndex,
    zoom,
    onFirstRender,
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
  useEffect(() => {
    // ファイルまたはページが切り替わった瞬間に古いプロキシを即座にクリア。
    // これにより破棄済み transport への render 呼び出しを防ぐ。
    setPdfPage(null);

    if (!filePath) {
      hasCalledFirstRenderRef.current = null;
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const page = await getCachedPageProxy(filePath, pageIndex);
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

  // PDFレンダリング
  useEffect(() => {
    if (!pdfPage || !pdfCanvasRef.current) return;

    const renderPdf = async () => {
      const canvas = pdfCanvasRef.current!;
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: false })!;

      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

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

      const cacheKey = `${pageIndex}:${zoom}`;
      const cached = getBitmapCache(cacheKey);
      if (cached && cached.width === w && cached.height === h) {
        context.drawImage(cached.bitmap, 0, 0);
        if (hasCalledFirstRenderRef.current !== filePath) {
          hasCalledFirstRenderRef.current = filePath ?? null;
          onFirstRender?.();
        }
        renderOverlaysRef.current?.();
        return;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, w, h);

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      };

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      if ((pdfPage as any)._transport?.destroyed) return;
      renderTaskRef.current = pdfPage.render(renderContext);

      try {
        await renderTaskRef.current.promise;
      } catch (err: any) {
        if (err.name === "RenderingCancelledException") return;
        if (err instanceof TypeError && err.message.includes("sendWithPromise")) return;
        console.error("PDF render error:", err);
        setLoadError(true);
        return;
      }

      if (hasCalledFirstRenderRef.current !== filePath) {
        hasCalledFirstRenderRef.current = filePath ?? null;
        onFirstRender?.();
      }

      try {
        const bitmap = await createImageBitmap(canvas);
        setBitmapCache(cacheKey, { bitmap, zoom, width: w, height: h });
      } catch {
        /* ビットマップ作成失敗は無視 */
      }

      renderOverlaysRef.current?.();
      // prefetch は pdfjs worker のタスクキューを占有して現在ページ描画を遅延させるため廃止
    };

    const isPageChange = prevPdfPageRef.current !== pdfPage;
    prevPdfPageRef.current = pdfPage;

    if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
    if (isPageChange) {
      renderPdf();
    } else {
      renderDebounceRef.current = setTimeout(() => {
        renderPdf();
      }, 30);
    }

    return () => {
      if (renderDebounceRef.current) clearTimeout(renderDebounceRef.current);
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
