import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmLayout from "../../components/ConfirmLayout";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";
import type { UseReportOcrReturn } from "../../hooks/useReportOcr";

// ConfirmPdfPane は pdfjs-dist / Tauri を使うためモック化
vi.mock("../../components/ConfirmPdfPane", () => ({
  default: ({ reocrTarget, reocrError, onReocrRetry }: {
    runOcrForPage: (p: number) => Promise<void>;
    reocrTarget: number | null;
    reocrError: boolean;
    onReocrRetry: () => void;
  }) => (
    <div data-testid="confirm-pdf-pane">
      <span data-testid="reocr-target">{reocrTarget ?? "null"}</span>
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
});
