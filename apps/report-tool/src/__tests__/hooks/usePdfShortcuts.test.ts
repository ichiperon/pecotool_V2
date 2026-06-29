import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePdfShortcuts } from "../../hooks/usePdfShortcuts";
import { usePdfStore } from "../../store/pdfStore";
import { useReportStore } from "../../store/reportStore";

beforeEach(() => {
  usePdfStore.getState().reset();
  // テスト用に PDF が読み込まれた状態にする（numPages > 0 でないとページ移動が無効）
  usePdfStore.getState().setPdf("/test.pdf", 5);
  usePdfStore.getState().setCurrentPage(3);
  usePdfStore.getState().setZoom(100);
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * document.body に KeyboardEvent を発火するヘルパー。
 *
 * window.dispatchEvent だと event.target = window になり、
 * jsdom で Element.prototype.closest が呼べずにクラッシュする。
 * document.body 経由にすることで target が HTMLBodyElement になり
 * closest が正常に動作する。
 */
function pressKey(
  key: string,
  options: { ctrlKey?: boolean; metaKey?: boolean } = {}
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
  });
  // bubbles: true なので document.body → window に伝播する
  document.body.dispatchEvent(event);
  return event;
}

describe("usePdfShortcuts: ページ移動", () => {
  it("ArrowDown で次のページに進む", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowDown");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });

  it("PageDown で次のページに進む", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("PageDown");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });

  it("ArrowUp で前のページに戻る", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowUp");
    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("ArrowRight でも次のページに進む", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowRight");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });

  it("ArrowLeft でも前のページに戻る", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowLeft");
    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("PageUp で前のページに戻る", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("PageUp");
    expect(usePdfStore.getState().currentPage).toBe(2);
  });

  it("Home で先頭ページ（1ページ目）に移動する", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("Home");
    expect(usePdfStore.getState().currentPage).toBe(1);
  });

  it("End で末尾ページに移動する", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("End");
    expect(usePdfStore.getState().currentPage).toBe(5);
  });
});

describe("usePdfShortcuts: ズーム操作", () => {
  it("Ctrl+= でズームが 25 上がり fitMode が custom になる", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("=", { ctrlKey: true });
    expect(usePdfStore.getState().zoom).toBe(125);
    expect(usePdfStore.getState().fitMode).toBe("custom");
  });

  it("Ctrl++ でズームが 25 上がる", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("+", { ctrlKey: true });
    expect(usePdfStore.getState().zoom).toBe(125);
    expect(usePdfStore.getState().fitMode).toBe("custom");
  });

  it("Ctrl+- でズームが 25 下がり fitMode が custom になる", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("-", { ctrlKey: true });
    expect(usePdfStore.getState().zoom).toBe(75);
    expect(usePdfStore.getState().fitMode).toBe("custom");
  });

  it("Ctrl+0 で fitMode が width に戻る", () => {
    usePdfStore.getState().setFitMode("custom");
    renderHook(() => usePdfShortcuts());
    pressKey("0", { ctrlKey: true });
    expect(usePdfStore.getState().fitMode).toBe("width");
  });

  it("Meta+= でもズームが上がる（Mac 対応）", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("=", { metaKey: true });
    expect(usePdfStore.getState().zoom).toBe(125);
    expect(usePdfStore.getState().fitMode).toBe("custom");
  });
});

describe("usePdfShortcuts: 編集ガード", () => {
  it("input 要素内では ArrowDown でページ移動しない", () => {
    renderHook(() => usePdfShortcuts());

    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    // input から dispatch → bubbles で window まで伝播するが
    // target が input なので編集ガードが発動する
    input.dispatchEvent(event);

    expect(usePdfStore.getState().currentPage).toBe(3);

    document.body.removeChild(input);
  });

  it("textarea 要素内では ArrowUp でページ移動しない", () => {
    renderHook(() => usePdfShortcuts());

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(usePdfStore.getState().currentPage).toBe(3);

    document.body.removeChild(textarea);
  });

  it("document.body では ArrowDown でページ移動する（ガードされない）", () => {
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowDown");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });
});

describe("usePdfShortcuts: オフセット調整モードの矢印競合 (#390 / PCT-160)", () => {
  // 根拠: 確認画面の adjustOffset モードでは、OffsetAdjustOverlay が
  // window keydown で矢印キーを ±1px nudgePageOffset に使う（同コンポーネント L246-268）。
  // usePdfShortcuts も同じ window keydown で矢印をページ移動に使うため、両者が
  // stopPropagation せず同時発火し、欄を微調整するたびにページが進む（PCT-160 / #390）。
  // 期待動作: adjustOffset 中は矢印をオーバーレイの nudge に専有させ、usePdfShortcuts 側は
  // ページ移動しない。Page系/Home/End は競合しないので従来どおり動く。
  afterEach(() => {
    useReportStore.getState().setMode("idle");
  });

  it("adjustOffset モードでは ArrowDown でページ移動しない（矢印は欄微調整に譲る）", () => {
    useReportStore.getState().setMode("adjustOffset");
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowDown");
    expect(usePdfStore.getState().currentPage).toBe(3); // 不変（初期=3）
  });

  it("adjustOffset モードでも PageDown はページ移動する（Page系は競合しない）", () => {
    useReportStore.getState().setMode("adjustOffset");
    renderHook(() => usePdfShortcuts());
    pressKey("PageDown");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });

  it("idle モードでは従来どおり ArrowDown でページ移動する（回帰防止）", () => {
    useReportStore.getState().setMode("idle");
    renderHook(() => usePdfShortcuts());
    pressKey("ArrowDown");
    expect(usePdfStore.getState().currentPage).toBe(4);
  });
});

describe("usePdfShortcuts: クリーンアップ", () => {
  it("アンマウント後はキーボードイベントが無効になる", () => {
    const { unmount } = renderHook(() => usePdfShortcuts());
    unmount();

    pressKey("ArrowDown");
    // アンマウント後はイベントリスナーが外れているので currentPage は変わらない
    expect(usePdfStore.getState().currentPage).toBe(3);
  });
});
