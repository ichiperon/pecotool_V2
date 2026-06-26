import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import FieldListPanel from "../../components/FieldListPanel";
import { useReportStore } from "../../store/reportStore";

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

describe("FieldListPanel", () => {
  it("欄がゼロのとき空状態メッセージを表示する", () => {
    render(<FieldListPanel />);
    expect(screen.getByText(/まだ欄がありません/)).toBeInTheDocument();
  });

  it("「＋ 欄を追加」ボタンが表示される（idle モード）", () => {
    render(<FieldListPanel />);
    expect(screen.getByRole("button", { name: /欄を追加/ })).toBeInTheDocument();
  });

  it("追加ボタンをクリックすると defineField モードになる", () => {
    render(<FieldListPanel />);
    const addBtn = screen.getByRole("button", { name: /欄を追加/ });
    fireEvent.click(addBtn);
    expect(useReportStore.getState().mode).toBe("defineField");
  });

  it("defineField モード中はボタンラベルが「定義中…」に変わる", () => {
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: /欄を追加/ }));
    expect(screen.getByRole("button", { name: /定義中/ })).toBeInTheDocument();
  });

  it("「定義中…」ボタンをクリックすると idle モードに戻る", () => {
    useReportStore.setState({ mode: "defineField" });
    render(<FieldListPanel />);
    const activeBtn = screen.getByRole("button", { name: /定義中/ });
    fireEvent.click(activeBtn);
    expect(useReportStore.getState().mode).toBe("idle");
  });

  it("idle モードのボタンは aria-pressed=false", () => {
    render(<FieldListPanel />);
    const btn = screen.getByRole("button", { name: /欄を追加/ });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("defineField モードのボタンは aria-pressed=true", () => {
    useReportStore.setState({ mode: "defineField" });
    render(<FieldListPanel />);
    const btn = screen.getByRole("button", { name: /定義中/ });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("欄が追加されるとリストに欄名が表示される", () => {
    useReportStore.getState().addField({ x: 10, y: 20, width: 100, height: 30 });
    render(<FieldListPanel />);
    expect(
      screen.getByRole("button", { name: "欄 1（クリックで名前を編集）" })
    ).toBeInTheDocument();
  });

  it("複数欄が追加されると複数行が表示される", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 });
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 });
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 });
    render(<FieldListPanel />);
    expect(useReportStore.getState().template.fields).toHaveLength(3);
    expect(screen.queryByText(/まだ欄がありません/)).not.toBeInTheDocument();
  });

  it("削除ボタンをクリックすると欄が減る", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "削除対象");
    render(<FieldListPanel />);
    const removeBtn = screen.getByRole("button", { name: /削除対象 を削除/ });
    fireEvent.click(removeBtn);
    expect(useReportStore.getState().template.fields).toHaveLength(0);
  });

  it("全欄を削除すると空状態に戻る", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "消す欄");
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: /消す欄 を削除/ }));
    expect(screen.getByText(/まだ欄がありません/)).toBeInTheDocument();
  });

  it("欄名ボタンをクリックするとインライン編集に入る", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "編集前");
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: "編集前（クリックで名前を編集）" }));
    expect(screen.getByRole("textbox", { name: /欄の名前を編集/ })).toBeInTheDocument();
  });

  it("編集後に Enter を押すと renameField が反映される", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "旧名");
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名（クリックで名前を編集）" }));
    const input = screen.getByRole("textbox", { name: /欄の名前を編集/ });
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useReportStore.getState().template.fields[0].name).toBe("新名");
  });

  it("Escape を押すと編集をキャンセルして元の名前に戻る", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "元の名前");
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: "元の名前（クリックで名前を編集）" }));
    const input = screen.getByRole("textbox", { name: /欄の名前を編集/ });
    fireEvent.change(input, { target: { value: "変更後" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useReportStore.getState().template.fields[0].name).toBe("元の名前");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("色チップに aria-label が付いている", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "色付き欄");
    render(<FieldListPanel />);
    expect(
      screen.getByRole("button", { name: /色付き欄 の色を変更/ })
    ).toBeInTheDocument();
  });

  it("削除ボタンに aria-label が付いている", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "ラベル欄");
    render(<FieldListPanel />);
    expect(
      screen.getByRole("button", { name: /ラベル欄 を削除/ })
    ).toBeInTheDocument();
  });

  it("色チップをクリックするとパレットが開く", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "色テスト欄");
    render(<FieldListPanel />);
    const chip = screen.getByRole("button", { name: /色テスト欄 の色を変更/ });
    fireEvent.click(chip);
    expect(screen.getByRole("listbox", { name: /色を選択/ })).toBeInTheDocument();
  });

  it("パレット展開中に Escape を押すとパレットが閉じる", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "Escテスト欄");
    render(<FieldListPanel />);
    const chip = screen.getByRole("button", { name: /Escテスト欄 の色を変更/ });
    fireEvent.click(chip);
    const palette = screen.getByRole("listbox");
    expect(palette).toBeInTheDocument();
    fireEvent.keyDown(palette, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("色チップ（パレット内）の aria-label が連番になっている", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "連番テスト欄");
    render(<FieldListPanel />);
    const chip = screen.getByRole("button", { name: /連番テスト欄 の色を変更/ });
    fireEvent.click(chip);
    expect(screen.getByRole("option", { name: "色 1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "色 2" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "色 8" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^色 #/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 明細欄トグルテスト
// ---------------------------------------------------------------------------

describe("FieldListPanel: 明細欄トグル", () => {
  it("明細欄チェックボックスが表示される", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "品名");
    render(<FieldListPanel />);
    expect(screen.getByRole("checkbox", { name: /品名 を明細欄にする/ })).toBeInTheDocument();
  });

  it("初期状態でチェックボックスは未チェック（固定欄）", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "品名");
    render(<FieldListPanel />);
    const checkbox = screen.getByRole("checkbox", { name: /品名 を明細欄にする/ });
    expect(checkbox).not.toBeChecked();
  });

  it("チェックボックスをONにすると isLineItem が true になる", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "品名");
    render(<FieldListPanel />);
    const checkbox = screen.getByRole("checkbox", { name: /品名 を明細欄にする/ });
    fireEvent.click(checkbox);
    const fields = useReportStore.getState().template.fields;
    expect(fields[0].isLineItem).toBe(true);
  });

  it("チェックボックスをOFFにすると isLineItem が false になる", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "品名");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setFieldLineItem(id, true);
    render(<FieldListPanel />);
    const checkbox = screen.getByRole("checkbox", { name: /品名 を明細欄にする/ });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    const fields = useReportStore.getState().template.fields;
    expect(fields[0].isLineItem).toBe(false);
  });

  it("isLineItem=true の欄は初期レンダでチェックボックスがチェック済み", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "明細品名");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setFieldLineItem(id, true);
    render(<FieldListPanel />);
    const checkbox = screen.getByRole("checkbox", { name: /明細品名 を明細欄にする/ });
    expect(checkbox).toBeChecked();
  });

  it("複数欄があるとき各欄に独立したチェックボックスがある", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "欄A");
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "欄B");
    render(<FieldListPanel />);
    expect(screen.getByRole("checkbox", { name: /欄A を明細欄にする/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /欄B を明細欄にする/ })).toBeInTheDocument();
  });

  it("欄Aをチェックしても欄Bの isLineItem は変わらない", () => {
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "欄A");
    useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, "欄B");
    render(<FieldListPanel />);
    const checkboxA = screen.getByRole("checkbox", { name: /欄A を明細欄にする/ });
    fireEvent.click(checkboxA);
    const fields = useReportStore.getState().template.fields;
    expect(fields[0].isLineItem).toBe(true);
    expect(fields[1].isLineItem).toBeUndefined();
  });
});
