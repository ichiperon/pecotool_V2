import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import OcrRunPanel from "../../components/OcrRunPanel";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";
import type { UseReportOcrReturn } from "../../hooks/useReportOcr";

function makeOcrHook(overrides?: Partial<UseReportOcrReturn>): UseReportOcrReturn {
  return {
    isRunning: false,
    progress: null,
    reocrTarget: null,
    failedPages: [],
    layoutMismatchPages: [],
    layoutBasePage: null,
    engineError: false,
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
    template: {
      fields: [
        {
          id: "field-1",
          name: "欄1",
          color: "#7cb9e8",
          rect: { x: 10, y: 10, width: 100, height: 50 },
        },
      ],
    },
    cells: new Map(),
  });
  usePdfStore.setState({
    filePath: "/test/sample.pdf",
    numPages: 2,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });

  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("OcrRunPanel – ocrHook props 経由の単一インスタンス化（#407 回帰）", () => {
  it("OCR 実行ボタン押下で props 経由の runOcr が呼ばれる（コンポーネントが独自インスタンスを持たない）", () => {
    const ocrHook = makeOcrHook();
    render(<OcrRunPanel ocrHook={ocrHook} />);

    fireEvent.click(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" }));

    expect(ocrHook.runOcr).toHaveBeenCalledTimes(1);
  });

  it("同じ ocrHook インスタンスの isRunning=true を渡すと、レンダリング結果に即座に反映される（別インスタンスなら反映されない）", () => {
    const ocrHook = makeOcrHook({ isRunning: true, progress: { done: 1, total: 2 } });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    // isRunning は呼び出し元（App/親）が管理する単一状態。
    // このコンポーネントが独自に useReportOcr() を呼んでいれば
    // 初期値 isRunning=false のフックが別途生成され、進捗表示やボタン無効化に反映されない。
    expect(screen.getByRole("button", { name: "OCR をキャンセル" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" })).toBeDisabled();
    expect(screen.getByText("1 / 2 ページ")).toBeInTheDocument();
  });

  it("キャンセルボタン押下で props 経由の cancelOcr が呼ばれる", () => {
    const ocrHook = makeOcrHook({ isRunning: true, progress: { done: 0, total: 2 } });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    fireEvent.click(screen.getByRole("button", { name: "OCR をキャンセル" }));

    expect(ocrHook.cancelOcr).toHaveBeenCalledTimes(1);
  });

  it("cells が非空のとき確認ダイアログを経由してから同一 ocrHook の runOcr を呼ぶ", () => {
    useReportStore.setState({
      cells: new Map([[1, [new Map([["field-1", "既存値"]])]]]),
    });
    const ocrHook = makeOcrHook();
    render(<OcrRunPanel ocrHook={ocrHook} />);

    fireEvent.click(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(ocrHook.runOcr).toHaveBeenCalledTimes(1);
  });

  it("確認ダイアログでキャンセルすると runOcr は呼ばれない", () => {
    useReportStore.setState({
      cells: new Map([[1, [new Map([["field-1", "既存値"]])]]]),
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const ocrHook = makeOcrHook();
    render(<OcrRunPanel ocrHook={ocrHook} />);

    fireEvent.click(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" }));

    expect(ocrHook.runOcr).not.toHaveBeenCalled();
  });
});

describe("OcrRunPanel – 無効化条件", () => {
  it("PDF 未読込のとき OCR 実行ボタンが disabled になる", () => {
    usePdfStore.setState({ filePath: null, numPages: 0 });
    render(<OcrRunPanel ocrHook={makeOcrHook()} />);

    expect(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" })).toBeDisabled();
    expect(screen.getByText("PDF を開くと OCR を実行できます")).toBeInTheDocument();
  });

  it("欄が 0 件のとき OCR 実行ボタンが disabled になる", () => {
    useReportStore.setState({ template: { fields: [] } });
    render(<OcrRunPanel ocrHook={makeOcrHook()} />);

    expect(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" })).toBeDisabled();
    expect(
      screen.getByText("欄テンプレートを 1 件以上定義してから OCR を実行してください")
    ).toBeInTheDocument();
  });

  it("PDF・欄とも揃っており isRunning=false のとき OCR 実行ボタンが有効", () => {
    render(<OcrRunPanel ocrHook={makeOcrHook()} />);

    expect(screen.getByRole("button", { name: "全ページ OCR を実行して欄データを抽出" })).toBeEnabled();
  });
});

// MA-7: OCR 処理エラーになったページ（failedPages）の表示
describe("OcrRunPanel – failedPages 表示", () => {
  it("failedPages が非空のとき失敗ページ番号を表示する", () => {
    const ocrHook = makeOcrHook({ failedPages: [3, 7] });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("ページ 3, 7 の処理に失敗しました（該当ページのデータは抽出されていません）");
  });

  it("failedPages が空のとき失敗表示を出さない", () => {
    const ocrHook = makeOcrHook({ failedPages: [] });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("isRunning 中は failedPages が非空でも失敗表示を出さない（実行中の古い結果を隠す）", () => {
    const ocrHook = makeOcrHook({
      isRunning: true,
      progress: { done: 1, total: 2 },
      failedPages: [1],
    });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("OcrRunPanel – layoutMismatchPages（用紙サイズ・向き混在の警告）", () => {
  it("混在ページがあるとページ番号・基準ページ入りの警告（role=note）を表示する", () => {
    const ocrHook = makeOcrHook({ layoutMismatchPages: [2, 5], layoutBasePage: 1 });
    render(<OcrRunPanel ocrHook={ocrHook} />);

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/ページ 2, 5/);
    expect(note).toHaveTextContent(/基準ページ（1ページ目）/);
    expect(note).toHaveTextContent(/用紙サイズ・向きが異なります/);
  });

  it("基準ページが1でない場合（ページ1処理エラー時）も正しい番号で表示する", () => {
    const ocrHook = makeOcrHook({
      failedPages: [1],
      layoutMismatchPages: [3],
      layoutBasePage: 2,
    });
    render(<OcrRunPanel ocrHook={ocrHook} />);
    expect(screen.getByRole("note")).toHaveTextContent(/基準ページ（2ページ目）/);
  });

  it("混在なし（空配列）のとき警告を表示しない", () => {
    render(<OcrRunPanel ocrHook={makeOcrHook()} />);
    expect(screen.queryByText(/用紙サイズ・向き/)).not.toBeInTheDocument();
  });

  it("OCR 実行中は混在警告を表示しない（前回実行の古い結果を隠す）", () => {
    const ocrHook = makeOcrHook({
      isRunning: true,
      progress: { done: 1, total: 2 },
      layoutMismatchPages: [2],
      layoutBasePage: 1,
    });
    render(<OcrRunPanel ocrHook={ocrHook} />);
    expect(screen.queryByText(/用紙サイズ・向き/)).not.toBeInTheDocument();
  });

  it("failedPages と layoutMismatchPages は同時に両方表示できる", () => {
    const ocrHook = makeOcrHook({
      failedPages: [3],
      layoutMismatchPages: [2],
      layoutBasePage: 1,
    });
    render(<OcrRunPanel ocrHook={ocrHook} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/ページ 3/);
    expect(screen.getByRole("note")).toHaveTextContent(/ページ 2/);
  });
});

describe("OcrRunPanel – engineError（エンジン死亡）表示", () => {
  it("engineError=true のとき言語パック案内付きの alert を表示する", () => {
    render(<OcrRunPanel ocrHook={makeOcrHook({ engineError: true })} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/OCR を実行できませんでした/);
    expect(alert).toHaveTextContent(/言語パック/);
    expect(alert).toHaveTextContent(/既存の抽出結果は保持されています/);
  });

  it("isRunning 中は engineError を表示しない", () => {
    render(
      <OcrRunPanel
        ocrHook={makeOcrHook({
          isRunning: true,
          progress: { done: 0, total: 2 },
          engineError: true,
        })}
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
