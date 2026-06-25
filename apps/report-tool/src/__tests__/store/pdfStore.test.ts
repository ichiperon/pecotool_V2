import { describe, it, expect, beforeEach } from "vitest";
import { usePdfStore } from "../../store/pdfStore";

beforeEach(() => {
  usePdfStore.getState().reset();
});

describe("pdfStore", () => {
  it("初期状態: filePath=null, numPages=0, currentPage=1, zoom=100", () => {
    const s = usePdfStore.getState();
    expect(s.filePath).toBeNull();
    expect(s.numPages).toBe(0);
    expect(s.currentPage).toBe(1);
    expect(s.zoom).toBe(100);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("setPdf: filePath と numPages が設定され currentPage が 1 にリセットされる", () => {
    usePdfStore.getState().setCurrentPage(3);
    usePdfStore.getState().setPdf("/path/to/test.pdf", 10);
    const s = usePdfStore.getState();
    expect(s.filePath).toBe("/path/to/test.pdf");
    expect(s.numPages).toBe(10);
    expect(s.currentPage).toBe(1);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("setCurrentPage: 1〜numPages の範囲にクランプされる", () => {
    usePdfStore.getState().setPdf("/test.pdf", 5);
    usePdfStore.getState().setCurrentPage(3);
    expect(usePdfStore.getState().currentPage).toBe(3);

    usePdfStore.getState().setCurrentPage(0);
    expect(usePdfStore.getState().currentPage).toBe(1);

    usePdfStore.getState().setCurrentPage(99);
    expect(usePdfStore.getState().currentPage).toBe(5);
  });

  it("setCurrentPage: numPages=0 のときは何も変わらない", () => {
    usePdfStore.getState().setCurrentPage(3);
    expect(usePdfStore.getState().currentPage).toBe(1);
  });

  it("goToPrevPage: currentPage > 1 のとき 1 減る", () => {
    usePdfStore.getState().setPdf("/test.pdf", 5);
    usePdfStore.getState().setCurrentPage(3);
    usePdfStore.getState().goToPrevPage();
    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("goToPrevPage: currentPage=1 のとき 1 未満にならない", () => {
    usePdfStore.getState().setPdf("/test.pdf", 5);
    usePdfStore.getState().goToPrevPage();
    expect(usePdfStore.getState().currentPage).toBe(1);
  });

  it("goToNextPage: currentPage < numPages のとき 1 増える", () => {
    usePdfStore.getState().setPdf("/test.pdf", 5);
    usePdfStore.getState().setCurrentPage(4);
    usePdfStore.getState().goToNextPage();
    expect(usePdfStore.getState().currentPage).toBe(5);
  });

  it("goToNextPage: currentPage=numPages のとき超えない", () => {
    usePdfStore.getState().setPdf("/test.pdf", 5);
    usePdfStore.getState().setCurrentPage(5);
    usePdfStore.getState().goToNextPage();
    expect(usePdfStore.getState().currentPage).toBe(5);
  });

  it("setZoom: 25〜400 の範囲にクランプされる", () => {
    usePdfStore.getState().setZoom(200);
    expect(usePdfStore.getState().zoom).toBe(200);

    usePdfStore.getState().setZoom(10);
    expect(usePdfStore.getState().zoom).toBe(25);

    usePdfStore.getState().setZoom(500);
    expect(usePdfStore.getState().zoom).toBe(400);
  });

  it("setLoading: isLoading フラグが切り替わる", () => {
    usePdfStore.getState().setLoading(true);
    expect(usePdfStore.getState().isLoading).toBe(true);

    usePdfStore.getState().setLoading(false);
    expect(usePdfStore.getState().isLoading).toBe(false);
  });

  it("setError: error が設定され isLoading が false になる", () => {
    usePdfStore.getState().setLoading(true);
    usePdfStore.getState().setError("失敗しました");
    const s = usePdfStore.getState();
    expect(s.error).toBe("失敗しました");
    expect(s.isLoading).toBe(false);
  });

  it("reset: すべての状態が初期値に戻る", () => {
    usePdfStore.getState().setPdf("/test.pdf", 10);
    usePdfStore.getState().setCurrentPage(5);
    usePdfStore.getState().setZoom(200);
    usePdfStore.getState().setError("テストエラー");

    usePdfStore.getState().reset();
    const s = usePdfStore.getState();
    expect(s.filePath).toBeNull();
    expect(s.numPages).toBe(0);
    expect(s.currentPage).toBe(1);
    expect(s.zoom).toBe(100);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });
});
