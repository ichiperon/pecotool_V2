import type { FC } from "react";
import { useCallback } from "react";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import type { UseReportOcrReturn } from "../hooks/useReportOcr";

interface Props {
  /** App 上位で生成された単一の OCR フックインスタンス。 */
  ocrHook: UseReportOcrReturn;
}

/**
 * OCR 実行パネル。
 *
 * 欄テンプレートパネル（FieldListPanel）の下部に配置し、
 * 全ページ × 全欄の OCR 実行・進捗表示・キャンセルを提供する。
 *
 * 条件:
 * - PDF 未読込またはテンプレート欄が 0 件のときはボタンを無効化
 * - OCR 実行中は進捗バーと "N/M ページ" ラベルを表示
 * - cells が非空のとき OCR 再実行前に確認ダイアログを表示（手編集データ損失防止）
 * - aria-live="polite" で進捗をスクリーンリーダーに通知
 * - OCR 完了後、処理エラーになったページ（failedPages）があれば一覧表示する
 *
 * OCR フックは App 上位で 1 インスタンスのみ生成し props 経由で受け取る
 * （このコンポーネントが独自に useReportOcr() を呼ぶと、isRunning/epoch/cancel が
 * ConfirmLayout 側のインスタンスと分離し、並走・相互キャンセル不成立を招く）。
 */
const OcrRunPanel: FC<Props> = ({ ocrHook }) => {
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);
  const filePath = usePdfStore((s) => s.filePath);
  const numPages = usePdfStore((s) => s.numPages);
  const {
    isRunning,
    progress,
    failedPages,
    layoutMismatchPages,
    layoutBasePage,
    engineError,
    runOcr,
    cancelOcr,
  } = ocrHook;

  const canRun = !isRunning && !!filePath && numPages > 0 && fields.length > 0;
  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  // cells が非空のとき確認ダイアログを挟む（手編集データ損失防止）
  const handleRunOcr = useCallback(() => {
    if (cells.size > 0) {
      const ok = window.confirm(
        "既存のOCR結果（手編集を含む）は破棄されます。続けますか？"
      );
      if (!ok) return;
    }
    runOcr();
  }, [cells, runOcr]);

  return (
    <div className="ocr-run-panel">
      <div className="ocr-run-panel__actions">
        <button
          type="button"
          className="ocr-run-panel__run-btn"
          onClick={handleRunOcr}
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
            {/* width は動的な数値なので CSS カスタムプロパティ経由 */}
            <div
              className="ocr-run-panel__progress-fill"
              style={
                {
                  "--progress-pct": `${progressPct}%`,
                } as React.CSSProperties
              }
            />
          </div>
          <span className="ocr-run-panel__progress-label" aria-hidden="true">
            {progress.done} / {progress.total} ページ
          </span>
        </div>
      )}

      {/* エンジン死亡（最初のページで全欄 invoke 失敗 → 実行中断・cells 非破壊） */}
      {!isRunning && engineError && (
        <p className="ocr-run-panel__failed" role="alert">
          OCR を実行できませんでした。Windows の設定 &gt; 時刻と言語 &gt; 言語と地域 で
          日本語の言語パックが追加されているか確認してください。既存の抽出結果は保持されています
        </p>
      )}

      {/* OCR 処理エラーになったページの通知 */}
      {!isRunning && failedPages.length > 0 && (
        <p className="ocr-run-panel__failed" role="alert">
          ページ {failedPages.join(", ")} の処理に失敗しました（該当ページのデータは抽出されていません）
        </p>
      )}

      {/* 用紙サイズ・向き混在の警告（欄テンプレは全ページ同一レイアウト前提）。
          基準は「最初に処理成功したページ」— ページ1が処理エラーのときは1でないため、
          番号を明示する（「先頭ページ」と書くと基準がずれたとき嘘になる）。 */}
      {!isRunning && layoutMismatchPages.length > 0 && layoutBasePage !== null && (
        <p className="ocr-run-panel__mismatch" role="note">
          ページ {layoutMismatchPages.join(", ")} は基準ページ（{layoutBasePage}
          ページ目）と用紙サイズ・向きが異なります。欄の位置が内容とずれている可能性があるため、確認ステップで該当ページの値を確認してください
        </p>
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
