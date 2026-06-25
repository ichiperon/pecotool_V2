import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CsvExportButton from "../../components/CsvExportButton";
import { useReportStore } from "../../store/reportStore";
import { buildTemplateCsv } from "../../logic/templateCsv";
import { encodeCsvUtf8Bom } from "../../logic/csvEncode";

// Tauriプラグインのモック（#378用）
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
}));

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

function addField(name: string) {
  useReportStore.getState().addField(SAMPLE_RECT, name);
}

describe("CsvExportButton", () => {
  it("「CSV を出力」ボタンが表示される", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("button", { name: "CSV を出力" })).toBeInTheDocument();
  });

  it("欄がゼロのときボタンが disabled になる", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("button", { name: "CSV を出力" })).toBeDisabled();
  });

  it("欄があればボタンが有効になる", () => {
    addField("金額");
    render(<CsvExportButton />);
    expect(screen.getByRole("button", { name: "CSV を出力" })).toBeEnabled();
  });

  it("出力オプション: ファイル名列チェックボックスが表示される", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("checkbox", { name: /ファイル名列を含める/ })).toBeInTheDocument();
  });

  it("出力オプション: ページ番号列チェックボックスが表示される", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("checkbox", { name: /ページ番号列を含める/ })).toBeInTheDocument();
  });

  it("出力オプション: 数値正規化チェックボックスが表示される", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("checkbox", { name: /数値を正規化/ })).toBeInTheDocument();
  });

  it("出力オプション: 空セル値のテキスト入力が表示される", () => {
    render(<CsvExportButton />);
    expect(screen.getByRole("textbox", { name: /空セルの出力値/ })).toBeInTheDocument();
  });

  it("クリックすると onSave が呼ばれ、buildTemplateCsv+encodeCsvUtf8Bom の結果が渡る", async () => {
    addField("金額");
    const fields = useReportStore.getState().template.fields;
    const matrix = new Map([[1, new Map([[fields[0].id, "1000"]])]]);
    useReportStore.getState().setCells(matrix);

    const mockSave = vi.fn().mockResolvedValue(undefined);
    render(<CsvExportButton onSave={mockSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    const [savedData, savedCsv] = mockSave.mock.calls[0] as [Uint8Array, string];
    // buildTemplateCsv + encodeCsvUtf8Bom の結果と一致するか検証
    const expectedCsv = buildTemplateCsv(
      useReportStore.getState().template,
      useReportStore.getState().cells,
      { includeFileName: true, includePageNumber: true, emptyValue: "", normalizeNumbers: false },
      { pageNumbers: [1] }
    );
    const expectedData = encodeCsvUtf8Bom(expectedCsv);
    expect(savedCsv).toBe(expectedCsv);
    expect(savedData).toEqual(expectedData);
  });

  it("欄がゼロのまま（ボタン disabled 状態）では onSave が呼ばれない", async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    render(<CsvExportButton onSave={mockSave} />);
    // disabled なのでクリックしても発火しない
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("includeFileName を OFF にするとヘッダにファイル名列が含まれない CSV が生成される", async () => {
    addField("摘要");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setCells(new Map([[1, new Map([[fields[0].id, "テスト"]])]]));

    let capturedCsv = "";
    const mockSave = vi.fn().mockImplementation(async (_data: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });

    render(<CsvExportButton onSave={mockSave} />);

    // ファイル名列を OFF にする
    const fileNameCheck = screen.getByRole("checkbox", { name: /ファイル名列を含める/ });
    fireEvent.click(fileNameCheck);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const [headerRow] = capturedCsv.split("\r\n");
    expect(headerRow).not.toContain("ファイル名");
  });

  it("normalizeNumbers を ON にすると数値が正規化された CSV が生成される", async () => {
    addField("金額");
    const fields = useReportStore.getState().template.fields;
    // △50,000 → 正規化すると -50000
    useReportStore.getState().setCells(new Map([[1, new Map([[fields[0].id, "△50,000"]])]]));

    let capturedCsv = "";
    const mockSave = vi.fn().mockImplementation(async (_data: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });

    render(<CsvExportButton onSave={mockSave} />);

    // 数値正規化を ON にする
    const normalizeCheck = screen.getByRole("checkbox", { name: /数値を正規化/ });
    fireEvent.click(normalizeCheck);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const rows = capturedCsv.split("\r\n");
    const dataRow = rows[1]; // ヘッダの次
    expect(dataRow).toContain("-50000");
  });

  it("onSave が例外を投げるとエラーメッセージを表示する", async () => {
    addField("金額");
    const mockSave = vi.fn().mockRejectedValue(new Error("ディスクが満杯です"));
    render(<CsvExportButton onSave={mockSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("ディスクが満杯です");
  });

  it("空セル値の入力フィールドを変更すると CSV に反映される", async () => {
    addField("金額");
    // cells に値を入れない → emptyValue が使われる
    useReportStore.getState().setCells(new Map([[1, new Map()]]));

    let capturedCsv = "";
    const mockSave = vi.fn().mockImplementation(async (_data: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });

    render(<CsvExportButton onSave={mockSave} />);

    const emptyInput = screen.getByRole("textbox", { name: /空セルの出力値/ });
    fireEvent.change(emptyInput, { target: { value: "N/A" } });

    // ファイル名・ページ番号をOFFにして欄だけの単純CSV確認
    fireEvent.click(screen.getByRole("checkbox", { name: /ファイル名列を含める/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /ページ番号列を含める/ }));

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const rows = capturedCsv.split("\r\n");
    expect(rows[1]).toBe("N/A");
  });
});

// #378: Tauri経路のキャンセル・成功・import失敗の検証
describe("CsvExportButton (Tauri 経路)", () => {
  beforeEach(async () => {
    useReportStore.setState({
      template: { fields: [] },
      cells: new Map(),
      mode: "idle",
      selectedFieldId: null,
    });
    // モックをリセット
    const dialogMod = await import("@tauri-apps/plugin-dialog");
    const fsMod = await import("@tauri-apps/plugin-fs");
    vi.mocked(dialogMod.save).mockReset();
    vi.mocked(fsMod.writeFile).mockReset();
  });

  it("save() が null を返す（キャンセル）とき「保存しました」が表示されない", async () => {
    const dialogMod = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialogMod.save).mockResolvedValue(null);

    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "金額");
    render(<CsvExportButton />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    // キャンセル後はボタンが「CSV を出力」のまま（done にならない）
    // save呼び出しを待ってから確認
    await waitFor(() => {
      expect(dialogMod.save).toHaveBeenCalled();
    });

    // 「保存しました」が表示されないこと
    expect(screen.queryByText("保存しました")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV を出力" })).toBeInTheDocument();
  });

  it("save() がパスを返し writeFile が成功するとき「保存しました」が表示される", async () => {
    const dialogMod = await import("@tauri-apps/plugin-dialog");
    const fsMod = await import("@tauri-apps/plugin-fs");
    vi.mocked(dialogMod.save).mockResolvedValue("/tmp/report.csv");
    vi.mocked(fsMod.writeFile).mockResolvedValue(undefined);

    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "金額");
    render(<CsvExportButton />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    await waitFor(() => {
      expect(screen.getByText("保存しました")).toBeInTheDocument();
    });

    // writeFile が Uint8Array を渡して呼ばれていること
    expect(fsMod.writeFile).toHaveBeenCalledTimes(1);
    const [calledPath, calledData] = vi.mocked(fsMod.writeFile).mock.calls[0];
    expect(calledPath).toBe("/tmp/report.csv");
    expect(calledData).toBeInstanceOf(Uint8Array);
  });
});
