import { useState, useRef, useEffect, useCallback, type FC, type KeyboardEvent } from "react";
import ConfirmPdfPane from "./ConfirmPdfPane";
import CsvPreviewTable from "./CsvPreviewTable";
import { usePdfStore } from "../store/pdfStore";
import type { UseReportOcrReturn } from "../hooks/useReportOcr";

/** 左カラムの最小幅 (px) */
const LEFT_MIN_WIDTH = 320;
/** 右カラムの最小幅 (px) */
const RIGHT_MIN_WIDTH = 360;
/** 初期左カラム幅 (px) */
const LEFT_INITIAL_WIDTH = 520;
/** スプリッタ幅 (px) */
const SPLITTER_WIDTH = 6;
/** キーボードでスプリッタを動かす単位 (px) */
const SPLITTER_KEY_STEP = 16;

interface Props {
  ocrHook: UseReportOcrReturn;
}

/**
 * 確認ステップ（ステップ3）の2カラムレイアウト。
 *
 * 左: ConfirmPdfPane（PDF ビューア + オフセット調整）
 * 中: スプリッタ（可変幅）
 * 右: CsvPreviewTable（OCR 結果確認・編集）
 */
const ConfirmLayout: FC<Props> = ({ ocrHook }) => {
  const [leftWidthPx, setLeftWidthPx] = useState(LEFT_INITIAL_WIDTH);
  const [reocrError, setReocrError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const { reocrTarget, runOcrForPage, failedPages, layoutMismatchPages, layoutBasePage } = ocrHook;
  const currentPage = usePdfStore((s) => s.currentPage);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);

  // クランプ付きリサイズ
  const clampLeft = useCallback((desired: number): number => {
    const container = containerRef.current;
    if (!container) return desired;
    const maxLeft = container.clientWidth - SPLITTER_WIDTH - RIGHT_MIN_WIDTH;
    return Math.max(LEFT_MIN_WIDTH, Math.min(maxLeft, desired));
  }, []);

  // スプリッタドラッグ
  const handleSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const splitter = e.currentTarget;
    splitter.setPointerCapture(e.pointerId);
  };

  const handleSplitterPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const containerLeft = container.getBoundingClientRect().left;
      const desired = e.clientX - containerLeft;
      setLeftWidthPx(clampLeft(desired));
    },
    [clampLeft]
  );

  const handleSplitterPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // スプリッタキーボード操作（← → で 16px ずつ）
  const handleSplitterKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setLeftWidthPx((w) => clampLeft(w - SPLITTER_KEY_STEP));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setLeftWidthPx((w) => clampLeft(w + SPLITTER_KEY_STEP));
    }
  };

  // 再OCR ラッパー（エラー状態管理込み）
  const handleReocrForPage = useCallback(
    async (pageNum: number) => {
      setReocrError(false);
      try {
        await runOcrForPage(pageNum);
        // 完了通知を aria-live に書き込む
        const liveEl = document.getElementById("confirm-pdf-pane-live");
        if (liveEl) {
          liveEl.textContent = `${pageNum}ページ目を再OCRしました`;
          // 次回の同一通知でも再アナウンスするため、短時間後にクリア
          setTimeout(() => {
            if (liveEl) liveEl.textContent = "";
          }, 2000);
        }
      } catch {
        setReocrError(true);
      }
    },
    [runOcrForPage]
  );

  const handleReocrRetry = useCallback(() => {
    void handleReocrForPage(currentPage);
  }, [handleReocrForPage, currentPage]);

  // ウィンドウリサイズ時に右カラムが MIN 未満にならないようクランプ
  useEffect(() => {
    const handleResize = () => {
      setLeftWidthPx((w) => clampLeft(w));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampLeft]);

  return (
    <div
      ref={containerRef}
      className="confirm-layout"
      style={{
        display: "grid",
        gridTemplateColumns: `${leftWidthPx}px ${SPLITTER_WIDTH}px 1fr`,
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* 左: PDF ビューア + オフセット調整 */}
      <div className="confirm-layout__left">
        <ConfirmPdfPane
          runOcrForPage={handleReocrForPage}
          reocrTarget={reocrTarget}
          reocrError={reocrError}
          onReocrRetry={handleReocrRetry}
        />
      </div>

      {/* スプリッタ */}
      <div
        className="confirm-layout__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="左右のペイン幅を調整"
        aria-valuenow={leftWidthPx}
        aria-valuemin={LEFT_MIN_WIDTH}
        aria-valuemax={9999}
        tabIndex={0}
        onPointerDown={handleSplitterPointerDown}
        onPointerMove={handleSplitterPointerMove}
        onPointerUp={handleSplitterPointerUp}
        onPointerCancel={handleSplitterPointerUp}
        onKeyDown={handleSplitterKeyDown}
      />

      {/* 右: CSV プレビューテーブル */}
      <div className="confirm-layout__right">
        <div className="confirm-layout__right-header">
          <span className="confirm-layout__page-badge">
            確認中: {currentPage} ページ目
          </span>
        </div>

        {/* OCR 実行結果の警告を確認画面に持ち込む。
            OCR 完了で自動的にステップ③へ遷移するため、ステップ②の OcrRunPanel だけに
            表示すると警告が出た瞬間に画面ごと切り替わり誰も読めない（UXレビュー指摘 P1）。
            ページ番号ボタンで該当ページへジャンプできる。 */}
        {failedPages.length > 0 && (
          <p className="confirm-layout__ocr-alert" role="alert">
            OCR 失敗（CSV に行が含まれません）:
            {failedPages.map((p) => (
              <button
                key={p}
                type="button"
                className="confirm-layout__page-jump-btn"
                onClick={() => setCurrentPage(p)}
                aria-label={`OCR に失敗した ${p} ページ目を表示`}
              >
                {p}
              </button>
            ))}
          </p>
        )}
        {layoutMismatchPages.length > 0 && layoutBasePage !== null && (
          <p className="confirm-layout__ocr-note" role="note">
            用紙サイズ・向きが基準ページ（{layoutBasePage}ページ目）と異なるページ:
            {layoutMismatchPages.map((p) => (
              <button
                key={p}
                type="button"
                className="confirm-layout__page-jump-btn"
                onClick={() => setCurrentPage(p)}
                aria-label={`用紙サイズ・向きが異なる ${p} ページ目を表示`}
              >
                {p}
              </button>
            ))}
          </p>
        )}
        <CsvPreviewTable
          activePage={currentPage}
          reocrTarget={reocrTarget}
        />
      </div>
    </div>
  );
};

export default ConfirmLayout;
