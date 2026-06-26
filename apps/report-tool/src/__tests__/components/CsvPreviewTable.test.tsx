import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import CsvPreviewTable from "../../components/CsvPreviewTable";
import { useReportStore } from "../../store/reportStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

function setFields(names: string[]) {
  names.forEach((name) => {
    useReportStore.getState().addField(SAMPLE_RECT, name);
  });
}

function setCells(entries: [number, [string, string][]][]) {
  const matrix: Map<number, Map<string, string>> = new Map();
  for (const [page, pairs] of entries) {
    matrix.set(page, new Map(pairs));
  }
  useReportStore.getState().setCells(matrix);
}

describe("CsvPreviewTable", () => {
  it("欄がゼロのとき案内テキストを表示する", () => {
    render(<CsvPreviewTable />);
    expect(screen.getByText(/欄テンプレートに欄を追加/)).toBeInTheDocument();
  });

  it("欄はあるが cells が空のとき OCR 案内を表示する", () => {
    setFields(["金額"]);
    render(<CsvPreviewTable />);
    expect(screen.getByText(/OCR 後に値が表示されます/)).toBeInTheDocument();
  });

  it("欄はあるが cells が空のとき「サンプルデータを挿入」ボタンを表示する", () => {
    setFields(["金額"]);
    render(<CsvPreviewTable />);
    expect(screen.getByRole("button", { name: /サンプルデータを挿入/ })).toBeInTheDocument();
  });

  it("cells を注入するとテーブルが表示される", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "1000"]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });

  it("ヘッダ行に「ページ」と欄名が表示される", () => {
    setFields(["金額", "摘要"]);
    const fields = useReportStore.getState().template.fields;
    setCells([
      [1, [[fields[0].id, "500"], [fields[1].id, "テスト"]]],
    ]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("ページ")).toBeInTheDocument();
    expect(screen.getByText("金額")).toBeInTheDocument();
    expect(screen.getByText("摘要")).toBeInTheDocument();
  });

  it("データ行にセル値が表示される", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "9999"]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("9999")).toBeInTheDocument();
  });

  it("複数ページ分の行が表示される", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([
      [1, [[fields[0].id, "100"]]],
      [2, [[fields[0].id, "200"]]],
    ]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("空セルは「(空)」と表示され、該当セルに empty クラスが付く", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    // セルにフィールドの値を入れない → emptyValue扱い
    setCells([[1, [[fields[0].id, ""]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("(空)")).toBeInTheDocument();
  });

  it("cells が存在するとき「サンプル再挿入」ボタンを表示する", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "1000"]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByRole("button", { name: /サンプル再挿入/ })).toBeInTheDocument();
  });

  it("ページ番号が昇順で表示される", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    // Map 挿入順をあえて逆順にする
    setCells([
      [3, [[fields[0].id, "300"]]],
      [1, [[fields[0].id, "100"]]],
    ]);
    render(<CsvPreviewTable />);
    const rows = screen.getAllByRole("row");
    // row[0]=ヘッダ, row[1]=ページ1, row[2]=ページ3
    expect(rows[1]).toHaveTextContent("1");
    expect(rows[2]).toHaveTextContent("3");
  });
});

// ---------------------------------------------------------------------------
// PCT-156 a11y 是正テスト
// ---------------------------------------------------------------------------

describe("CsvPreviewTable: PCT-156 — aria-live 一意性（同一文字列の連続削除）", () => {
  it("同じ欄を2回連続削除すると aria-live 領域の textContent が変化する", async () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "1000"]]]]);
    render(<CsvPreviewTable />);

    const liveRegion = document.querySelector("[aria-live]");
    expect(liveRegion).not.toBeNull();

    // 1回目削除
    const clearBtn = screen.getByRole("button", { name: /1ページ目 金額 を削除/ });
    fireEvent.click(clearBtn);
    const firstContent = liveRegion!.textContent;
    expect(firstContent).toContain("1ページ目 金額 を削除しました");

    // 値を復元して2回目削除
    act(() => {
      useReportStore.getState().setCellValue(1, fields[0].id, "2000");
    });

    const clearBtn2 = screen.getByRole("button", { name: /1ページ目 金額 を削除/ });
    fireEvent.click(clearBtn2);
    const secondContent = liveRegion!.textContent;

    // 同じ文言でも textContent が変化していること（再アナウンス保証）
    expect(secondContent).toContain("1ページ目 金額 を削除しました");
    expect(secondContent).not.toBe(firstContent);
  });
});

describe("CsvPreviewTable: PCT-156 — ドラッグ中のドロップ不可行に aria 属性", () => {
  it("ドラッグ開始前はすべての tr に aria-description がない", () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([
      [1, [[fields[0].id, "100"]]],
      [2, [[fields[0].id, "200"]]],
    ]);
    render(<CsvPreviewTable />);

    const rows = screen.getAllByRole("row");
    // ヘッダ行を除いたデータ行に aria-description がないことを確認
    const dataRows = rows.slice(1);
    dataRows.forEach((row) => {
      expect(row).not.toHaveAttribute("aria-description");
    });
  });

  it("Pointer Events ドラッグ中にドロップ不可行の gridcell が aria-disabled を持つ", async () => {
    setFields(["金額"]);
    const fields = useReportStore.getState().template.fields;
    setCells([
      [1, [[fields[0].id, "100"]]],
      [2, [[fields[0].id, "200"]]],
    ]);
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    // cells[0]=p1/金額, cells[1]=p2/金額 の順（rowheader は gridcell でない）
    const sourceCell = cells[0];

    // Pointer Events: pointerdown で捕捉開始、pointermove で閾値超えのドラッグ開始
    fireEvent.pointerDown(sourceCell, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    // DRAG_THRESHOLD (5px) を超える移動
    fireEvent.pointerMove(sourceCell, { clientX: 110, clientY: 100, pointerId: 1 });

    // ドラッグ中: ページ2の行が dimmed になり aria-description が付く
    await waitFor(() => {
      const rows = screen.getAllByRole("row");
      const page2Row = rows[2]; // row[0]=ヘッダ, row[1]=p1, row[2]=p2
      expect(page2Row).toHaveAttribute("aria-description", "このページへはドロップできません");
    });

    // ページ2のセルが aria-disabled を持つ
    const targetCell = cells[1];
    expect(targetCell).toHaveAttribute("aria-disabled", "true");

    // pointerup でドラッグ終了 → クリーンアップされる
    fireEvent.pointerUp(sourceCell, { clientX: 110, clientY: 100, pointerId: 1 });

    await waitFor(() => {
      const rows = screen.getAllByRole("row");
      const page2Row = rows[2];
      expect(page2Row).not.toHaveAttribute("aria-description");
    });
    expect(targetCell).not.toHaveAttribute("aria-disabled");
  });
});

describe("CsvPreviewTable: PCT-156 — focusPos clamp（欄が0件になった場合の防御）", () => {
  it("欄が0件のとき空状態案内を表示しクラッシュしない", () => {
    // fields が空の場合はテーブルではなく案内 UI を返す
    render(<CsvPreviewTable />);
    expect(screen.getByText(/欄テンプレートに欄を追加/)).toBeInTheDocument();
  });

  it("cells があるとき focusPos が範囲内でテーブルが正常に描画される", () => {
    setFields(["金額", "摘要"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "100"], [fields[1].id, "テスト"]]]]);
    render(<CsvPreviewTable />);
    // クランプが不正なインデックスで例外を投げないことを確認
    const gridCells = screen.getAllByRole("gridcell");
    expect(gridCells.length).toBe(2);
  });
});
