import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ConfirmLayout from "../../components/ConfirmLayout";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";
import type { UseReportOcrReturn } from "../../hooks/useReportOcr";

// ConfirmPdfPane は pdfjs-dist / Tauri を使うためモック化
vi.mock("../../components/ConfirmPdfPane", () => ({
  default: ({ runOcrForPage, reocrTarget, isRunning, reocrError, onReocrRetry }: {
    runOcrForPage: (p: number) => Promise<void>;
    reocrTarget: number | null;
    isRunning: boolean;
    reocrError: boolean;
    onReocrRetry: () => void;
  }) => (
    <div data-testid="confirm-pdf-pane">
      <span data-testid="reocr-target">{reocrTarget ?? "null"}</span>
      <span data-testid="is-running">{String(isRunning)}</span>
      {/* ConfirmLayout の handleReocrForPage（catch → reocrError）経路をテストから
          駆動するためのトリガー。実物では再OCRボタンに相当する */}
      <button type="button" onClick={() => void runOcrForPage(1)}>
        再OCRトリガー
      </button>
      {reocrError && (
        <button type="button" onClick={onReocrRetry}>再試行</button>
      )}
    </div>
  ),
}));

// CsvPreviewTable も軽量モック
vi.mock("../../components/CsvPreviewTable", () => ({
  default: ({ activePage, reocrTarget }: {
    activePage?: number;
    reocrTarget?: number | null;
  }) => (
    <div data-testid="csv-preview-table">
      <span data-testid="active-page">{activePage ?? "undefined"}</span>
      <span data-testid="reocr-target-right">{reocrTarget ?? "null"}</span>
    </div>
  ),
}));

function makeOcrHook(overrides?: Partial<UseReportOcrReturn>): UseReportOcrReturn {
  return {
    isRunning: false,
    progress: null,
    reocrTarget: null,
    failedPages: [],
    layoutMismatchPages: [],
    layoutBasePage: null,
    engineError: false,
    templateChangeAbort: false,
    pdfChangeAbort: false,
    preserveEdited: true,
    setPreserveEdited: vi.fn(),
    runOcr: vi.fn(),
    cancelOcr: vi.fn(),
    runOcrForPage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
  usePdfStore.setState({
    filePath: null,
    numPages: 3,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });
});

describe("ConfirmLayout – 基本レンダリング", () => {
  it("ConfirmPdfPane と CsvPreviewTable を表示する", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    expect(screen.getByTestId("confirm-pdf-pane")).toBeInTheDocument();
    expect(screen.getByTestId("csv-preview-table")).toBeInTheDocument();
  });

  it("スプリッタが separator role で表示される", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    const splitter = screen.getByRole("separator");
    expect(splitter).toBeInTheDocument();
    expect(splitter).toHaveAttribute("aria-orientation", "vertical");
  });

  it("確認中ページバッジに currentPage が表示される", () => {
    usePdfStore.setState({ currentPage: 2, numPages: 5, filePath: null, zoom: 100, isLoading: false, error: null });
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    expect(screen.getByText(/確認中: 2 ページ目/)).toBeInTheDocument();
  });
});

describe("ConfirmLayout – スプリッタのキーボード操作", () => {
  /** jsdom では clientWidth=0 のため、コンテナ幅をモックして clamp を正常動作させる */
  function mockContainerWidth(container: HTMLElement, width: number) {
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      get: () => width,
    });
  }

  it("→ キーで leftWidthPx が増加する", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    const splitter = screen.getByRole("separator");
    const container = splitter.parentElement!;

    // 幅 1200px のコンテナとしてモック（初期 520px → max は 1200-6-360=834px）
    mockContainerWidth(container, 1200);

    const extractLeft = (cols: string) => parseInt(cols.split("px")[0]);
    const initialLeft = extractLeft(container.style.gridTemplateColumns);

    splitter.focus();
    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    const updatedLeft = extractLeft(container.style.gridTemplateColumns);
    // 初期値 520px + 16px = 536px
    expect(updatedLeft).toBeGreaterThan(initialLeft);
    expect(updatedLeft).toBe(initialLeft + 16);
  });

  it("← キーで leftWidthPx が減少する", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    const splitter = screen.getByRole("separator");
    const container = splitter.parentElement!;

    mockContainerWidth(container, 1200);

    const extractLeft = (cols: string) => parseInt(cols.split("px")[0]);
    const initialLeft = extractLeft(container.style.gridTemplateColumns);

    splitter.focus();
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });

    const updatedLeft = extractLeft(container.style.gridTemplateColumns);
    // 初期値 520px - 16px = 504px
    expect(updatedLeft).toBeLessThan(initialLeft);
    expect(updatedLeft).toBe(initialLeft - 16);
  });

  it("LEFT_MIN_WIDTH (320px) より小さくならない", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    const splitter = screen.getByRole("separator");
    const container = splitter.parentElement!;

    mockContainerWidth(container, 1200);

    splitter.focus();
    // 大量に ← を押してもクランプされる
    for (let i = 0; i < 100; i++) {
      fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    }

    const cols = container.style.gridTemplateColumns;
    const leftPx = parseInt(cols.split("px")[0]);
    expect(leftPx).toBeGreaterThanOrEqual(320);
    expect(leftPx).toBe(320);
  });
});

describe("ConfirmLayout – activePage / reocrTarget の伝搬", () => {
  it("currentPage が CsvPreviewTable の activePage として渡される", () => {
    usePdfStore.setState({ currentPage: 2, numPages: 5, filePath: null, zoom: 100, isLoading: false, error: null });
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    expect(screen.getByTestId("active-page")).toHaveTextContent("2");
  });

  it("ocrHook.reocrTarget が CsvPreviewTable に渡される", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook({ reocrTarget: 3 })} />);
    expect(screen.getByTestId("reocr-target-right")).toHaveTextContent("3");
  });

  // #448 / PCT-212: 全ページ OCR 実行中にページ再OCRボタンが押せてしまい、
  // epoch 共有により全ページ側の結果が無言破棄される事故があった。
  // ConfirmPdfPane 側でボタンを disable するには isRunning を正しく受け取る必要がある。
  it("ocrHook.isRunning が ConfirmPdfPane に渡される（再OCRボタンの排他ゲートの前提）", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook({ isRunning: true })} />);
    expect(screen.getByTestId("is-running")).toHaveTextContent("true");
  });

  it("ocrHook.isRunning=false のときも正しく渡される", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook({ isRunning: false })} />);
    expect(screen.getByTestId("is-running")).toHaveTextContent("false");
  });
});

describe("ConfirmLayout – OCR警告バナーの持ち込み（ステップ③置き去り修正）", () => {
  beforeEach(() => {
    usePdfStore.setState({ filePath: "/test.pdf", numPages: 10, currentPage: 1 });
  });

  it("failedPages があると role=alert のバナーが確認画面に出る", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook({ failedPages: [3, 7] })} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/OCR 失敗/);
    expect(alert).toHaveTextContent(/CSV に行が含まれません/);
  });

  it("失敗ページ番号ボタンをクリックすると該当ページへジャンプする", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook({ failedPages: [3, 7] })} />);
    fireEvent.click(screen.getByRole("button", { name: "OCR に失敗した 7 ページ目を表示" }));
    expect(usePdfStore.getState().currentPage).toBe(7);
  });

  it("用紙サイズ混在は role=note で基準ページ付きで表示され、ジャンプできる", () => {
    render(
      <ConfirmLayout
        ocrHook={makeOcrHook({ layoutMismatchPages: [2], layoutBasePage: 1 })}
      />
    );
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/基準ページ（1ページ目）/);
    fireEvent.click(
      screen.getByRole("button", { name: "用紙サイズ・向きが異なる 2 ページ目を表示" })
    );
    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("警告なしのときバナーは表示されない", () => {
    render(<ConfirmLayout ocrHook={makeOcrHook()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("ConfirmLayout – 再OCR拒否エラーの reocrError 伝搬（#448 / PCT-212）", () => {
  // 全ページ OCR 実行中に runOcrForPage を呼ぶとフックは throw で拒否する。
  // その throw を ConfirmLayout が catch して reocrError=true（再試行 UI）に
  // 載せるところまでが #448 の受入基準。握りつぶすと拒否が無反応に見える。
  it("runOcrForPage が reject すると再試行ボタン（reocrError UI）が表示される", async () => {
    const ocrHook = makeOcrHook({
      runOcrForPage: vi
        .fn()
        .mockRejectedValue(
          new Error("別の OCR 処理が実行中のため、このページの再 OCR を開始できませんでした")
        ),
    });
    render(<ConfirmLayout ocrHook={ocrHook} />);

    expect(screen.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再OCRトリガー" }));

    expect(await screen.findByRole("button", { name: "再試行" })).toBeInTheDocument();
    expect(ocrHook.runOcrForPage).toHaveBeenCalledWith(1);
  });

  it("再試行ボタンで currentPage の再OCRが再実行され、成功するとエラー表示が消える", async () => {
    usePdfStore.setState({ currentPage: 2 });
    const runOcrForPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("一時的な失敗"))
      .mockResolvedValueOnce(undefined);
    render(<ConfirmLayout ocrHook={makeOcrHook({ runOcrForPage })} />);

    fireEvent.click(screen.getByRole("button", { name: "再OCRトリガー" }));
    const retryBtn = await screen.findByRole("button", { name: "再試行" });

    fireEvent.click(retryBtn);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument()
    );
    // 再試行は表示中のページ（currentPage）を対象にする
    expect(runOcrForPage).toHaveBeenLastCalledWith(2);
    expect(runOcrForPage).toHaveBeenCalledTimes(2);
  });
});
