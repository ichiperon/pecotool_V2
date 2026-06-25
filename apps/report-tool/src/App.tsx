import { useState, type FC } from "react";
import "./App.css";
import StepBar from "./components/StepBar";
import FieldListPanel from "./components/FieldListPanel";
import CsvPreviewTable from "./components/CsvPreviewTable";
import CsvExportButton from "./components/CsvExportButton";
import { useReportStore } from "./store/reportStore";

type RightTab = "template" | "preview";

const App: FC = () => {
  const [rightTab, setRightTab] = useState<RightTab>("template");
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);

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
          <div className="placeholder-pane placeholder-pane--large">
            <p className="placeholder-pane__label">PDF ビューア</p>
            <p className="placeholder-pane__sub">PDF 描画は次バージョンで実装予定です</p>
          </div>
        </section>

        {/* 右: タブパネル */}
        <aside className="app__pane app__pane--right" aria-label="設定パネル">
          {/* タブ切り替え */}
          <div className="right-panel__tabs" role="tablist" aria-label="右パネルのタブ">
            <button
              type="button"
              role="tab"
              className={`right-panel__tab ${rightTab === "template" ? "right-panel__tab--active" : ""}`}
              aria-selected={rightTab === "template" ? "true" : "false"}
              aria-controls="panel-template"
              id="tab-template"
              onClick={() => setRightTab("template")}
            >
              欄テンプレート
            </button>
            <button
              type="button"
              role="tab"
              className={`right-panel__tab ${rightTab === "preview" ? "right-panel__tab--active" : ""}`}
              aria-selected={rightTab === "preview" ? "true" : "false"}
              aria-controls="panel-preview"
              id="tab-preview"
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
