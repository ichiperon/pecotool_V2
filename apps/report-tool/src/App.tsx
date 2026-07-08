import { useState, useEffect, useRef, type FC } from "react";
import "./App.css";
import StepBar, { type StepNumber } from "./components/StepBar";
import FieldListPanel from "./components/FieldListPanel";
import TemplateLibraryPanel from "./components/TemplateLibraryPanel";
import CsvExportButton from "./components/CsvExportButton";
import PdfViewer from "./components/PdfViewer";
import OcrRunPanel from "./components/OcrRunPanel";
import ThumbnailPanel from "./components/ThumbnailPanel";
import ConfirmLayout from "./components/ConfirmLayout";
import { useReportStore } from "./store/reportStore";
import { useReportOcr } from "./hooks/useReportOcr";
import { useUndoShortcuts, type UndoActionType } from "./hooks/useUndoShortcuts";

/**
 * ゼロ幅スペース。同一テキストの連続セットでも aria-live の再アナウンスを
 * 保証するためのトグル文字（CsvPreviewTable と同じパターン）。
 */
const ZWSP = "​";

const STEP_LABELS: Record<StepNumber, string> = {
  1: "欄を定義",
  2: "OCR 適用",
  3: "確認",
  4: "CSV 出力",
};

const App: FC = () => {
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);
  const setMode = useReportStore((s) => s.setMode);

  // OCR フックを App 上位で呼び出し（全ステップ共通・ConfirmLayout に渡す）
  const ocrHook = useReportOcr();

  // Undo/Redo のキー操作フィードバック（チップ表示 + aria-live）。
  // キーボード undo は視覚変化がスクロール外で起きうるため、何が起きたかを明示する。
  const [undoNotice, setUndoNotice] = useState("");
  const undoNoticeTimerRef = useRef<number | null>(null);
  const undoNoticeToggleRef = useRef(false);
  const handleUndoAction = (type: UndoActionType, applied: boolean) => {
    const text =
      type === "undo"
        ? applied
          ? "元に戻しました"
          : "これ以上戻せる操作はありません"
        : applied
          ? "やり直しました"
          : "やり直せる操作はありません";
    undoNoticeToggleRef.current = !undoNoticeToggleRef.current;
    setUndoNotice(undoNoticeToggleRef.current ? `${text}${ZWSP}` : text);
    if (undoNoticeTimerRef.current !== null) {
      window.clearTimeout(undoNoticeTimerRef.current);
    }
    undoNoticeTimerRef.current = window.setTimeout(() => setUndoNotice(""), 2000);
  };
  useEffect(() => {
    return () => {
      if (undoNoticeTimerRef.current !== null) {
        window.clearTimeout(undoNoticeTimerRef.current);
      }
    };
  }, []);

  // エディタ操作の Undo/Redo（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）。
  // undo 対象（セル編集・オフセット調整）が見えるステップ③でのみ有効化する —
  // 他ステップで効かせると「見えない画面のデータが無言で巻き戻る」遠隔作用になる。
  useUndoShortcuts(currentStep === 3, handleUndoAction);

  // OCR 完了（cells が空→非空に変わった）を検知して自動ステップ③へ
  const prevCellsSizeRef = useRef(cells.size);
  useEffect(() => {
    const prevSize = prevCellsSizeRef.current;
    prevCellsSizeRef.current = cells.size;
    if (prevSize === 0 && cells.size > 0) {
      setCurrentStep(3);
    }
  }, [cells.size]);

  const fieldCount = fields.length;
  const pageCount = cells.size;

  const hasFields = fieldCount > 0;
  const hasCells = cells.size > 0;

  // 各ステップの有効状態（ソフトゲート）
  const stepEnabled: Record<StepNumber, boolean> = {
    1: true,
    2: hasFields,
    3: true,
    4: hasFields,
  };

  // 各ステップの完了状態
  const stepCompleted: Partial<Record<StepNumber, boolean>> = {
    1: hasFields,
    2: hasCells,
    3: false,
    4: false,
  };

  const handleStepSelect = (step: StepNumber) => {
    if (stepEnabled[step]) {
      // ステップ③を離れるときに adjustOffset モードを解除する
      if (currentStep === 3 && step !== 3) {
        setMode("idle");
      }
      setCurrentStep(step);
    }
  };

  return (
    <div className="app">
      {/* ヘッダ */}
      <header className="app__header">
        <h1 className="app__title">Peco 帳票ツール</h1>
        <StepBar
          activeStep={currentStep}
          stepEnabled={stepEnabled}
          onStepSelect={handleStepSelect}
          stepCompleted={stepCompleted}
        />
      </header>

      {/* ステップ③: 2カラム確認レイアウト（3ペインを完全置換） */}
      {currentStep === 3 ? (
        <main className="app__body--confirm" aria-label="確認">
          <ConfirmLayout ocrHook={ocrHook} />
        </main>
      ) : (
        /* ステップ①②④: 3ペインメイン（変更なし） */
        <main className="app__body">
          {/* 左: サムネイル */}
          <aside className="app__pane app__pane--left" aria-label="サムネイル">
            <ThumbnailPanel />
          </aside>

          {/* 中央: PDFビューア */}
          <section className="app__pane app__pane--center" aria-label="PDF ビューア">
            <PdfViewer />
          </section>

          {/* 右: ステップパネル */}
          <aside className="app__pane app__pane--right" aria-label="操作パネル">
            <div className="right-panel__content">
              {currentStep === 1 && (
                <div className="step-panel">
                  <p className="step-panel__hint">
                    PDF を開き、欄をドラッグして定義してください
                  </p>
                  <TemplateLibraryPanel />
                  <FieldListPanel />
                </div>
              )}
              {currentStep === 2 && (
                <div className="step-panel">
                  {!hasFields && (
                    <p className="step-panel__warning" role="note">
                      先に欄を定義してください（ステップ 1）
                    </p>
                  )}
                  <OcrRunPanel ocrHook={ocrHook} />
                </div>
              )}
              {currentStep === 4 && (
                <div className="step-panel">
                  {!hasFields && (
                    <p className="step-panel__warning" role="note">
                      先に欄を定義してください（ステップ 1）
                    </p>
                  )}
                  <CsvExportButton />
                </div>
              )}

              {/* ステップ前進/戻る導線（右エリアで次の操作を明示） */}
              <div className="step-nav">
                {currentStep > 1 && (
                  <button
                    type="button"
                    className="step-nav__btn step-nav__btn--prev"
                    onClick={() =>
                      handleStepSelect((currentStep - 1) as StepNumber)
                    }
                    disabled={!stepEnabled[(currentStep - 1) as StepNumber]}
                  >
                    ◀ 戻る（{STEP_LABELS[(currentStep - 1) as StepNumber]}）
                  </button>
                )}
                {currentStep < 4 && (
                  <button
                    type="button"
                    className="step-nav__btn step-nav__btn--next"
                    onClick={() =>
                      handleStepSelect((currentStep + 1) as StepNumber)
                    }
                    disabled={!stepEnabled[(currentStep + 1) as StepNumber]}
                    title={
                      !stepEnabled[(currentStep + 1) as StepNumber]
                        ? "先に欄を定義してください"
                        : undefined
                    }
                  >
                    次へ：{STEP_LABELS[(currentStep + 1) as StepNumber]} ▶
                  </button>
                )}
              </div>
            </div>
          </aside>
        </main>
      )}

      {/* Undo/Redo フィードバックチップ（常設 live region・内容トグルで表示） */}
      <div
        className={`undo-notice${undoNotice ? " undo-notice--visible" : ""}`}
        role="status"
      >
        {undoNotice}
      </div>

      {/* フッタ: ステータスバー */}
      <footer className="app__footer" aria-label="ステータスバー">
        <span className="app__status-item">欄数: {fieldCount}</span>
        <span className="app__status-divider" aria-hidden="true">|</span>
        <span className="app__status-item">ページ数: {pageCount}</span>
        <span className="app__status-divider" aria-hidden="true">|</span>
        <span className="app__status-item app__status-item--phase">
          ステップ {currentStep}/4: {STEP_LABELS[currentStep]}
        </span>
      </footer>
    </div>
  );
};

export default App;
