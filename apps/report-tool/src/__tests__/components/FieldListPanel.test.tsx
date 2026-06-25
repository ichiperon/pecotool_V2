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

  it("「＋ 欄を追加」ボタンが表示される", () => {
    render(<FieldListPanel />);
    expect(screen.getByRole("button", { name: /欄を追加/ })).toBeInTheDocument();
  });

  it("追加ボタンをクリックすると欄が 1 件増える", () => {
    render(<FieldListPanel />);
    const addBtn = screen.getByRole("button", { name: /欄を追加/ });
    fireEvent.click(addBtn);
    expect(useReportStore.getState().template.fields).toHaveLength(1);
  });

  it("追加後に欄名がリストに表示される", () => {
    render(<FieldListPanel />);
    fireEvent.click(screen.getByRole("button", { name: /欄を追加/ }));
    // 自動命名「欄 1」が表示される（aria-label の完全一致でピンポイントに取得）
    expect(
      screen.getByRole("button", { name: "欄 1（クリックで名前を編集）" })
    ).toBeInTheDocument();
  });

  it("複数回追加すると複数行が表示される", () => {
    render(<FieldListPanel />);
    const addBtn = screen.getByRole("button", { name: /欄を追加/ });
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    expect(useReportStore.getState().template.fields).toHaveLength(3);
    // 空状態メッセージは消える
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
    // 編集UIが閉じる
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
});
