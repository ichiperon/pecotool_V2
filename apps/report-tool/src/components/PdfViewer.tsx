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
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { usePdfStore } from "../store/pdfStore";
import { useReportStore } from "../store/reportStore";
import FieldOverlayCanvas from "./FieldOverlayCanvas";
import type { OverlayGeom } from "../types/overlay";
import { computeFitZoom } from "../lib/fitZoom";
import { usePdfShortcuts } from "../hooks/usePdfShortcuts";
import { effectiveRotation } from "../logic/rotateTemplate";
import { usePdfPanZoom } from "../hooks/usePdfPanZoom";

// workerSrc の設定（本体 pdfLoader.ts と同じ ?url import パターン）
// Vite が .mjs を URL として解決する。
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;
}

const ZOOM_STEP = 25;

/**
 * PdfViewer
 *
 * 中央ペインに現在ページを canvas 描画する。
 * 段階3でオーバーレイ層（欄定義矩形）を canvas の上に絶対配置する想定のため、
 * canvas-wrapper div の上に overlay-layer div を配置済み（現時点では空）。
 */
const PdfViewer: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);

  // PCT-153 (blocker): pdfDocRef(useRef) を pdfDoc(useState) に変更。
  // 同一 filePath でエラー後に再読込しても新しい PDFDocumentProxy 参照が
  // state に入り、描画 effect の依存変化でキャンバス描画が再実行される。
  // 本体 usePdfRendering.ts が pdfPage を useState で持ち描画 effect 依存に
  // 含める設計を踏襲する。
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);

  // PCT-153 (major-2): ロード世代カウンタ。
  // handleOpenPdf が連続して呼ばれた場合に古い非同期処理を識別して破棄する。
  // 本体 pdfLoader.ts の globalLoadId 相当のローカル版。
  const loadGenRef = useRef<number>(0);

  // overlay canvas に渡すジオメトリ（viewport 確定後に更新）
  const [overlayGeom, setOverlayGeom] = useState<OverlayGeom | null>(null);

  // scale:1 のページサイズ（フィット計算に使用）
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);

  const mode = useReportStore((s) => s.mode);
  const resetExtractedData = useReportStore((s) => s.resetExtractedData);

  const {
    filePath,
    numPages,
    currentPage,
    zoom,
    fitMode,
    isLoading,
    error,
    setLoading,
    setError,
    setPdf,
    setCurrentPage,
    setZoom,
    setFitMode,
    goToPrevPage,
    goToNextPage,
    rotation,
    rotateBy,
  } = usePdfStore();

  // ページ番号入力フィールドの一時状態
  const [pageInput, setPageInput] = useState<string>(String(currentPage));

  // currentPage が store 側から変わった場合に input を追従させる
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // PCT-153 (major-1): pdfDoc が差し替わったとき前の doc を destroy する。
  // アンマウント時も最新の pdfDoc を確実に destroy する。
  // 本体 destroySharedPdfProxy 相当のローカルクリーンアップ。
  useEffect(() => {
    return () => {
      if (pdfDoc) {
        pdfDoc.destroy().catch(() => {});
      }
    };
  }, [pdfDoc]);

  // PDF ファイルを開く
  const handleOpenPdf = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!selected) return; // キャンセル

      // open({ multiple: false }) の返り値は string | null
      const selectedPath = selected as string;

      setLoading(true);

      // PCT-153 (major-2): 世代カウンタをインクリメントして現在世代を控える。
      const currentGen = ++loadGenRef.current;

      const bytes = await readFile(selectedPath);

      // await 後に別ロードが始まっていたら中断
      if (loadGenRef.current !== currentGen) return;

      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const newDoc = await loadingTask.promise;

      // await 後に別ロードが始まっていたら取得した proxy を破棄して中断
      if (loadGenRef.current !== currentGen) {
        newDoc.destroy().catch(() => {});
        return;
      }

      // PCT-153 (blocker): useRef → useState に変更。
      // setPdfDoc により描画 effect の依存が変化し、同一 filePath の
      // 再読込でも描画が再実行される（エラー後の再読込で canvas が
      // 空白のままになる問題を解消する）。
      setPdfDoc(newDoc);

      // MA-1: 別 PDF への差し替え時は前 PDF 固有の抽出データ（cells/confidences/
      // pageOffsets）を初期化する。同一パスの再オープンでは編集内容を消さないよう
      // filePath が変わる場合のみリセットする。template（欄定義）は保持する。
      if (selectedPath !== filePath) {
        resetExtractedData();
      }

      setPdf(selectedPath, newDoc.numPages);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "PDF の読み込みに失敗しました";
      setError(`PDF を開けませんでした: ${message}`);
    }
  };

  // 再マウント時（ステップ③の2カラム確認へ往復した後など）に filePath は
  // store に残っているが pdfDoc(ローカル state) が失われているケースで、
  // filePath から PDF を自動再読込する。setPdf は呼ばず currentPage/numPages を
  // 維持する（同一ファイルの復元なのでページ位置を保つ）。
  const autoLoadingRef = useRef(false);
  useEffect(() => {
    if (!filePath || pdfDoc || autoLoadingRef.current) return;
    autoLoadingRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const currentGen = ++loadGenRef.current;
        const bytes = await readFile(filePath);
        if (cancelled || loadGenRef.current !== currentGen) return;
        const newDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled || loadGenRef.current !== currentGen) {
          newDoc.destroy().catch(() => {});
          return;
        }
        setPdfDoc(newDoc);
      } catch {
        // 自動再読込失敗は握る（ユーザーは「PDF を開く」で再試行できる）
      } finally {
        autoLoadingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      autoLoadingRef.current = false;
    };
  }, [filePath, pdfDoc]);

  // canvas に現在ページを描画する
  useEffect(() => {
    // PCT-153 (blocker): 依存配列に pdfDoc を追加。
    // 同一 filePath でも pdfDoc の参照が変われば effect が再実行される。
    if (!filePath || !pdfDoc) return;

    // 進行中の render タスクをキャンセル
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

        // PCT-153 (minor): getPage await 後のキャンセル確認を追加。
        if (cancelled) return;

        // scale:1 のページサイズを取得し、フィット計算に使う
        // ページ固有 /Rotate にユーザー回転を加算合成（表示・OCR で単一ソース）
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

        // canvas の物理サイズ（高解像度対応）
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // CSS 上の表示サイズ
        canvas.style.width = `${viewport.width / devicePixelRatio}px`;
        canvas.style.height = `${viewport.height / devicePixelRatio}px`;

        // overlay canvas に viewport ジオメトリを渡す（PDF canvas と完全同期）
        setOverlayGeom({
          deviceWidth: viewport.width,
          deviceHeight: viewport.height,
          dpr: devicePixelRatio,
          zoom,
        });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const renderTask = page.render({
          canvas,
          viewport,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;
      } catch (e: unknown) {
        // PCT-153: キャンセル済みなら render 中断・doc 破棄由来の全例外を無視。
        // doc 差し替え時に古い doc の破棄が render を例外で落とすことがあり、
        // それを「正常な次ロードのエラー画面」に化けさせないため先頭で打ち切る。
        if (cancelled) return;
        // キャンセル例外は cancelled フラグが立つ前に届くこともあるため明示判定。
        if (
          e instanceof Error &&
          (e.message === "Rendering cancelled" ||
            e.name === "RenderingCancelledException")
        ) {
          return;
        }
        setError("ページの描画に失敗しました");
      } finally {
        // page.cleanup() で operatorList を解放（メモリ節約）
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
    // PCT-153 (blocker): pdfDoc を依存配列に追加（旧実装の pdfDocRef では
    // 同一 filePath 再読込で effect が再実行されなかった）。
  }, [filePath, pdfDoc, currentPage, zoom, rotation, setError]);

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

  /**
   * ビューを ±90° 回転する。欄 rect / pageOffsets は回転前の寸法（現在の pageSize）
   * で新空間へリマップしてから回転値を進める（順序が逆だと座標が壊れる）。
   * cells / confidences / edited は保持される（同じ物理領域を指し続ける）。
   */
  const handleRotate = (direction: 90 | -90) => {
    if (!pageSize) return;
    useReportStore.getState().rotateTemplateSpace(direction, pageSize.width, pageSize.height);
    rotateBy(direction);
  };

  const handleZoomOut = () => {
    setZoom(zoom - ZOOM_STEP);
    setFitMode("custom");
  };

  // キーボードショートカットの登録
  usePdfShortcuts();
  // パン（スペース+ドラッグ）と Ctrl+ホイールズームの登録
  usePdfPanZoom(canvasAreaRef);

  // 空状態（PDF 未読込）
  if (!filePath && !isLoading && !error) {
    return (
      <div className="pdf-viewer" data-testid="pdf-viewer">
        <div className="pdf-viewer__empty">
          <p className="pdf-viewer__empty-label">PDF 未読込</p>
          <p className="pdf-viewer__empty-sub">
            下のボタンから PDF ファイルを開いてください
          </p>
          <button
            type="button"
            className="pdf-viewer__open-btn"
            onClick={handleOpenPdf}
          >
            PDF を開く
          </button>
        </div>
      </div>
    );
  }

  // ローディング状態
  if (isLoading) {
    return (
      <div className="pdf-viewer" data-testid="pdf-viewer">
        <div className="pdf-viewer__loading" aria-live="polite" aria-busy="true">
          <p>PDF を読み込んでいます...</p>
        </div>
      </div>
    );
  }

  // エラー状態
  if (error) {
    return (
      <div className="pdf-viewer" data-testid="pdf-viewer">
        <div className="pdf-viewer__error" role="alert">
          <p className="pdf-viewer__error-message">{error}</p>
          <button
            type="button"
            className="pdf-viewer__open-btn"
            onClick={handleOpenPdf}
          >
            別の PDF を開く
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer" data-testid="pdf-viewer">
      {/* ツールバー */}
      <div className="pdf-viewer__toolbar" role="toolbar" aria-label="PDF ビューアツールバー">
        <button
          type="button"
          className="pdf-viewer__open-btn pdf-viewer__open-btn--small"
          onClick={handleOpenPdf}
        >
          PDF を開く
        </button>

        <div className="pdf-viewer__divider" aria-hidden="true" />

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

        {/* 回転（全ページ一括・90°刻み）。スキャンが横向き/逆さの帳票を
            ツール内で正立させる。表示・サムネ・OCR が同じ回転で描画される */}
        <button
          type="button"
          className="pdf-viewer__zoom-btn"
          onClick={() => handleRotate(-90)}
          disabled={!pageSize}
          aria-label="左に90度回転"
          title="左に90度回転（全ページ）"
        >
          ⟲
        </button>
        <button
          type="button"
          className="pdf-viewer__zoom-btn"
          onClick={() => handleRotate(90)}
          disabled={!pageSize}
          aria-label="右に90度回転"
          title="右に90度回転（全ページ）"
        >
          ⟳
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
      </div>

      {/* defineField モード中のヒント帯 */}
      {mode === "defineField" && (
        <div className="pdf-viewer__define-hint" role="status">
          PDF 上でドラッグして欄の範囲を指定してください（Escape でキャンセル）
        </div>
      )}

      {/* Canvas エリア */}
      <div className="pdf-viewer__canvas-area" ref={canvasAreaRef}>
        {/*
          canvas-wrapper: canvas + オーバーレイ層を relative で包む。
          FieldOverlayCanvas が PDF canvas と同一サイズで絶対配置される。
        */}
        <div className="pdf-viewer__canvas-wrapper">
          <canvas
            ref={canvasRef}
            className="pdf-viewer__canvas"
            aria-label={`PDF ページ ${currentPage}`}
          />
          <FieldOverlayCanvas geom={overlayGeom} />
        </div>
      </div>
    </div>
  );
};

export default PdfViewer;
