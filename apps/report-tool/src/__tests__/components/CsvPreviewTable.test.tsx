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
  // 新形: Map<number, ReportRow[]> — 各ページを 1 段配列として設定
  const matrix: Map<number, Map<string, string>[]> = new Map();
  for (const [page, pairs] of entries) {
    matrix.set(page, [new Map(pairs)]);
  }
  useReportStore.getState().setCells(matrix);
}

/** 複数段を持つページを設定するヘルパー */
function setCellsMultiRow(
  entries: [number, [string, string][][]][]
) {
  const matrix: Map<number, Map<string, string>[]> = new Map();
  for (const [page, rows] of entries) {
    matrix.set(page, rows.map((pairs) => new Map(pairs)));
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
    const clearBtn = screen.getByRole("button", { name: /1ページ目 段1 金額 を削除/ });
    fireEvent.click(clearBtn);
    const firstContent = liveRegion!.textContent;
    expect(firstContent).toContain("1ページ目 金額 を削除しました");

    // 値を復元して2回目削除
    act(() => {
      useReportStore.getState().setCellValue(1, fields[0].id, "2000");
    });

    const clearBtn2 = screen.getByRole("button", { name: /1ページ目 段1 金額 を削除/ });
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
    render(<CsvPreviewTable />);
    expect(screen.getByText(/欄テンプレートに欄を追加/)).toBeInTheDocument();
  });

  it("cells があるとき focusPos が範囲内でテーブルが正常に描画される", () => {
    setFields(["金額", "摘要"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "100"], [fields[1].id, "テスト"]]]]);
    render(<CsvPreviewTable />);
    const gridCells = screen.getAllByRole("gridcell");
    expect(gridCells.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 段グリッド（明細行 MVP）テスト
// ---------------------------------------------------------------------------

describe("CsvPreviewTable: 段グリッド — 複数段の描画", () => {
  it("1ページに2段ある場合、2つの tr が描画される（ヘッダ除く）", () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCellsMultiRow([
      [1, [[[fields[0].id, "A"]], [[fields[0].id, "B"]]]],
    ]);
    render(<CsvPreviewTable />);
    const rows = screen.getAllByRole("row");
    // ヘッダ1行 + データ2行
    expect(rows.length).toBe(3);
  });

  it("段番号列ヘッダ「段」が表示される", () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "テスト"]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("段")).toBeInTheDocument();
  });

  it("2段ある場合に段番号 1・2 が表示される", () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCellsMultiRow([
      [1, [[[fields[0].id, "A"]], [[fields[0].id, "B"]]]],
    ]);
    render(<CsvPreviewTable />);
    // rowheader の "1" と "2" が段番号セルとして存在する
    const rowHeaders = screen.getAllByRole("rowheader");
    const texts = rowHeaders.map((el) => el.textContent?.trim());
    expect(texts).toContain("1");
    expect(texts).toContain("2");
  });

  it("固定欄は2段目以降に〃が表示される", () => {
    // isLineItem=false の欄（デフォルト）
    setFields(["件名"]);
    const fields = useReportStore.getState().template.fields;
    setCellsMultiRow([
      [1, [[[fields[0].id, "固定値"]], [[fields[0].id, "行2値"]]]],
    ]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("〃")).toBeInTheDocument();
  });

  it("明細欄は各段で独立した値が表示される", () => {
    // isLineItem=true に設定
    useReportStore.getState().addField(SAMPLE_RECT, "明細品名");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setFieldLineItem(fields[0].id, true);
    setCellsMultiRow([
      [1, [[[fields[0].id, "商品A"]], [[fields[0].id, "商品B"]]]],
    ]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("商品A")).toBeInTheDocument();
    expect(screen.getByText("商品B")).toBeInTheDocument();
    // 〃は表示されない
    expect(screen.queryByText("〃")).not.toBeInTheDocument();
  });

  it("明細欄ヘッダに「明細」ピルが表示される", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "明細欄テスト");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setFieldLineItem(fields[0].id, true);
    setCells([[1, [[fields[0].id, "値"]]]]);
    render(<CsvPreviewTable />);
    expect(screen.getByText("明細")).toBeInTheDocument();
  });

  it("固定欄ヘッダに「明細」ピルは表示されない", () => {
    setFields(["固定欄テスト"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "値"]]]]);
    render(<CsvPreviewTable />);
    // isLineItem=false なのでピルなし
    expect(screen.queryByText("明細")).not.toBeInTheDocument();
  });
});

describe("CsvPreviewTable: 段グリッド — Alt+ArrowDown で段挿入", () => {
  it("Alt+ArrowDown で直下に空段が挿入される", async () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "A"]]]]);
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    fireEvent.keyDown(cells[0], { key: "ArrowDown", altKey: true });

    await waitFor(() => {
      const rows = useReportStore.getState().cells.get(1)!;
      expect(rows).toHaveLength(2);
    });
  });

  it("Alt+ArrowDown で aria-live に挿入アナウンスが出る", async () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "A"]]]]);
    render(<CsvPreviewTable />);

    const liveRegion = document.querySelector("[aria-live]");
    const cells = screen.getAllByRole("gridcell");
    fireEvent.keyDown(cells[0], { key: "ArrowDown", altKey: true });

    await waitFor(() => {
      expect(liveRegion!.textContent).toContain("挿入しました");
    });
  });
});

describe("CsvPreviewTable: 段グリッド — Alt+Delete で段削除", () => {
  it("Alt+Delete で段が削除される（2段以上のとき）", async () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCellsMultiRow([
      [1, [[[fields[0].id, "A"]], [[fields[0].id, "B"]]]],
    ]);
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    // 1段目のセルにフォーカスして Alt+Delete
    fireEvent.keyDown(cells[0], { key: "Delete", altKey: true });

    await waitFor(() => {
      const rows = useReportStore.getState().cells.get(1)!;
      expect(rows).toHaveLength(1);
    });
  });

  it("最終1段のとき Alt+Delete は no-op で aria-live に保護メッセージ", async () => {
    setFields(["品名"]);
    const fields = useReportStore.getState().template.fields;
    setCells([[1, [[fields[0].id, "A"]]]]);
    render(<CsvPreviewTable />);

    const liveRegion = document.querySelector("[aria-live]");
    const cells = screen.getAllByRole("gridcell");
    fireEvent.keyDown(cells[0], { key: "Delete", altKey: true });

    await waitFor(() => {
      expect(liveRegion!.textContent).toContain("最後の段は削除できません");
    });

    // store に変化なし
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(1);
  });
});

describe("CsvPreviewTable: 段グリッド — Ctrl+Enter 逐次分割", () => {
  it("明細欄で Ctrl+Enter (カーソル中間) で逐次分割される", async () => {
    useReportStore.getState().addField(SAMPLE_RECT, "品名");
    const fields = useReportStore.getState().template.fields;
    useReportStore.getState().setFieldLineItem(fields[0].id, true);
    setCells([[1, [[fields[0].id, "ABCDE"]]]]);
    render(<CsvPreviewTable />);

    // 編集開始（ダブルクリック）
    const cells = screen.getAllByRole("gridcell");
    fireEvent.doubleClick(cells[0]);

    // textarea が出ることを確認
    const textarea = await screen.findByRole("textbox");
    expect(textarea.tagName).toBe("TEXTAREA");

    // カーソルを3文字目に置いて Ctrl+Enter
    Object.defineProperty(textarea, "selectionStart", { value: 3, configurable: true });
    Object.defineProperty(textarea, "selectionEnd", { value: 3, configurable: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      const rows = useReportStore.getState().cells.get(1)!;
      expect(rows).toHaveLength(2);
    });
  });

  it("固定欄で Ctrl+Enter は段分割されない（入力として無視）", async () => {
    setFields(["固定欄"]);
    const fields = useReportStore.getState().template.fields;
    // isLineItem=false
    setCells([[1, [[fields[0].id, "ABC"]]]]);
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    fireEvent.doubleClick(cells[0]);

    const input = await screen.findByRole("textbox");
    expect(input.tagName).toBe("INPUT");

    // Ctrl+Enter は input のキーダウンハンドラに届かない（textarea のみ処理）
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    // 段は増えない
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows).toHaveLength(1);
  });
});

describe("CsvPreviewTable: 段グリッド — ドラッグの rowIndex 対応", () => {
  it("同一段内でドラッグすると正しい rowIndex で moveCellValue が呼ばれる", async () => {
    setFields(["品名", "金額"]);
    const fields = useReportStore.getState().template.fields;
    setCellsMultiRow([
      [1, [
        [[fields[0].id, "商品A"], [fields[1].id, "1000"]],
        [[fields[0].id, "商品B"], [fields[1].id, "2000"]],
      ]],
    ]);
    render(<CsvPreviewTable />);

    const cells = screen.getAllByRole("gridcell");
    // cells[0]=p1/row0/品名, cells[1]=p1/row0/金額
    // cells[2]=p1/row1/品名, cells[3]=p1/row1/金額
    const sourceCell = cells[0]; // row0 の品名

    // ドラッグ開始
    fireEvent.pointerDown(sourceCell, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(sourceCell, { clientX: 20, clientY: 10, pointerId: 1 });

    // ドラッグ中: row0 内の別セルへ
    await waitFor(() => {
      // ドラッグが開始されると dragSource が設定される
      expect(sourceCell).toHaveClass("csv-preview__td--drag-source");
    });

    fireEvent.pointerUp(sourceCell, { clientX: 20, clientY: 10, pointerId: 1 });

    // row1 の値は変化しない（row0 内ドラッグ完結のため）
    const rows = useReportStore.getState().cells.get(1)!;
    expect(rows[1].get(fields[0].id)).toBe("商品B");
    expect(rows[1].get(fields[1].id)).toBe("2000");
  });
});

// ========== OCR 低信頼セル強調 ==========

describe("CsvPreviewTable: --low-confidence クラス", () => {
  function setupWithConfidences(
    fieldName: string,
    cellValue: string,
    confidence: number | undefined
  ) {
    setFields([fieldName]);
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, Map<string, string>[]> = new Map([
      [1, [new Map([[fieldId, cellValue]])]],
    ]);
    // setCells は confidences をクリアするので先に呼ぶ
    useReportStore.getState().setCells(matrix);
    if (confidence !== undefined) {
      const confMatrix: Map<number, Array<Map<string, number>>> = new Map([
        [1, [new Map([[fieldId, confidence]])]],
      ]);
      useReportStore.getState().setConfidences(confMatrix);
    }
    return fieldId;
  }

  it("confidence <= 0.5 の非空セルに --low-confidence クラスが付く", () => {
    const fieldId = setupWithConfidences("金額", "1000", 0.5);
    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    expect(cells[0]).toHaveClass("csv-preview__td--low-confidence");
  });

  it("confidence = 0.3 (最低値) でも --low-confidence クラスが付く", () => {
    const fieldId = setupWithConfidences("金額", "500", 0.3);
    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    expect(cells[0]).toHaveClass("csv-preview__td--low-confidence");
  });

  it("confidence = 0.9 (高信頼) のとき --low-confidence クラスが付かない", () => {
    const fieldId = setupWithConfidences("金額", "2000", 0.9);
    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    expect(cells[0]).not.toHaveClass("csv-preview__td--low-confidence");
  });

  it("confidence が undefined (手入力セル) のとき --low-confidence クラスが付かない", () => {
    const fieldId = setupWithConfidences("金額", "手入力値", undefined);
    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    expect(cells[0]).not.toHaveClass("csv-preview__td--low-confidence");
  });

  it("空セル (isEmpty=true) は --low-confidence クラスが付かない", () => {
    const fieldId = setupWithConfidences("金額", "", 0.3);
    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    expect(cells[0]).not.toHaveClass("csv-preview__td--low-confidence");
  });

  it("〃セル (isDittoCell) は --low-confidence クラスが付かない", () => {
    // 固定欄（isLineItem=false）で多段: 2段目以降は〃セル
    setFields(["固定欄"]);
    const fieldId = useReportStore.getState().template.fields[0].id;
    const matrix: Map<number, Map<string, string>[]> = new Map([
      [1, [
        new Map([[fieldId, "値A"]]),
        new Map([[fieldId, "値B"]]), // 2段目は〃セルになる（固定欄）
      ]],
    ]);
    useReportStore.getState().setCells(matrix);
    const confMatrix: Map<number, Array<Map<string, number>>> = new Map([
      [1, [
        new Map([[fieldId, 0.3]]),
        new Map([[fieldId, 0.3]]), // 2段目にも低信頼を設定
      ]],
    ]);
    useReportStore.getState().setConfidences(confMatrix);

    render(<CsvPreviewTable />);
    const cells = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
    // cells[0]: 先頭段（〃でない、low-confidenceが付く）
    expect(cells[0]).toHaveClass("csv-preview__td--low-confidence");
    // cells[1]: 2段目（〃セル、low-confidenceが付かない）
    expect(cells[1]).not.toHaveClass("csv-preview__td--low-confidence");
  });
});
