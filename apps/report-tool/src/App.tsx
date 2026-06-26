import { useState, useRef, type FC, type KeyboardEvent } from "react";
import "./App.css";
import StepBar from "./components/StepBar";
import FieldListPanel from "./components/FieldListPanel";
import CsvPreviewTable from "./components/CsvPreviewTable";
import CsvExportButton from "./components/CsvExportButton";
import PdfViewer from "./components/PdfViewer";
import OcrRunPanel from "./components/OcrRunPanel";
import { useReportStore } from "./store/reportStore";

type RightTab = "template" | "preview";

const TAB_ORDER: readonly RightTab[] = ["template", "preview"] as const;

const App: FC = () => {
  const [rightTab, setRightTab] = useState<RightTab>("template");
  const tabRefs = useRef<Record<RightTab, HTMLButtonElement | null>>({
    template: null,
    preview: null,
  });
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);

  const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TAB_ORDER.indexOf(rightTab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % TAB_ORDER.length;
      const nextTab = TAB_ORDER[nextIndex];
      setRightTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prevIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      const prevTab = TAB_ORDER[prevIndex];
      setRightTab(prevTab);
      tabRefs.current[prevTab]?.focus();
    }
  };

  const fieldCount = fields.length;
  const pageCount = cells.size;

  return (
    <div className="app">
      {/* ヘッダ */}
      <header className="app__header">
        <h1 className="app__title">Peco 帳票ツール</h1>
        <StepBar activeStep={1} />
      </header>

      {/* 3ペインメイン */}
      <main className="app__body">
        {/* 左: サムネイル領域 */}
        <aside className="app__pane app__pane--left" aria-label="サムネイル">
          <div className="placeholder-pane">
            <p className="placeholder-pane__label">PDF 未読込</p>
            <p className="placeholder-pane__sub">PDF を開くと<br />サムネイルが表示されます</p>
          </div>
        </aside>

        {/* 中央: PDFビューア */}
        <section className="app__pane app__pane--center" aria-label="PDF ビューア">
          <PdfViewer />
        </section>

        {/* 右: タブパネル */}
        <aside className="app__pane app__pane--right" aria-label="設定パネル">
          {/* タブ切り替え */}
          <div
            className="right-panel__tabs"
            role="tablist"
            aria-label="右パネルのタブ"
            onKeyDown={handleTabKeyDown}
          >
            <button
              ref={(el) => { tabRefs.current.template = el; }}
              type="button"
              role="tab"
              className={`right-panel__tab ${rightTab === "template" ? "right-panel__tab--active" : ""}`}
              aria-selected={rightTab === "template"}
              aria-controls="panel-template"
              id="tab-template"
              tabIndex={rightTab === "template" ? 0 : -1}
              onClick={() => setRightTab("template")}
            >
              欄テンプレート
            </button>
            <button
              ref={(el) => { tabRefs.current.preview = el; }}
              type="button"
              role="tab"
              className={`right-panel__tab ${rightTab === "preview" ? "right-panel__tab--active" : ""}`}
              aria-selected={rightTab === "preview"}
              aria-controls="panel-preview"
              id="tab-preview"
              tabIndex={rightTab === "preview" ? 0 : -1}
              onClick={() => setRightTab("preview")}
            >
              CSV プレビュー
            </button>
          </div>

          {/* 欄テンプレートタブ */}
          <div
            id="panel-template"
            role="tabpanel"
            aria-labelledby="tab-template"
            hidden={rightTab !== "template"}
            className="right-panel__content"
          >
            <FieldListPanel />
            <OcrRunPanel />
            <CsvExportButton />
          </div>

          {/* CSVプレビュータブ */}
          <div
            id="panel-preview"
            role="tabpanel"
            aria-labelledby="tab-preview"
            hidden={rightTab !== "preview"}
            className="right-panel__content"
          >
            <CsvPreviewTable />
          </div>
        </aside>
      </main>

      {/* フッタ: ステータスバー */}
      <footer className="app__footer" aria-label="ステータスバー">
        <span className="app__status-item">欄数: {fieldCount}</span>
        <span className="app__status-divider" aria-hidden="true">|</span>
        <span className="app__status-item">ページ数: {pageCount}</span>
        <span className="app__status-divider" aria-hidden="true">|</span>
        <span className="app__status-item app__status-item--phase">
          フェーズ 1 — 段階 1（欄テンプレート定義）
        </span>
      </footer>
    </div>
  );
};

export default App;
