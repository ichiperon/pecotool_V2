import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FC,
  type KeyboardEvent,
} from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { usePdfStore } from "../store/pdfStore";
import { effectiveRotation } from "../logic/rotateTemplate";
import { useReportStore } from "../store/reportStore";
import OffsetAdjustOverlay from "./OffsetAdjustOverlay";
import type { OverlayGeom } from "../types/overlay";
import { computeFitZoom } from "../lib/fitZoom";
import { usePdfShortcuts } from "../hooks/usePdfShortcuts";
import { usePdfPanZoom } from "../hooks/usePdfPanZoom";

// workerSrc の設定（PdfViewer と同パターン）
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;
}

const ZOOM_STEP = 25;

interface Props {
  runOcrForPage: (pageNum: number) => Promise<void>;
  reocrTarget: number | null;
  /** 直前の再OCRが失敗したかどうか（失敗時にインラインエラーを表示） */
  reocrError: boolean;
  onReocrRetry: () => void;
}

/**
 * 確認画面（ステップ3）の左カラム。
 *
 * - PdfViewer の canvas 描画を再利用（pdfDoc を独自管理）
 * - OffsetAdjustOverlay でオフセット調整オーバーレイを表示
 * - 上部ツールバーに「欄をずらす」トグル・Δバッジ・再OCRボタン
 */
const ConfirmPdfPane: FC<Props> = ({ runOcrForPage, reocrTarget, reocrError, onReocrRetry }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);
  const loadGenRef = useRef<number>(0);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [overlayGeom, setOverlayGeom] = useState<OverlayGeom | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);

  const {
    filePath,
    numPages,
    currentPage,
    zoom,
    fitMode,
    isLoading,
    error,
    setCurrentPage,
    setZoom,
    setFitMode,
    goToPrevPage,
    goToNextPage,
    rotation,
  } = usePdfStore();

  const mode = useReportStore((s) => s.mode);
  const pageOffsets = useReportStore((s) => s.pageOffsets);
  const setMode = useReportStore((s) => s.setMode);
  const clearPageOffset = useReportStore((s) => s.clearPageOffset);

  const isAdjusting = mode === "adjustOffset";
  const currentOffset = pageOffsets.get(currentPage) ?? { dx: 0, dy: 0 };
  const hasOffset = currentOffset.dx !== 0 || currentOffset.dy !== 0;
  const isReocrRunning = reocrTarget === currentPage;

  // pdfDoc を filePath から自動ロード（ConfirmPdfPane は独自に pdfDoc を管理する）
  // PdfViewer とは別の pdfDoc インスタンス（表示専用）
  useEffect(() => {
    if (!filePath) {
      setPdfDoc(null);
      return;
    }

    const currentGen = ++loadGenRef.current;

    (async () => {
      try {
        const bytes = await readFile(filePath);
        if (loadGenRef.current !== currentGen) return;

        const loadingTask = pdfjsLib.getDocument({ data: bytes });
        const newDoc = await loadingTask.promise;

        if (loadGenRef.current !== currentGen) {
          newDoc.destroy().catch(() => {});
          return;
        }

        setPdfDoc(newDoc);
      } catch (e) {
        console.error("[ConfirmPdfPane] PDF ロードエラー:", e);
      }
    })();

    return () => {
      loadGenRef.current++;
    };
  }, [filePath]);

  // pdfDoc のクリーンアップ
  useEffect(() => {
    return () => {
      if (pdfDoc) {
        pdfDoc.destroy().catch(() => {});
      }
    };
  }, [pdfDoc]);

  // currentPage を pageInput に追従
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // canvas に現在ページを描画
  useEffect(() => {
    if (!filePath || !pdfDoc) return;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    let cancelled = false;

    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      let page: PDFPageProxy | null = null;
      try {
        page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;

        // scale:1 のページサイズを取得し、フィット計算に使う
        // ページ固有 /Rotate にユーザー回転を加算合成（PdfViewer・OCR と同一ソース）
        const effRotation = effectiveRotation(page.rotate ?? 0, rotation);
        const base = page.getViewport({ scale: 1, rotation: effRotation });
        setPageSize((prev) => {
          if (prev && prev.width === base.width && prev.height === base.height) {
            return prev; // 同値なら更新しない（無限ループ防止）
          }
          return { width: base.width, height: base.height };
        });

        const scale = zoom / 100;
        const devicePixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({
          scale: scale * devicePixelRatio,
          rotation: effRotation,
        });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / devicePixelRatio}px`;
        canvas.style.height = `${viewport.height / devicePixelRatio}px`;

        setOverlayGeom({
          deviceWidth: viewport.width,
          deviceHeight: viewport.height,
          dpr: devicePixelRatio,
          zoom,
        });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const renderTask = page.render({ canvas, viewport });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;
      } catch (e: unknown) {
        if (cancelled) return;
        if (
          e instanceof Error &&
          (e.message === "Rendering cancelled" ||
            e.name === "RenderingCancelledException")
        ) {
          return;
        }
        console.error("[ConfirmPdfPane] ページ描画エラー:", e);
      } finally {
        try {
          page?.cleanup();
        } catch {
          // ignore
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [filePath, pdfDoc, currentPage, zoom, rotation]);

  // ResizeObserver でコンテナサイズを監視し、fitMode に応じてズームを自動調整する
  useEffect(() => {
    const container = canvasAreaRef.current;
    // ResizeObserver 非対応環境（jsdom 等）ではスキップ
    if (!container || typeof ResizeObserver === "undefined") return;
    if (!pageSize) return;

    const applyFit = () => {
      if (fitMode === "custom") return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const newZoom = computeFitZoom({
        fitMode,
        containerWidth: w,
        containerHeight: h,
        pageWidth: pageSize.width,
        pageHeight: pageSize.height,
      });
      // jsdomガード: 0 は「適用しない」サイン
      if (newZoom === 0) return;
      if (newZoom !== usePdfStore.getState().zoom) {
        setZoom(newZoom);
      }
    };

    applyFit();

    const observer = new ResizeObserver(() => {
      applyFit();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [fitMode, pageSize, currentPage, setZoom]);

  const handlePageInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value);
  };

  const handlePageInputCommit = () => {
    const parsed = parseInt(pageInput, 10);
    if (!Number.isNaN(parsed)) {
      setCurrentPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handlePageInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // IME 変換中/変換確定の Enter・Escape はページ移動の commit/reset に渡さない
    // （CsvPreviewTable と同パターン・#65 / c4d01d0 参照。keyCode 229 は isComposing
    // が false で届く IME 確定キーの互換フォールバック）。
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") {
      handlePageInputCommit();
    } else if (e.key === "Escape") {
      setPageInput(String(currentPage));
    }
  };

  const handleZoomIn = () => {
    setZoom(zoom + ZOOM_STEP);
    setFitMode("custom");
  };

  const handleZoomOut = () => {
    setZoom(zoom - ZOOM_STEP);
    setFitMode("custom");
  };

  const handleToggleAdjust = () => {
    if (isAdjusting) {
      setMode("idle");
    } else {
      setMode("adjustOffset");
    }
  };

  const handleResetOffset = () => {
    clearPageOffset(currentPage);
  };

  const handleReocrClick = () => {
    void runOcrForPage(currentPage);
  };

  // キーボードショートカットの登録
  usePdfShortcuts();
  // パン（スペース+ドラッグ）と Ctrl+ホイールズームの登録
  usePdfPanZoom(canvasAreaRef);

  if (!filePath && !isLoading && !error) {
    return (
      <div className="confirm-pdf-pane confirm-pdf-pane--empty">
        <p>PDF が読み込まれていません</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="confirm-pdf-pane" aria-live="polite" aria-busy="true">
        <p>PDF を読み込んでいます...</p>
      </div>
    );
  }

  return (
    <div className="confirm-pdf-pane">
      {/* ツールバー */}
      <div className="confirm-pdf-pane__toolbar" role="toolbar" aria-label="確認ビューアツールバー">
        {/* ページナビゲーション */}
        <button
          type="button"
          className="pdf-viewer__nav-btn"
          onClick={goToPrevPage}
          disabled={currentPage <= 1}
          aria-label="前のページ"
        >
          &lt;
        </button>
        <div className="pdf-viewer__page-indicator">
          <input
            type="text"
            inputMode="numeric"
            className="pdf-viewer__page-input"
            value={pageInput}
            onChange={handlePageInputChange}
            onBlur={handlePageInputCommit}
            onKeyDown={handlePageInputKeyDown}
            aria-label="現在のページ番号"
          />
          <span className="pdf-viewer__page-total">/ {numPages}</span>
        </div>
        <button
          type="button"
          className="pdf-viewer__nav-btn"
          onClick={goToNextPage}
          disabled={currentPage >= numPages}
          aria-label="次のページ"
        >
          &gt;
        </button>

        <div className="pdf-viewer__divider" aria-hidden="true" />

        {/* ズーム */}
        <button
          type="button"
          className="pdf-viewer__zoom-btn"
          onClick={handleZoomOut}
          disabled={zoom <= 25}
          aria-label="縮小"
        >
          −
        </button>
        <span className="pdf-viewer__zoom-label" aria-label={`ズーム: ${zoom}%`}>
          {zoom}%
        </span>
        <button
          type="button"
          className="pdf-viewer__zoom-btn"
          onClick={handleZoomIn}
          disabled={zoom >= 400}
          aria-label="拡大"
        >
          ＋
        </button>

        <div className="pdf-viewer__divider" aria-hidden="true" />

        {/* フィットモードボタン */}
        <button
          type="button"
          className={`pdf-viewer__fit-btn${fitMode === "width" ? " pdf-viewer__fit-btn--active" : ""}`}
          onClick={() => setFitMode("width")}
          aria-pressed={fitMode === "width" ? ("true" as const) : ("false" as const)}
          aria-label="幅に合わせる"
        >
          幅
        </button>
        <button
          type="button"
          className={`pdf-viewer__fit-btn${fitMode === "page" ? " pdf-viewer__fit-btn--active" : ""}`}
          onClick={() => setFitMode("page")}
          aria-pressed={fitMode === "page" ? ("true" as const) : ("false" as const)}
          aria-label="全体表示"
        >
          全体
        </button>

        <div className="pdf-viewer__divider" aria-hidden="true" />

        {/* 欄をずらすトグル */}
        <button
          type="button"
          className={`confirm-pdf-pane__adjust-btn${isAdjusting ? " confirm-pdf-pane__adjust-btn--active" : ""}`}
          onClick={handleToggleAdjust}
          aria-pressed={isAdjusting ? ("true" as const) : ("false" as const)}
          title="欄をずらす（オフセット調整）"
        >
          欄をずらす
        </button>
      </div>

      {/* オフセット調整ヒント帯 */}
      {isAdjusting && (
        <div className="confirm-pdf-pane__adjust-hint" role="status">
          オーバーレイをドラッグまたは矢印キー（±1px）/ Shift+矢印（±10px）で欄をずらします
        </div>
      )}

      {/* Δオフセットバッジ行 */}
      <div className="confirm-pdf-pane__offset-row">
        <span
          className={`confirm-pdf-pane__offset-badge${hasOffset ? " confirm-pdf-pane__offset-badge--active" : ""}`}
          aria-label={`ページオフセット: x ${currentOffset.dx}px, y ${currentOffset.dy}px`}
        >
          {hasOffset
            ? `Δ x:${currentOffset.dx >= 0 ? "+" : ""}${currentOffset.dx} y:${currentOffset.dy >= 0 ? "+" : ""}${currentOffset.dy} px`
            : "Δ なし"}
        </span>
        {hasOffset && (
          <button
            type="button"
            className="confirm-pdf-pane__reset-btn"
            onClick={handleResetOffset}
            aria-label="このページのオフセットをリセット"
          >
            リセット
          </button>
        )}

        <div className="confirm-pdf-pane__offset-spacer" />

        {/* 再OCRボタン */}
        <button
          type="button"
          className={`confirm-pdf-pane__reocr-btn${hasOffset && !isReocrRunning ? " confirm-pdf-pane__reocr-btn--needs-reocr" : ""}`}
          onClick={handleReocrClick}
          disabled={isReocrRunning}
          aria-label={`${currentPage}ページ目を再OCR`}
        >
          {isReocrRunning ? "再OCR中..." : "このページを再OCR"}
        </button>
      </div>

      {/* 再OCRエラー表示 */}
      {reocrError && (
        <div className="confirm-pdf-pane__reocr-error" role="alert">
          再OCRに失敗しました
          <button
            type="button"
            className="confirm-pdf-pane__reocr-retry-btn"
            onClick={onReocrRetry}
          >
            再試行
          </button>
        </div>
      )}

      {/* Canvas エリア */}
      <div className="pdf-viewer__canvas-area" ref={canvasAreaRef}>
        <div className="pdf-viewer__canvas-wrapper">
          <canvas
            ref={canvasRef}
            className="pdf-viewer__canvas"
            aria-label={`PDF ページ ${currentPage}`}
          />
          <OffsetAdjustOverlay geom={overlayGeom} />
        </div>
      </div>

      {/* aria-live: 再OCR完了通知 */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="confirm-pdf-pane-live"
      />
    </div>
  );
};

export default ConfirmPdfPane;
