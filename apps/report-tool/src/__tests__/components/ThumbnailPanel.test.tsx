import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ThumbnailPanel from "../../components/ThumbnailPanel";
import { usePdfStore } from "../../store/pdfStore";
import * as pdfjsLib from "pdfjs-dist";
import { renderPageOffscreen } from "../../lib/ocrCrop";

// pdfjs-dist と Tauri FS は jsdom 環境では動かない（canvas 描画不可）ため mock 化
vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
}));
// renderPageOffscreen は ocrCrop.ts 側で canvas 実描画に依存するため、
// ThumbnailPanel 単体のロジック（配列構築・index追従・重複呼び出し検証）に限定してモック化する。
vi.mock("../../lib/ocrCrop", () => ({
  renderPageOffscreen: vi.fn(),
}));

/** ページ番号ごとに一意な dataUrl を返す fake canvas。重複生成検知の目印にする。 */
function makeFakeCanvas(pageNumber: number) {
  return {
    toDataURL: vi.fn(() => `data:image/jpeg;base64,PAGE${pageNumber}`),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

function makeFakePdfDoc() {
  return { destroy: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  usePdfStore.setState({
    filePath: null,
    numPages: 0,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });

  // 既定は従来どおり「pdfjs 読み込み失敗 → 空のまま」に揃える（既存3テストの前提を保つ）。
  // mockImplementation で遅延生成にする（mockReturnValue だと reject 済み Promise を
  // beforeEach 実行時点で即時生成してしまい、後段で上書きされて未消費のまま残ると
  // Unhandled Rejection になるため）。
  vi.mocked(pdfjsLib.getDocument).mockReset();
  vi.mocked(pdfjsLib.getDocument).mockImplementation(
    () =>
      ({
        promise: Promise.reject(new Error("pdfjs mock: not implemented in jsdom")),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
  );

  vi.mocked(renderPageOffscreen).mockReset();
  vi.mocked(renderPageOffscreen).mockImplementation(async (_doc, pageNumber: number) => ({
    canvas: makeFakeCanvas(pageNumber),
    pageWidth: 100,
    pageHeight: 100,
  }));
});

describe("ThumbnailPanel", () => {
  it("filePath が null のとき空状態メッセージを表示する", () => {
    render(<ThumbnailPanel />);
    expect(screen.getByText("PDF 未読込")).toBeInTheDocument();
    expect(screen.getByText(/PDF を開くとサムネイルが表示されます/)).toBeInTheDocument();
  });

  it("filePath が null のとき aria-label が 'サムネイル' の領域は表示されない", () => {
    render(<ThumbnailPanel />);
    // サムネイルリストが存在しないこと
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("filePath がある場合、ローディング状態になる（pdfjs が mock エラーで終了後に非ローディング）", async () => {
    usePdfStore.setState({
      filePath: "/path/to/test.pdf",
      numPages: 3,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });

    // jsdom では canvas 描画不可でエラーになり、
    // catch で空のまま setIsLoading(false) になる
    render(<ThumbnailPanel />);
    // 読み込み直後はローディング表示
    // (非同期完了後は空になる)
    // 少なくともクラッシュしないことを確認
    expect(document.body).toBeTruthy();
  });

  it("filePath がある状態でページ移動ボタンが表示されない（サムネイル描画失敗 = 空リスト）", async () => {
    usePdfStore.setState({
      filePath: "/path/to/test.pdf",
      numPages: 2,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });

    const { unmount } = render(<ThumbnailPanel />);

    // pdfjs mock がエラーを投げるので thumbnails は空になる
    // ボタンが存在しないことを確認
    await vi.waitFor(() => {
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    unmount();
  });

  describe("PDF読み込み成功時のサムネイル配列構築（renderPageOffscreen をモックして成功経路を検証）", () => {
    it("numPages 分のサムネイルが順番どおりに表示される", async () => {
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve(makeFakePdfDoc()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      usePdfStore.setState({
        filePath: "/success.pdf",
        numPages: 3,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(3);
      });

      const labels = screen.getAllByRole("button", { name: /^\d+ ページ目/ }).map((btn) => btn.getAttribute("aria-label"));
      expect(labels).toEqual(["1 ページ目", "2 ページ目", "3 ページ目"]);
    });

    it("renderPageOffscreen は各ページにつき1回だけ呼ばれる（#429 サムネ重複生成の回帰）", async () => {
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve(makeFakePdfDoc()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      usePdfStore.setState({
        filePath: "/dup.pdf",
        numPages: 3,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(3);
      });

      expect(renderPageOffscreen).toHaveBeenCalledTimes(3);
      const calledPages = vi.mocked(renderPageOffscreen).mock.calls.map((c) => c[1]);
      expect(calledPages).toEqual([1, 2, 3]);
    });

    it("サムネイルクリックで currentPage ストアが更新され、選択中ボタンに aria-current が反映される", async () => {
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve(makeFakePdfDoc()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      usePdfStore.setState({
        filePath: "/click.pdf",
        numPages: 3,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(3);
      });

      const btn2 = screen.getByLabelText("2 ページ目");
      fireEvent.click(btn2);

      expect(usePdfStore.getState().currentPage).toBe(2);
      expect(btn2.getAttribute("aria-current")).toBe("true");
    });

    it("アンマウント時に pdfDoc が破棄される（L122-123 unmount cleanup の回帰）", async () => {
      const fakeDoc = makeFakePdfDoc();
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve(fakeDoc),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      usePdfStore.setState({
        filePath: "/unmount.pdf",
        numPages: 2,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      const { unmount } = render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(2);
      });

      unmount();

      expect(fakeDoc.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe("PDF差替（別PDFロード）時の state 残留・index追従（PCT-200 MA-1 回帰）", () => {
    it("旧ページ分のサムネイルが残らず新しいページ数で再構築される", async () => {
      const fakeDocA = makeFakePdfDoc();
      const fakeDocB = makeFakePdfDoc();
      vi.mocked(pdfjsLib.getDocument)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocA) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocB) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >);

      usePdfStore.setState({
        filePath: "/a.pdf",
        numPages: 5,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(5);
      });

      act(() => {
        usePdfStore.setState({ filePath: "/b.pdf", numPages: 2, currentPage: 1 });
      });

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(2);
      });

      const labels = screen.getAllByRole("button", { name: /^\d+ ページ目/ }).map((btn) => btn.getAttribute("aria-label"));
      // 旧PDFの3〜5ページ目のサムネイルが残留していないこと
      expect(labels).toEqual(["1 ページ目", "2 ページ目"]);
    });

    it("差替でページ数が減った場合、範囲外になった旧 currentPage はどのサムネイルも選択状態にせずクラッシュしない", async () => {
      const fakeDocA = makeFakePdfDoc();
      const fakeDocB = makeFakePdfDoc();
      vi.mocked(pdfjsLib.getDocument)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocA) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocB) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >);

      usePdfStore.setState({
        filePath: "/a.pdf",
        numPages: 5,
        currentPage: 5,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(5);
      });

      // currentPage は意図的に古い値(5)のまま差替える（store の setPdf を介さない直接更新で
      // 「差替後に index が範囲外のまま取り残される」ケースを再現）
      act(() => {
        usePdfStore.setState({ filePath: "/b.pdf", numPages: 2, currentPage: 5 });
      });

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(2);
      });

      const buttons = screen.getAllByRole("button", { name: /^\d+ ページ目/ });
      expect(buttons.every((b) => b.getAttribute("aria-current") !== "true")).toBe(true);
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
        "1 ページ目",
        "2 ページ目",
      ]);
    });

    it("差替時に旧 pdfDoc が破棄される（差替前ドキュメントのリーク防止）", async () => {
      const fakeDocA = makeFakePdfDoc();
      const fakeDocB = makeFakePdfDoc();
      vi.mocked(pdfjsLib.getDocument)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocA) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocB) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >);

      usePdfStore.setState({
        filePath: "/a.pdf",
        numPages: 2,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(2);
      });

      act(() => {
        usePdfStore.setState({ filePath: "/b.pdf", numPages: 1, currentPage: 1 });
      });

      await vi.waitFor(() => {
        expect(fakeDocA.destroy).toHaveBeenCalledTimes(1);
      });
    });

    it("差替前の読み込みが差替後まで遅延して解決しても、旧docは即破棄されサムネイル配列(新PDFの分)は汚染されない（L54-55 cancelled分岐の回帰）", async () => {
      let resolveOldDoc!: (doc: unknown) => void;
      const oldDeferred = new Promise((resolve) => {
        resolveOldDoc = resolve;
      });
      const fakeDocA = makeFakePdfDoc();
      const fakeDocB = makeFakePdfDoc();

      vi.mocked(pdfjsLib.getDocument)
        .mockReturnValueOnce({ promise: oldDeferred } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >)
        .mockReturnValueOnce({ promise: Promise.resolve(fakeDocB) } as unknown as ReturnType<
          typeof pdfjsLib.getDocument
        >);

      usePdfStore.setState({
        filePath: "/slow-a.pdf",
        numPages: 5,
        currentPage: 1,
        zoom: 100,
        isLoading: false,
        error: null,
      });

      render(<ThumbnailPanel />);

      // 旧ロードが getDocument 呼び出し（readFile 完了後）まで進んだのを確認してから差し替える。
      // すぐ差し替えると旧ロード自身の動的 import が解決する前に新ロードが割り込み、
      // テスト環境の module runner が競合して両ロードとも import すら完了しなくなる
      // （プロダクトコードの不具合ではなくテスト環境固有の制約）。
      await vi.waitFor(() => {
        expect(vi.mocked(pdfjsLib.getDocument)).toHaveBeenCalledTimes(1);
      });

      act(() => {
        usePdfStore.setState({ filePath: "/b.pdf", numPages: 2, currentPage: 1 });
      });

      await vi.waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^\d+ ページ目/ })).toHaveLength(2);
      });

      // ここでようやく旧ロードの getDocument が解決する（読み込み遅延を模す）
      resolveOldDoc(fakeDocA);

      await vi.waitFor(() => {
        expect(fakeDocA.destroy).toHaveBeenCalledTimes(1);
      });

      // 旧ロードの解決後も新PDFのサムネイル配列（2件）のまま、旧ページ分が混入していない
      const labels = screen.getAllByRole("button", { name: /^\d+ ページ目/ }).map((btn) => btn.getAttribute("aria-label"));
      expect(labels).toEqual(["1 ページ目", "2 ページ目"]);
    });
  });
});
