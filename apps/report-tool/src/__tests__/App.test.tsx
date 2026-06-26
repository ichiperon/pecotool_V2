import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import App from "../App";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";

// PdfViewer は pdfjs-dist をモジュールレベルで import し、jsdom 環境では
// DOMMatrix 未定義エラーが発生する。App.test.tsx では PdfViewer の描画内容を
// テスト対象としないため、コンポーネントごとモックに置き換える。
vi.mock("../components/PdfViewer", () => ({
  default: () => <div data-testid="pdf-viewer-mock">PDF Viewer Mock</div>,
}));

// ThumbnailPanel は pdfjs-dist / Tauri FS を使う canvas 操作を含むため mock 化
vi.mock("../components/ThumbnailPanel", () => ({
  default: () => <div data-testid="thumbnail-panel-mock">Thumbnail Panel Mock</div>,
}));

// ConfirmLayout は内部で ConfirmPdfPane → pdfjs-dist を import し DOMMatrix エラーが出るため mock 化
vi.mock("../components/ConfirmLayout", () => ({
  default: () => <div data-testid="confirm-layout-mock">Confirm Layout Mock</div>,
}));

function resetStores() {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
  usePdfStore.setState({
    filePath: null,
    numPages: 0,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });
}

describe("App – 基本表示", () => {
  it("アプリタイトルを表示する", () => {
    render(<App />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Peco 帳票ツール");
  });

  it("ステップバーを表示する", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "作業ステップ" })).toBeInTheDocument();
  });

  it("フッタにステータスバーを表示する", () => {
    render(<App />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("初期フッタにステップ1のラベルが表示される", () => {
    render(<App />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 1/4: 欄を定義");
  });
});

describe("App – ステップ駆動パネル", () => {
  it("初期（ステップ1）は FieldListPanel が表示される", () => {
    resetStores();
    render(<App />);
    // FieldListPanel 内の「欄テンプレート」見出しが存在する
    expect(
      screen.getByRole("heading", { name: /欄テンプレート/i })
    ).toBeInTheDocument();
  });

  it("ステップ1のヒント文が表示される", () => {
    resetStores();
    render(<App />);
    expect(
      screen.getByText(/PDF を開き、欄をドラッグして定義/)
    ).toBeInTheDocument();
  });

  it("StepBar のステップ3クリックでパネルが切り替わる", async () => {
    resetStores();
    render(<App />);
    // ステップ3は「常時可」なのでクリック可能ボタンとして表示される
    const step3Btn = screen.getByRole("button", { name: /ステップ 3/ });
    await act(async () => {
      fireEvent.click(step3Btn);
    });
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 3/4: 確認");
  });

  it("ステップ2は fields=0 のとき disabled ヒントが表示される", async () => {
    resetStores();
    render(<App />);
    // ステップ2はフィールドなしで disabled → 通常 span（ボタンでない）
    // ステップ2クリックが無視されることを確認するため直接 step3→step2 を試みる
    // ステップ2の「欄を定義モード」への誘導メモ: フィールドがない状態では
    // ステップ2に切り替えても警告が出る（ステップ2がクリック不可のため到達しない）
    const step2BtnOrSpan = screen.queryByRole("button", { name: /ステップ 2/ });
    // disabled のためボタンとして表示されない（li > span のまま）
    expect(step2BtnOrSpan).not.toBeInTheDocument();
  });

  it("フィールドを追加するとステップ1の完了マークが出る", async () => {
    resetStores();
    render(<App />);
    // フィールドを store に追加
    await act(async () => {
      useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "金額");
    });
    // 完了扱い (sr-only「完了」) が DOM に現れる
    const srOnlyItems = document.querySelectorAll(".sr-only");
    const hasCompleted = Array.from(srOnlyItems).some((el) => el.textContent === "完了");
    expect(hasCompleted).toBe(true);
  });
});

describe("App – OCR 完了時の自動ステップ③遷移", () => {
  it("cells が空→非空に変わると自動でステップ3に移動する", async () => {
    resetStores();
    render(<App />);
    // 初期はステップ1
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 1/4");

    // cells に値をセット（OCR 完了を模擬）
    await act(async () => {
      useReportStore.getState().setCells(new Map([[1, new Map([["f1", "値"]])]]));
    });

    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 3/4: 確認");
  });

  it("cells が既に非空の状態から再セットしても自動遷移しない", async () => {
    resetStores();
    // 初期から cells が非空
    useReportStore.setState({
      template: { fields: [] },
      cells: new Map([[1, new Map([["f1", "初期値"]])]]),
      mode: "idle",
      selectedFieldId: null,
    });
    render(<App />);
    // ステップ1のまま（cells.size=1 → prevSize も 1 なので遷移しない）
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 1/4");
  });
});

// StepBar アクセシビリティテスト
import StepBar from "../components/StepBar";

describe("StepBar", () => {
  it("完了ステップのバッジにスクリーンリーダー向け「完了」が含まれる", () => {
    // activeStep=2 → ステップ1が完了扱い
    render(<StepBar activeStep={2} />);
    // sr-only で「完了」テキストが存在すること
    const srOnlyItems = document.querySelectorAll(".sr-only");
    const hasCompleted = Array.from(srOnlyItems).some((el) => el.textContent === "完了");
    expect(hasCompleted).toBe(true);
  });

  it("完了ステップの視覚的「✓」は aria-hidden になっている", () => {
    render(<StepBar activeStep={2} />);
    const hiddenCheckmarks = document.querySelectorAll('[aria-hidden="true"]');
    const checkmark = Array.from(hiddenCheckmarks).find((el) => el.textContent === "✓");
    expect(checkmark).toBeTruthy();
  });

  it("onStepSelect を渡すと有効なステップがボタンになる", () => {
    const onSelect = vi.fn();
    render(
      <StepBar
        activeStep={1}
        stepEnabled={{ 1: true, 2: false, 3: true, 4: false }}
        onStepSelect={onSelect}
      />
    );
    // ステップ3は enabled かつ active でない → ボタン
    const btn = screen.getByRole("button", { name: /ステップ 3/ });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("disabled ステップはボタンではなくスパンになる", () => {
    render(
      <StepBar
        activeStep={1}
        stepEnabled={{ 1: true, 2: false, 3: false, 4: false }}
        onStepSelect={vi.fn()}
      />
    );
    // ステップ2 は disabled → ボタンとして存在しない
    expect(screen.queryByRole("button", { name: /ステップ 2/ })).not.toBeInTheDocument();
  });

  it("アクティブなステップは aria-current=step になる", () => {
    render(<StepBar activeStep={2} />);
    // ステップ2がアクティブ: step-bar__number に aria-current="step"
    const current = document.querySelector('[aria-current="step"]');
    expect(current).toBeTruthy();
  });
});
