import type { FC } from "react";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { useReportOcr } from "../hooks/useReportOcr";

/**
 * OCR 実行パネル。
 *
 * 欄テンプレートパネル（FieldListPanel）の下部に配置し、
 * 全ページ × 全欄の OCR 実行・進捗表示・キャンセルを提供する。
 *
 * 条件:
 * - PDF 未読込またはテンプレート欄が 0 件のときはボタンを無効化
 * - OCR 実行中は進捗バーと "N/M ページ" ラベルを表示
 * - aria-live="polite" で進捗をスクリーンリーダーに通知
 */
const OcrRunPanel: FC = () => {
  const fields = useReportStore((s) => s.template.fields);
  const filePath = usePdfStore((s) => s.filePath);
  const numPages = usePdfStore((s) => s.numPages);
  const { isRunning, progress, runOcr, cancelOcr } = useReportOcr();

  const canRun = !isRunning && !!filePath && numPages > 0 && fields.length > 0;
  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div className="ocr-run-panel">
      <div className="ocr-run-panel__actions">
        <button
          type="button"
          className="ocr-run-panel__run-btn"
          onClick={runOcr}
          disabled={!canRun}
          aria-label="全ページ OCR を実行して欄データを抽出"
        >
          OCR 実行
        </button>
        {isRunning && (
          <button
            type="button"
            className="ocr-run-panel__cancel-btn"
            onClick={cancelOcr}
            aria-label="OCR をキャンセル"
          >
            キャンセル
          </button>
        )}
      </div>

      {/* 進捗表示 */}
      {isRunning && progress && (
        <div
          className="ocr-run-panel__progress"
          aria-live="polite"
          aria-label="OCR 進捗"
        >
          <div
            className="ocr-run-panel__progress-bar"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-label={`OCR 進捗: ${progress.done} / ${progress.total} ページ完了`}
          >
            <div
              className="ocr-run-panel__progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="ocr-run-panel__progress-label" aria-hidden="true">
            {progress.done} / {progress.total} ページ
          </span>
        </div>
      )}

      {/* 無効化理由のヒント */}
      {!filePath && (
        <p className="ocr-run-panel__hint">PDF を開くと OCR を実行できます</p>
      )}
      {filePath && fields.length === 0 && (
        <p className="ocr-run-panel__hint">
          欄テンプレートを 1 件以上定義してから OCR を実行してください
        </p>
      )}
    </div>
  );
};

export default OcrRunPanel;
