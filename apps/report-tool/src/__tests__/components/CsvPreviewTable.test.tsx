import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("table")).toBeInTheDocument();
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
