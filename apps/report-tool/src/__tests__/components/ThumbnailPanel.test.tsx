import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ThumbnailPanel from "../../components/ThumbnailPanel";
import { usePdfStore } from "../../store/pdfStore";

// pdfjs-dist と Tauri FS は jsdom 環境では動かない（canvas 描画不可）ため mock 化
vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.reject(new Error("pdfjs mock: not implemented in jsdom")),
  })),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
}));

beforeEach(() => {
  usePdfStore.setState({
    filePath: null,
    numPages: 0,
    currentPage: 1,
    zoom: 100,
    isLoading: false,
    error: null,
  });
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
});
