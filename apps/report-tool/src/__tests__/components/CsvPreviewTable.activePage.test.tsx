import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import CsvPreviewTable from "../../components/CsvPreviewTable";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

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

function setupTable() {
  useReportStore.getState().addField(SAMPLE_RECT, "金額");
  const fields = useReportStore.getState().template.fields;
  // 新形: Map<number, ReportRow[]> — 各ページを 1 段配列として設定
  useReportStore.getState().setCells(
    new Map([
      [1, [new Map([[fields[0].id, "100"]])]],
      [2, [new Map([[fields[0].id, "200"]])]],
      [3, [new Map([[fields[0].id, "300"]])]],
    ])
  );
}

describe("CsvPreviewTable – activePage props なし（従来動作）", () => {
  it("props なしでレンダリングが壊れない", () => {
    setupTable();
    render(<CsvPreviewTable />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });

  it("--current クラスがどの行にも付かない", () => {
    setupTable();
    render(<CsvPreviewTable />);
    const rows = document.querySelectorAll(".csv-preview__row--current");
    expect(rows.length).toBe(0);
  });
});

describe("CsvPreviewTable – activePage 指定時のハイライト", () => {
  it("activePage=2 のとき 2ページ目の行に --current クラスが付く", () => {
    setupTable();
    render(<CsvPreviewTable activePage={2} />);

    const allRows = screen.getAllByRole("row");
    // row[0]=ヘッダ, row[1]=p1, row[2]=p2, row[3]=p3
    expect(allRows[2]).toHaveClass("csv-preview__row--current");
    expect(allRows[1]).not.toHaveClass("csv-preview__row--current");
    expect(allRows[3]).not.toHaveClass("csv-preview__row--current");
  });

  it("activePage が変わると --current クラスが移動する", () => {
    setupTable();
    const { rerender } = render(<CsvPreviewTable activePage={1} />);
    const allRows = screen.getAllByRole("row");
    expect(allRows[1]).toHaveClass("csv-preview__row--current");

    rerender(<CsvPreviewTable activePage={3} />);
    const updatedRows = screen.getAllByRole("row");
    expect(updatedRows[3]).toHaveClass("csv-preview__row--current");
    expect(updatedRows[1]).not.toHaveClass("csv-preview__row--current");
  });
});

describe("CsvPreviewTable – 行クリックで setCurrentPage", () => {
  it("activePage 指定時に行クリックで setCurrentPage が呼ばれる", () => {
    setupTable();
    render(<CsvPreviewTable activePage={1} />);

    // 2ページ目の行をクリック
    const allRows = screen.getAllByRole("row");
    const page2Row = allRows[2]; // row[0]=header, row[1]=p1, row[2]=p2
    fireEvent.click(page2Row);

    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("activePage=undefined のとき行クリックで setCurrentPage は呼ばれない（state 変化なし）", () => {
    setupTable();
    render(<CsvPreviewTable />);

    const initialPage = usePdfStore.getState().currentPage;
    const allRows = screen.getAllByRole("row");
    const page2Row = allRows[2];
    fireEvent.click(page2Row);

    // activePage が undefined なので setCurrentPage は呼ばれず currentPage は変わらない
    expect(usePdfStore.getState().currentPage).toBe(initialPage);
  });
});

describe("CsvPreviewTable – reocrTarget によるローディング行", () => {
  it("reocrTarget=2 のとき 2ページ目の行に --reocr-loading クラスが付く", () => {
    setupTable();
    render(<CsvPreviewTable reocrTarget={2} />);

    const allRows = screen.getAllByRole("row");
    expect(allRows[2]).toHaveClass("csv-preview__row--reocr-loading");
    expect(allRows[1]).not.toHaveClass("csv-preview__row--reocr-loading");
  });

  it("reocrTarget=null のとき --reocr-loading クラスがどの行にも付かない", () => {
    setupTable();
    render(<CsvPreviewTable reocrTarget={null} />);

    const rows = document.querySelectorAll(".csv-preview__row--reocr-loading");
    expect(rows.length).toBe(0);
  });
});

describe("CsvPreviewTable – activePage + reocrTarget 同時指定", () => {
  it("activePage と reocrTarget が同一ページのとき両方クラスが付く", () => {
    setupTable();
    render(<CsvPreviewTable activePage={2} reocrTarget={2} />);

    const allRows = screen.getAllByRole("row");
    expect(allRows[2]).toHaveClass("csv-preview__row--current");
    expect(allRows[2]).toHaveClass("csv-preview__row--reocr-loading");
  });

  it("activePage と reocrTarget が異なるページのとき別々に付く", () => {
    setupTable();
    render(<CsvPreviewTable activePage={1} reocrTarget={3} />);

    const allRows = screen.getAllByRole("row");
    expect(allRows[1]).toHaveClass("csv-preview__row--current");
    expect(allRows[3]).toHaveClass("csv-preview__row--reocr-loading");
    expect(allRows[1]).not.toHaveClass("csv-preview__row--reocr-loading");
    expect(allRows[3]).not.toHaveClass("csv-preview__row--current");
  });
});

describe("CsvPreviewTable – aria-disabled 値の型確認（PCT-156 是正）", () => {
  it("ドラッグ中にドロップ不可行の gridcell が aria-disabled を持つ", async () => {
    setupTable();
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    const sourceCell = cells[0]; // p1/金額

    fireEvent.pointerDown(sourceCell, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(sourceCell, { clientX: 110, clientY: 100, pointerId: 1 });

    await act(async () => {});

    // ドロップ不可行（p2）のセルに aria-disabled が付く
    // 値は boolean true として "true" 文字列ではなく boolean で渡されることを確認
    const page2Cell = cells[1]; // p2/金額
    // aria-disabled="true" として DOM には文字列で入る（boolean → "true" 変換は React が行う）
    expect(page2Cell).toHaveAttribute("aria-disabled", "true");

    fireEvent.pointerUp(sourceCell, { clientX: 110, clientY: 100, pointerId: 1 });
  });
});
