import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import OffsetAdjustOverlay from "../../components/OffsetAdjustOverlay";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

// MA-4: adjustOffset モード中、入力要素にフォーカスがある状態での矢印キーは
// nudgePageOffset に流れないことを検証する。
// geom=null で渡すことで redraw() 内の canvas 2d context 依存処理を早期return
// させ、canvas モックなしでテスト可能にしている（PdfViewer.test.tsx の作法を踏襲）。
describe("OffsetAdjustOverlay – MA-4 keydown 入力要素ガード", () => {
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
      mode: "adjustOffset",
      pageOffsets: new Map(),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 1,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  it("input にフォーカス中の矢印キーは pageOffsets を変更しない", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowLeft" });

    expect(useReportStore.getState().pageOffsets.size).toBe(0);
    document.body.removeChild(input);
  });

  it("textarea にフォーカス中の矢印キーは pageOffsets を変更しない", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(useReportStore.getState().pageOffsets.size).toBe(0);
    document.body.removeChild(textarea);
  });

  it("非入力要素（document.body）にフォーカスがある状態では従来どおり矢印キーで調整される", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: -1, dy: 0 });
  });

  it("Shift+矢印キーは従来どおり ±10px 調整される（非入力要素時）", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });

    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 0, dy: 10 });
  });

  it("SELECT にフォーカス中の矢印キーは pageOffsets を変更しない（MA-4 ガード）", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    const select = document.createElement("select");
    document.body.appendChild(select);
    select.focus();

    fireEvent.keyDown(select, { key: "ArrowRight" });

    expect(useReportStore.getState().pageOffsets.size).toBe(0);
    document.body.removeChild(select);
  });

  it("contentEditable 要素にフォーカス中の矢印キーは pageOffsets を変更しない（MA-4 ガード）", () => {
    render(<OffsetAdjustOverlay geom={null} />);

    const div = document.createElement("div");
    // jsdom は contentEditable 属性から isContentEditable を算出しないため明示する
    Object.defineProperty(div, "isContentEditable", { value: true });
    document.body.appendChild(div);

    fireEvent.keyDown(div, { key: "ArrowDown" });

    expect(useReportStore.getState().pageOffsets.size).toBe(0);
    document.body.removeChild(div);
  });
});

describe("OffsetAdjustOverlay – nudge 方向・モードガード", () => {
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
      mode: "adjustOffset",
      pageOffsets: new Map(),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 1,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  it("ArrowRight は +1px（x）調整される", () => {
    render(<OffsetAdjustOverlay geom={null} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 1, dy: 0 });
  });

  it("ArrowUp は -1px（y）調整される", () => {
    render(<OffsetAdjustOverlay geom={null} />);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 0, dy: -1 });
  });

  it("ArrowDown は +1px（y）調整される", () => {
    render(<OffsetAdjustOverlay geom={null} />);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 0, dy: 1 });
  });

  it("矢印以外のキーは pageOffsets を変更しない", () => {
    render(<OffsetAdjustOverlay geom={null} />);
    fireEvent.keyDown(window, { key: "a" });
    expect(useReportStore.getState().pageOffsets.size).toBe(0);
  });

  it("adjustOffset モードでない場合、矢印キーは無反応（リスナ未登録）", () => {
    useReportStore.setState({ mode: "defineField" });
    render(<OffsetAdjustOverlay geom={null} />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useReportStore.getState().pageOffsets.size).toBe(0);
  });
});
