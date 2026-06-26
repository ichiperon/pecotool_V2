import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { usePdfPanZoom } from "../../hooks/usePdfPanZoom";
import { usePdfStore } from "../../store/pdfStore";

beforeEach(() => {
  usePdfStore.getState().reset();
  usePdfStore.getState().setPdf("/test.pdf", 5);
  usePdfStore.getState().setZoom(100);
  usePdfStore.getState().setFitMode("width");
});

afterEach(() => {
  vi.clearAllMocks();
});

/** containerRef 付きのダミー div を作りドキュメントに追加して返す */
function makeContainerRef() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const ref = createRef<HTMLDivElement>() as React.MutableRefObject<HTMLDivElement | null>;
  ref.current = div;
  return { div, ref };
}

function cleanup(div: HTMLElement) {
  document.body.removeChild(div);
}

// ---- Ctrl+ホイールズーム ----

describe("usePdfPanZoom: Ctrl+ホイールズーム", () => {
  it("Ctrl+wheel deltaY<0 でズームが +10 になり fitMode が custom になる", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(event);

    expect(usePdfStore.getState().zoom).toBe(110);
    expect(usePdfStore.getState().fitMode).toBe("custom");
    cleanup(div);
  });

  it("Ctrl+wheel deltaY>0 でズームが -10 になる", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const event = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(event);

    expect(usePdfStore.getState().zoom).toBe(90);
    expect(usePdfStore.getState().fitMode).toBe("custom");
    cleanup(div);
  });

  it("Ctrl なしの wheel ではズームが変わらない", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(event);

    expect(usePdfStore.getState().zoom).toBe(100);
    cleanup(div);
  });

  it("Meta+wheel でもズームが変わる（Mac 対応）", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const event = new WheelEvent("wheel", {
      deltaY: -100,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(event);

    expect(usePdfStore.getState().zoom).toBe(110);
    expect(usePdfStore.getState().fitMode).toBe("custom");
    cleanup(div);
  });

  it("ズームの clamp が効く（100 - 10*8 = 20 → 25 にクランプ）", () => {
    const { div, ref } = makeContainerRef();
    usePdfStore.getState().setZoom(30);
    renderHook(() => usePdfPanZoom(ref));

    // 30 - 10 = 20 → clamp で 25
    const event = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(event);

    expect(usePdfStore.getState().zoom).toBe(25);
    cleanup(div);
  });
});

// ---- スペース+ドラッグ（カーソル制御）----

describe("usePdfPanZoom: スペース+ドラッグ（カーソル）", () => {
  it("Space keydown で container.style.cursor が 'grab' になる", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })
    );

    expect(div.style.cursor).toBe("grab");
    cleanup(div);
  });

  it("Space keyup で container.style.cursor が '' に戻る", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })
    );
    expect(div.style.cursor).toBe("grab");

    window.dispatchEvent(
      new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true })
    );
    expect(div.style.cursor).toBe("");
    cleanup(div);
  });

  it("非 Space キーは cursor に影響しない", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true, cancelable: true })
    );
    expect(div.style.cursor).toBe("");
    cleanup(div);
  });
});

// ---- 編集ガード ----

describe("usePdfPanZoom: 編集ガード（Space）", () => {
  it("input 内で Space を押してもカーソルが変わらない", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const input = document.createElement("input");
    document.body.appendChild(input);

    // input から Space keydown を発火（bubbles で window まで伝播）
    const event = new KeyboardEvent("keydown", {
      code: "Space",
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: input });
    window.dispatchEvent(event);

    expect(div.style.cursor).toBe("");
    document.body.removeChild(input);
    cleanup(div);
  });

  it("button にフォーカス中の Space ではパンを arm しない（Space をボタン活性化に通す）", () => {
    const { div, ref } = makeContainerRef();
    renderHook(() => usePdfPanZoom(ref));

    const button = document.createElement("button");
    document.body.appendChild(button);

    const event = new KeyboardEvent("keydown", {
      code: "Space",
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: button });
    window.dispatchEvent(event);

    expect(div.style.cursor).toBe("");
    document.body.removeChild(button);
    cleanup(div);
  });
});

// ---- アンマウント時のクリーンアップ ----

describe("usePdfPanZoom: クリーンアップ", () => {
  it("アンマウント後は Space を押してもカーソルが変わらない", () => {
    const { div, ref } = makeContainerRef();
    const { unmount } = renderHook(() => usePdfPanZoom(ref));
    unmount();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })
    );
    expect(div.style.cursor).toBe("");
    cleanup(div);
  });

  it("アンマウント後は Ctrl+wheel でもズームが変わらない", () => {
    const { div, ref } = makeContainerRef();
    const { unmount } = renderHook(() => usePdfPanZoom(ref));
    unmount();

    div.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(usePdfStore.getState().zoom).toBe(100);
    cleanup(div);
  });

  it("アンマウント時に container.style.cursor が '' にリセットされる", () => {
    const { div, ref } = makeContainerRef();
    const { unmount } = renderHook(() => usePdfPanZoom(ref));

    // Space でカーソルを grab にする
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })
    );
    expect(div.style.cursor).toBe("grab");

    unmount();
    expect(div.style.cursor).toBe("");
    cleanup(div);
  });
});

// ---- containerRef.current が null のとき ----

describe("usePdfPanZoom: container が null のとき", () => {
  it("container が null でもクラッシュしない", () => {
    const ref = createRef<HTMLDivElement>() as React.MutableRefObject<HTMLDivElement | null>;
    ref.current = null;
    expect(() => renderHook(() => usePdfPanZoom(ref))).not.toThrow();
  });
});
