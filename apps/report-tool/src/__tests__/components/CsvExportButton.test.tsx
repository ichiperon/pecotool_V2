import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CsvExportButton from "../../components/CsvExportButton";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";
import { buildTemplateCsv } from "../../logic/templateCsv";
import { encodeCsvUtf8Bom } from "../../logic/csvEncode";

// Tauriプラグインのモック
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
// plugin-fs は修正C により Tauri 経路では使わなくなったが、
// モジュール解決エラー回避のためスタブとして残す
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
}));
// Tauri invoke モック（修正C: save_csv コマンド経由保存）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    excludedPages: new Set(),
    mode: "idle",
    selectedFieldId: null,
  });
  usePdfStore.getState().reset();
  // cells 空での出力は確認ダイアログを挟むようになった（出力前ゲート）。
  // jsdom の confirm は未実装で falsy を返すため、既定は OK として既存テストの
  // 保存経路検証を通す（ゲート自体の検証は「出力前ゲート」describe で行う）。
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
    // 新形: Map<number, ReportRow[]>
    const matrix = new Map([[1, [new Map([[fields[0].id, "1000"]])]]]);
    useReportStore.getState().setCells(matrix);
    usePdfStore.getState().setPdf("C:\\docs\\invoice.pdf", 1);

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
      { fileName: "invoice.pdf", pageNumbers: [1] }
    );
    const expectedData = encodeCsvUtf8Bom(expectedCsv);
    expect(savedCsv).toBe(expectedCsv);
    expect(savedData).toEqual(expectedData);
  });

  it("PCT-189: usePdfStore.filePath の basename がファイル名列の値として出力される", async () => {
    addField("金額");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setCells(new Map([[1, [new Map([[fields[0].id, "1000"]])]]]));
    // POSIX区切りのフルパスでも basename が正しく抽出されること
    usePdfStore.getState().setPdf("/home/user/docs/請求書.pdf", 1);

    let capturedCsv = "";
    const mockSave = vi.fn().mockImplementation(async (_data: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });

    render(<CsvExportButton onSave={mockSave} />);
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const rows = capturedCsv.split("\r\n");
    const dataRow = rows[1];
    // ファイル名列（先頭列）の値がフルパスでなく basename であること
    expect(dataRow.startsWith("請求書.pdf,")).toBe(true);
  });

  it("PCT-189: PDF 未ロード（filePath=null）のときファイル名列は空文字のまま", async () => {
    addField("金額");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setCells(new Map([[1, [new Map([[fields[0].id, "1000"]])]]]));
    // usePdfStore.reset() 済み（beforeEach）→ filePath は null のまま

    let capturedCsv = "";
    const mockSave = vi.fn().mockImplementation(async (_data: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });

    render(<CsvExportButton onSave={mockSave} />);
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const rows = capturedCsv.split("\r\n");
    const dataRow = rows[1];
    expect(dataRow.startsWith(",")).toBe(true); // ファイル名列が空
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
    useReportStore.getState().setCells(new Map([[1, [new Map([[fields[0].id, "テスト"]])]]]));

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
    useReportStore.getState().setCells(new Map([[1, [new Map([[fields[0].id, "△50,000"]])]]]));

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
    useReportStore.getState().setCells(new Map([[1, [new Map()]]]));

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

// 修正C: Tauri 経路は invoke("save_csv", ...) を使う
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
    const invokeMod = await import("@tauri-apps/api/core");
    vi.mocked(dialogMod.save).mockReset();
    vi.mocked(invokeMod.invoke).mockReset();
  });

  it("save() が null を返す（キャンセル）とき「保存しました」が表示されない", async () => {
    const dialogMod = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialogMod.save).mockResolvedValue(null);

    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "金額");
    render(<CsvExportButton />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    // キャンセル後はボタンが「CSV を出力」のまま（done にならない）
    await waitFor(() => {
      expect(dialogMod.save).toHaveBeenCalled();
    });

    // 「保存しました」が表示されないこと
    expect(screen.queryByText("保存しました")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV を出力" })).toBeInTheDocument();
  });

  it("save() がパスを返し invoke(save_csv) が成功するとき「保存しました」が表示される", async () => {
    const dialogMod = await import("@tauri-apps/plugin-dialog");
    const invokeMod = await import("@tauri-apps/api/core");
    vi.mocked(dialogMod.save).mockResolvedValue("/tmp/report.csv");
    vi.mocked(invokeMod.invoke).mockResolvedValue(undefined);

    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "金額");
    render(<CsvExportButton />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));

    await waitFor(() => {
      expect(screen.getByText("保存しました")).toBeInTheDocument();
    });

    // invoke が save_csv コマンドで呼ばれ、path と csv 文字列が渡っていること
    expect(invokeMod.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(invokeMod.invoke).mock.calls[0];
    expect(cmd).toBe("save_csv");
    expect((args as { path: string; csv: string }).path).toBe("/tmp/report.csv");
    expect(typeof (args as { path: string; csv: string }).csv).toBe("string");
  });
});

describe("CsvExportButton – 出力前ゲート", () => {
  it("低信頼セルが残っていると件数付きの注意（role=note）を表示する", () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "1000"]])]]]),
      confidences: new Map([[1, [new Map([[id, 0.3]])]]]),
    });
    render(<CsvExportButton />);
    expect(screen.getByRole("note")).toHaveTextContent(/低信頼セルが 1 件未確認/);
  });

  it("低信頼セルがなければ注意を出さない", () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "1000"]])]]]),
      confidences: new Map(),
    });
    render(<CsvExportButton />);
    expect(screen.queryByText(/低信頼セル/)).not.toBeInTheDocument();
  });

  it("failedPages があると「CSV に行が含まれない」旨の alert を表示する", () => {
    addField("金額");
    render(<CsvExportButton failedPages={[3, 7]} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /ページ 3, 7 は OCR 失敗のため CSV に行が含まれません/
    );
  });

  // #447 (PCT-211): failedPages は useReportOcr のローカル state だった頃、
  // セッション復元後に空へ戻ってしまい、この警告ゲートが無言で消えていた。
  // reportStore へ移した後は、復元で store に書き戻された failedPages を
  // App.tsx が ocrHook.failedPages 経由でそのまま渡すため、同じ警告が出ることを
  // ここで確認する（store 側の復元検証は
  // __tests__/hooks/useSessionPersistence.test.ts の「復元」describe が担当）。
  it("セッション復元で store に書き戻された failedPages でも同じ警告ゲートが働く", () => {
    addField("金額");
    // useSessionPersistence.offerRestore が行うのと同じ形の書き戻しを模す
    useReportStore.setState({ failedPages: [2, 5] });

    render(<CsvExportButton failedPages={useReportStore.getState().failedPages} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /ページ 2, 5 は OCR 失敗のため CSV に行が含まれません/
    );
  });

  it("cells が空のとき出力前に確認ダイアログを出し、キャンセルで出力しない", () => {
    addField("金額");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CsvExportButton onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      "OCR 結果がありません。ヘッダーと空の行だけの CSV を出力しますか？"
    );
    expect(onSave).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("cells が空でも確認 OK なら出力できる（ブロックはしない）", async () => {
    addField("金額");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CsvExportButton onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });

  it("cells が非空なら確認ダイアログを出さずに出力する", async () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "1000"]])]]]),
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CsvExportButton onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("CsvExportButton – 全ページ除外時のフォールバック（レビューHIGH回帰）", () => {
  it("cellsがあるのに全ページ除外なら、除外したページ1のデータをCSVに出さない", async () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "秘匿値999"]])]]]),
      excludedPages: new Set([1]),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let savedCsv = "";
    const onSave = vi.fn().mockImplementation(async (_d: Uint8Array, csv: string) => {
      savedCsv = csv;
    });
    render(<CsvExportButton onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 確認ダイアログ（全ページ除外）を経由し、除外データは出力されない
    expect(confirmSpy).toHaveBeenCalledWith(
      "すべてのページが除外されています。ヘッダーのみの CSV を出力しますか？"
    );
    expect(savedCsv).not.toContain("秘匿値999");
    confirmSpy.mockRestore();
  });

  it("全ページ除外の確認でキャンセルすると出力しない", () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "v"]])]]]),
      excludedPages: new Set([1]),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSave = vi.fn();
    render(<CsvExportButton onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    expect(onSave).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("除外したページはfailedPages警告の対象から外れる", () => {
    addField("金額");
    useReportStore.setState({ excludedPages: new Set([3]) });
    render(<CsvExportButton failedPages={[3]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("CsvExportButton – 逆順出力（UXレビュー⑩）", () => {
  it("チェックONでデータ行がページ降順になる", async () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setCells(
      new Map([
        [1, [new Map([[id, "P1"]])]],
        [2, [new Map([[id, "P2"]])]],
        [3, [new Map([[id, "P3"]])]],
      ])
    );

    let capturedCsv = "";
    const onSave = vi.fn().mockImplementation(async (_d: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });
    render(<CsvExportButton onSave={onSave} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /ページを逆順で出力/ }));
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    const rows = capturedCsv.trim().split("\r\n").slice(1); // ヘッダ除く
    const order = rows.map((r) => r.match(/P\d/)?.[0]);
    expect(order).toEqual(["P3", "P2", "P1"]);
  });

  it("チェックOFF（既定）は昇順のまま", async () => {
    addField("金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setCells(
      new Map([
        [2, [new Map([[id, "P2"]])]],
        [1, [new Map([[id, "P1"]])]],
      ])
    );
    let capturedCsv = "";
    const onSave = vi.fn().mockImplementation(async (_d: Uint8Array, csv: string) => {
      capturedCsv = csv;
    });
    render(<CsvExportButton onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "CSV を出力" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const rows = capturedCsv.trim().split("\r\n").slice(1);
    expect(rows.map((r) => r.match(/P\d/)?.[0])).toEqual(["P1", "P2"]);
  });
});
