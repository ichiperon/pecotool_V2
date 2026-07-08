import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CsvPreviewTable from "../../components/CsvPreviewTable";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    edited: new Map(),
    past: [],
    future: [],
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
  usePdfStore.setState({
    filePath: "/test.pdf",
    numPages: 10,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });
});

/** 欄2つ（金額・摘要）と、要確認セルを含む2ページ分の cells/confidences を用意する */
function setupWithReviewTargets(): { idA: string; idB: string } {
  useReportStore.getState().addField(SAMPLE_RECT, "金額");
  useReportStore.getState().addField(SAMPLE_RECT, "摘要");
  const [idA, idB] = useReportStore.getState().template.fields.map((f) => f.id);
  useReportStore.getState().setCells(
    new Map([
      // page1: 金額=低信頼, 摘要=正常
      [1, [new Map([[idA, "1000"], [idB, "OK"]])]],
      // page2: 金額=空, 摘要=正常
      [2, [new Map([[idA, ""], [idB, "OK"]])]],
    ])
  );
  useReportStore.getState().setConfidences(
    new Map([
      [1, [new Map([[idA, 0.3], [idB, 0.9]])]],
      [2, [new Map([[idB, 0.9]])]],
    ])
  );
  return { idA, idB };
}

describe("CsvPreviewTable – 要確認ナビ（残数チップ＋次へボタン）", () => {
  it("低信頼・空の残数チップが表示される", () => {
    setupWithReviewTargets();
    render(<CsvPreviewTable />);
    expect(screen.getByText("⚠ 低信頼 1")).toBeInTheDocument();
    expect(screen.getByText("空 1")).toBeInTheDocument();
  });

  it("要確認セルがゼロのときナビ自体が表示されない", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setCells(new Map([[1, [new Map([[id, "正常値"]])]]]));
    render(<CsvPreviewTable />);
    expect(screen.queryByText(/低信頼/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "次の要確認セルへ移動" })
    ).not.toBeInTheDocument();
  });

  it("「次の要確認」で最初の要確認セル（低信頼）にフォーカスが移る", () => {
    setupWithReviewTargets();
    render(<CsvPreviewTable />);
    fireEvent.click(screen.getByRole("button", { name: "次の要確認セルへ移動" }));

    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("aria-label")).toContain("1ページ目");
    expect(focused.getAttribute("aria-label")).toContain("金額");
    expect(focused.getAttribute("aria-label")).toContain("信頼度低");
  });

  it("続けて押すと次の要確認セル（別ページの空セル）へ進み、末尾で先頭へ循環する", () => {
    setupWithReviewTargets();
    render(<CsvPreviewTable />);
    const nextBtn = screen.getByRole("button", { name: "次の要確認セルへ移動" });

    fireEvent.click(nextBtn); // → page1 金額（低信頼）
    fireEvent.click(nextBtn); // → page2 金額（空）
    let focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("aria-label")).toContain("2ページ目");
    expect(focused.getAttribute("aria-label")).toContain("空");

    fireEvent.click(nextBtn); // 末尾 → 先頭へ循環
    focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("aria-label")).toContain("1ページ目");
  });

  it("確認画面（activePage 指定時）はジャンプ先のページへ PDF が同期する", () => {
    setupWithReviewTargets();
    render(<CsvPreviewTable activePage={1} />);
    const nextBtn = screen.getByRole("button", { name: "次の要確認セルへ移動" });

    fireEvent.click(nextBtn); // page1 低信頼
    fireEvent.click(nextBtn); // page2 空
    expect(usePdfStore.getState().currentPage).toBe(2);
  });
});
