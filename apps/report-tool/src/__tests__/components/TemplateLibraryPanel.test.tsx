import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TemplateLibraryPanel from "../../components/TemplateLibraryPanel";
import { useReportStore } from "../../store/reportStore";
import { useTemplateLibraryStore } from "../../store/templateLibraryStore";
import type { TemplateSummary } from "../../lib/templateStorage";

function summary(overrides?: Partial<TemplateSummary>): TemplateSummary {
  return {
    id: "tpl-1",
    name: "見積書テンプレ",
    savedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    readable: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });

  // templateLibraryStore は実 zustand ストア。refreshList/saveAs/load/remove/rename は
  // 実 Tauri invoke に依存するため、CsvExportButton の onSave 注入・OcrRunPanel の
  // ocrHook 注入と同じ発想で setState によりアクションをモックに差し替える。
  useTemplateLibraryStore.setState({
    summaries: [],
    status: "idle",
    error: null,
    refreshList: vi.fn().mockResolvedValue(undefined),
    saveAs: vi.fn(),
    load: vi.fn().mockResolvedValue({ status: "loaded" }),
    remove: vi.fn().mockResolvedValue({ status: "removed" }),
    rename: vi.fn().mockResolvedValue({ status: "renamed", id: "tpl-1" }),
  });

  vi.spyOn(window, "confirm").mockReturnValue(true);
});

function addField(name: string) {
  useReportStore.getState().addField({ x: 0, y: 0, width: 100, height: 30 }, name);
}

describe("TemplateLibraryPanel: マウント", () => {
  it("マウント時に refreshList が呼ばれる", () => {
    render(<TemplateLibraryPanel />);
    expect(useTemplateLibraryStore.getState().refreshList).toHaveBeenCalledTimes(1);
  });

  it("一覧が空のとき空状態メッセージを表示する", () => {
    render(<TemplateLibraryPanel />);
    expect(screen.getByText(/保存済みテンプレートはありません/)).toBeInTheDocument();
  });
});

describe("TemplateLibraryPanel: 保存", () => {
  it("欄が0件のとき保存ボタンが無効になる", () => {
    render(<TemplateLibraryPanel />);
    expect(
      screen.getByRole("button", { name: "現在の欄をテンプレとして保存" })
    ).toBeDisabled();
  });

  it("欄があれば保存ボタンが有効になる", () => {
    addField("金額");
    render(<TemplateLibraryPanel />);
    expect(
      screen.getByRole("button", { name: "現在の欄をテンプレとして保存" })
    ).toBeEnabled();
  });

  it("保存ボタン押下で名前入力フォームが開く", () => {
    addField("金額");
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    expect(screen.getByRole("textbox", { name: "テンプレート名を入力" })).toBeInTheDocument();
  });

  it("同名保存で conflict が返るとconfirmを経由し、OKなら overwriteId 付きで再保存する", async () => {
    addField("金額");
    const mockSaveAs = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict", existingId: "existing-id" })
      .mockResolvedValueOnce({ status: "saved", id: "existing-id" });
    useTemplateLibraryStore.setState({ saveAs: mockSaveAs });

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    fireEvent.change(screen.getByRole("textbox", { name: "テンプレート名を入力" }), {
      target: { value: "見積書" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレート保存を確定" }));

    await waitFor(() => expect(mockSaveAs).toHaveBeenCalledTimes(2));

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("同名テンプレ")
    );
    expect(mockSaveAs.mock.calls[0][0]).toBe("見積書");
    expect(mockSaveAs.mock.calls[0][2]).toBeUndefined();
    expect(mockSaveAs.mock.calls[1][0]).toBe("見積書");
    expect(mockSaveAs.mock.calls[1][2]).toBe("existing-id");

    // 保存成功後はフォームが閉じる
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "テンプレート名を入力" })
      ).not.toBeInTheDocument();
    });
  });

  it("同名保存で conflict が返り、確認をキャンセルすると上書き保存されない", async () => {
    addField("金額");
    const mockSaveAs = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict", existingId: "existing-id" });
    useTemplateLibraryStore.setState({ saveAs: mockSaveAs });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    fireEvent.change(screen.getByRole("textbox", { name: "テンプレート名を入力" }), {
      target: { value: "見積書" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレート保存を確定" }));

    await waitFor(() => expect(mockSaveAs).toHaveBeenCalledTimes(1));
    expect(mockSaveAs).toHaveBeenCalledTimes(1);
    // フォームは開いたまま
    expect(screen.getByRole("textbox", { name: "テンプレート名を入力" })).toBeInTheDocument();
  });

  it("保存失敗時はエラーメッセージを表示する", async () => {
    addField("金額");
    const mockSaveAs = vi.fn().mockResolvedValue({ status: "error", reason: "保存に失敗しました" });
    useTemplateLibraryStore.setState({ saveAs: mockSaveAs });

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    fireEvent.change(screen.getByRole("textbox", { name: "テンプレート名を入力" }), {
      target: { value: "見積書" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレート保存を確定" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("保存に失敗しました");
    });
  });

  it("名前未入力のまま保存を押すとエラー表示され saveAs は呼ばれない", async () => {
    addField("金額");
    const mockSaveAs = vi.fn();
    useTemplateLibraryStore.setState({ saveAs: mockSaveAs });

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    fireEvent.click(screen.getByRole("button", { name: "テンプレート保存を確定" }));

    expect(screen.getByRole("alert")).toHaveTextContent("テンプレート名を入力してください");
    expect(mockSaveAs).not.toHaveBeenCalled();
  });

  it("キャンセルボタンでフォームが閉じる", () => {
    addField("金額");
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "現在の欄をテンプレとして保存" }));
    fireEvent.click(screen.getByRole("button", { name: "テンプレート保存をキャンセル" }));
    expect(
      screen.queryByRole("textbox", { name: "テンプレート名を入力" })
    ).not.toBeInTheDocument();
  });
});

describe("TemplateLibraryPanel: 一覧・読込", () => {
  it("summaries が一覧表示される", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ name: "テンプレA" })] });
    render(<TemplateLibraryPanel />);
    expect(screen.getByText("テンプレA")).toBeInTheDocument();
  });

  it("cells が空のときは確認なしで load が呼ばれる", async () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "テンプレA" })] });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "テンプレA を読み込む" }));

    await waitFor(() => {
      expect(useTemplateLibraryStore.getState().load).toHaveBeenCalledWith("t1");
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("cells が非空のとき確認ダイアログを経由してから load が呼ばれる", async () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "テンプレA" })] });
    useReportStore.setState({ cells: new Map([[1, [new Map([["field-1", "値"]])]]]) });

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "テンプレA を読み込む" }));

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("破棄されます")
    );
    await waitFor(() => {
      expect(useTemplateLibraryStore.getState().load).toHaveBeenCalledWith("t1");
    });
  });

  it("確認ダイアログでキャンセルすると load は呼ばれない", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "テンプレA" })] });
    useReportStore.setState({ cells: new Map([[1, [new Map([["field-1", "値"]])]]]) });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "テンプレA を読み込む" }));

    expect(useTemplateLibraryStore.getState().load).not.toHaveBeenCalled();
  });

  it("readable:false の行は選択不可で「読み込めません」と表示される", () => {
    useTemplateLibraryStore.setState({
      summaries: [summary({ id: "t2", name: "壊れテンプレ", readable: false })],
    });
    render(<TemplateLibraryPanel />);
    const btn = screen.getByRole("button", { name: "壊れテンプレ（読み込めません）" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/読み込めません/)).toBeInTheDocument();
  });

  it("readable:false の行をクリックしても load は呼ばれない", () => {
    useTemplateLibraryStore.setState({
      summaries: [summary({ id: "t2", name: "壊れテンプレ", readable: false })],
    });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "壊れテンプレ（読み込めません）" }));
    expect(useTemplateLibraryStore.getState().load).not.toHaveBeenCalled();
  });

  // #449 / PCT-213: テンプレ多重クリックで後着の古い読込が適用される事故のUI側防御。
  // status="loading" 中は一覧ボタンを無効化し、そもそも多重クリックできないようにする。
  it("status=loading のとき読込ボタンが無効になる（多重クリック防止）", () => {
    useTemplateLibraryStore.setState({
      summaries: [summary({ id: "t1", name: "テンプレA" })],
      status: "loading",
    });
    render(<TemplateLibraryPanel />);
    expect(screen.getByRole("button", { name: "テンプレA を読み込む" })).toBeDisabled();
  });

  it("status=loading のとき読込ボタンをクリックしても load は呼ばれない", () => {
    useTemplateLibraryStore.setState({
      summaries: [summary({ id: "t1", name: "テンプレA" })],
      status: "loading",
    });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "テンプレA を読み込む" }));
    expect(useTemplateLibraryStore.getState().load).not.toHaveBeenCalled();
  });
});

describe("TemplateLibraryPanel: 削除", () => {
  it("削除ボタン押下で確認ダイアログを経由してから remove が呼ばれる", async () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "テンプレA" })] });
    render(<TemplateLibraryPanel />);

    fireEvent.click(screen.getByRole("button", { name: "テンプレA を削除" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("削除しますか"));
    await waitFor(() => {
      expect(useTemplateLibraryStore.getState().remove).toHaveBeenCalledWith("t1");
    });
  });

  it("確認ダイアログでキャンセルすると remove は呼ばれない", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "テンプレA" })] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TemplateLibraryPanel />);

    fireEvent.click(screen.getByRole("button", { name: "テンプレA を削除" }));

    expect(useTemplateLibraryStore.getState().remove).not.toHaveBeenCalled();
  });
});

describe("TemplateLibraryPanel: 改名", () => {
  it("改名ボタンでインライン編集に入る", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "旧名テンプレ" })] });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    expect(
      screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" })
    ).toBeInTheDocument();
  });

  it("Enter で改名が確定し rename が呼ばれる", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "旧名テンプレ" })] });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    const input = screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" });
    fireEvent.change(input, { target: { value: "新名テンプレ" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTemplateLibraryStore.getState().rename).toHaveBeenCalledWith(
      "t1",
      "新名テンプレ",
      expect.any(String)
    );
  });

  it("Escape で改名をキャンセルすると rename は呼ばれない", () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "旧名テンプレ" })] });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    const input = screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" });
    fireEvent.change(input, { target: { value: "変更後" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useTemplateLibraryStore.getState().rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("rename 失敗時は store.error 経由でエラーバナーが表示される（P2）", async () => {
    useTemplateLibraryStore.setState({
      summaries: [summary({ id: "t1", name: "旧名テンプレ" })],
      rename: vi.fn().mockImplementation(async () => {
        useTemplateLibraryStore.setState({ status: "error", error: "改名に失敗しました" });
        return { status: "error", reason: "改名に失敗しました" };
      }),
    });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    const input = screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" });
    fireEvent.change(input, { target: { value: "新名テンプレ" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("改名に失敗しました");
    });
  });

  it("commitRename は rename の完了を await する（戻り値を破棄しない・P2）", async () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "旧名テンプレ" })] });
    let resolveRename: (v: { status: "renamed"; id: string }) => void = () => {};
    const mockRename = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRename = resolve;
        })
    );
    useTemplateLibraryStore.setState({ rename: mockRename });

    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    const input = screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" });
    fireEvent.change(input, { target: { value: "新名テンプレ" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mockRename).toHaveBeenCalledTimes(1));
    resolveRename({ status: "renamed", id: "t1" });
  });

  it("Enter 改名確定後の onBlur 再発火で rename が二重に呼ばれない（P3a）", async () => {
    useTemplateLibraryStore.setState({ summaries: [summary({ id: "t1", name: "旧名テンプレ" })] });
    render(<TemplateLibraryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "旧名テンプレ の名前を変更" }));
    const input = screen.getByRole("textbox", { name: "旧名テンプレ の名前を編集" });
    fireEvent.change(input, { target: { value: "新名テンプレ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Enter コミット後も input 要素自体への onBlur 再発火をシミュレートする
    fireEvent.blur(input);

    await waitFor(() => {
      expect(useTemplateLibraryStore.getState().rename).toHaveBeenCalledTimes(1);
    });
  });
});

describe("TemplateLibraryPanel: ローディング/エラー表示", () => {
  it("status=loading のとき読み込み中表示になる", () => {
    useTemplateLibraryStore.setState({ status: "loading" });
    render(<TemplateLibraryPanel />);
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it("status=error のとき一覧取得エラーを表示する", () => {
    useTemplateLibraryStore.setState({ status: "error", error: "一覧の取得に失敗しました" });
    render(<TemplateLibraryPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("一覧の取得に失敗しました");
  });
});
