import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import CsvPreviewTable from "../../components/CsvPreviewTable";
import { useReportStore } from "../../store/reportStore";

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
});

function setup(): string {
  useReportStore.getState().addField(SAMPLE_RECT, "金額");
  const id = useReportStore.getState().template.fields[0].id;
  useReportStore.getState().setCells(new Map([[1, [new Map([[id, "100"]])]]]));
  return id;
}

describe("CsvPreviewTable: 手修正バッジ", () => {
  it("未編集セルにはバッジが出ない", () => {
    setup();
    render(<CsvPreviewTable />);
    const cell = screen.getByRole("gridcell", { name: /金額 100/ });
    expect(cell.className).not.toContain("csv-preview__td--edited");
    expect(cell.querySelector(".csv-preview__edited-mark")).toBeNull();
  });

  it("手編集したセルに --edited クラスと ✎ バッジが付く", () => {
    const id = setup();
    render(<CsvPreviewTable />);
    act(() => {
      useReportStore.getState().setCellValue(1, id, "200");
    });
    const cell = screen.getByRole("gridcell", { name: /金額 200/ });
    expect(cell.className).toContain("csv-preview__td--edited");
    expect(cell.querySelector(".csv-preview__edited-mark")).not.toBeNull();
  });

  it("手編集セルの aria-label に「手修正済み」が含まれる", () => {
    const id = setup();
    render(<CsvPreviewTable />);
    act(() => {
      useReportStore.getState().setCellValue(1, id, "200");
    });
    expect(
      screen.getByRole("gridcell", { name: /手修正済み/ })
    ).toBeInTheDocument();
  });

  it("削除（空にした）セルにもバッジが付く — 人が意図して空にした証跡", () => {
    const id = setup();
    render(<CsvPreviewTable />);
    act(() => {
      useReportStore.getState().clearCellValue(1, id);
    });
    const cell = screen.getByRole("gridcell", { name: /手修正済み/ });
    expect(cell.className).toContain("csv-preview__td--edited");
  });

  it("ツールバーの元に戻す/やり直すボタンが履歴の有無で活性化し、クリックで機能する", () => {
    const id = setup();
    render(<CsvPreviewTable />);
    const undoBtn = screen.getByRole("button", { name: "元に戻す" });
    const redoBtn = screen.getByRole("button", { name: "やり直す" });
    // 初期状態: 履歴なし → 両方 disabled
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).toBeDisabled();

    act(() => {
      useReportStore.getState().setCellValue(1, id, "200");
    });
    expect(undoBtn).not.toBeDisabled();
    expect(redoBtn).toBeDisabled();

    act(() => {
      undoBtn.click();
    });
    expect(useReportStore.getState().cells.get(1)?.[0]?.get(id)).toBe("100");
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).not.toBeDisabled();

    act(() => {
      redoBtn.click();
    });
    expect(useReportStore.getState().cells.get(1)?.[0]?.get(id)).toBe("200");
  });

  it("undo するとバッジが消える", () => {
    const id = setup();
    render(<CsvPreviewTable />);
    act(() => {
      useReportStore.getState().setCellValue(1, id, "200");
    });
    expect(screen.getByRole("gridcell", { name: /手修正済み/ })).toBeInTheDocument();

    act(() => {
      useReportStore.getState().undo();
    });
    const cell = screen.getByRole("gridcell", { name: /金額 100/ });
    expect(cell.className).not.toContain("csv-preview__td--edited");
    expect(screen.queryByRole("gridcell", { name: /手修正済み/ })).toBeNull();
  });
});
