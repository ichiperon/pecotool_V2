import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import App from "../App";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import type { UseReportOcrReturn } from "../hooks/useReportOcr";

// #448 / PCT-212 回帰テスト: OCR 実行中はステップ移動（テンプレ読込・セル編集・
// CSV出力への到達）を disable する。App は useReportOcr() を内部で呼ぶため、
// isRunning を外部から制御するにはフック自体をモックする。

vi.mock("../components/PdfViewer", () => ({
  default: () => <div data-testid="pdf-viewer-mock">PDF Viewer Mock</div>,
}));

vi.mock("../components/ThumbnailPanel", () => ({
  default: () => <div data-testid="thumbnail-panel-mock">Thumbnail Panel Mock</div>,
}));

vi.mock("../components/ConfirmLayout", () => ({
  default: () => <div data-testid="confirm-layout-mock">Confirm Layout Mock</div>,
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
    preserveEdited: true,
    setPreserveEdited: vi.fn(),
    runOcr: vi.fn(),
    cancelOcr: vi.fn(),
    runOcrForPage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let currentMockOcrHook: UseReportOcrReturn = makeOcrHook();

vi.mock("../hooks/useReportOcr", () => ({
  useReportOcr: () => currentMockOcrHook,
}));

function resetStores() {
  useReportStore.setState({
    template: {
      fields: [
        { id: "f1", name: "欄1", color: "#7cb9e8", rect: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
  usePdfStore.setState({
    filePath: "/test/sample.pdf",
    numPages: 3,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });
}

describe("App - OCR実行中のステップ移動ゲート（#448 / PCT-212）", () => {
  beforeEach(() => {
    resetStores();
  });

  it("isRunning=false のときは全ステップへ移動できる（既存挙動の回帰確認）", async () => {
    currentMockOcrHook = makeOcrHook({ isRunning: false });
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ステップ 2/ }));
    });
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 2/4");

    expect(screen.getByRole("button", { name: /ステップ 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ステップ 3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ステップ 4/ })).toBeInTheDocument();
  });

  it("isRunning=true のときステップ1・3・4への移動ボタンが表示されない（テンプレ読込・セル編集・CSV出力を遮断）", async () => {
    currentMockOcrHook = makeOcrHook({ isRunning: true, progress: { done: 1, total: 3 } });
    render(<App />);

    // 初期はステップ1がアクティブ。ステップ2（OCR適用）は isRunning に関係なく
    // hasFields のみで判定するため有効のまま。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ステップ 2/ }));
    });
    expect(screen.getByRole("contentinfo")).toHaveTextContent("ステップ 2/4");

    // isRunning=true のため、他ステップへの移動ボタンが disable（span表示）になる
    expect(screen.queryByRole("button", { name: /ステップ 1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ステップ 3/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ステップ 4/ })).not.toBeInTheDocument();
  });

  it("無効になったステップに「OCR 実行中は移動できません」の title が付く", async () => {
    currentMockOcrHook = makeOcrHook({ isRunning: true, progress: { done: 1, total: 3 } });
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ステップ 2/ }));
    });

    const nav = screen.getByRole("navigation", { name: "作業ステップ" });
    const step1Item = within(nav).getByText("欄を定義").closest("li");
    expect(step1Item).toHaveAttribute("title", "OCR 実行中は移動できません");
  });

  it("OCR実行中は「戻る」ボタンが disabled になる", async () => {
    currentMockOcrHook = makeOcrHook({ isRunning: true, progress: { done: 1, total: 3 } });
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ステップ 2/ }));
    });

    const prevBtn = screen.getByRole("button", { name: /戻る/ });
    expect(prevBtn).toBeDisabled();
    expect(prevBtn).toHaveAttribute("title", "OCR 実行中は移動できません");
  });
});
