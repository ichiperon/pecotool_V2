import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useUndoShortcuts } from "../../hooks/useUndoShortcuts";
import { useReportStore } from "../../store/reportStore";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

let fieldId: string;

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    edited: new Map(),
    past: [],
    future: [],
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
  useReportStore.getState().addField(SAMPLE_RECT, "金額");
  fieldId = useReportStore.getState().template.fields[0].id;
  useReportStore.getState().setCells(new Map([[1, [new Map([[fieldId, "100"]])]]]));
  // undo 可能な操作を1つ積んでおく
  useReportStore.getState().setCellValue(1, fieldId, "200");
});

afterEach(() => {
  document.body.innerHTML = "";
});

function currentValue(): string | undefined {
  return useReportStore.getState().cells.get(1)?.[0]?.get(fieldId);
}

/**
 * 指定要素（既定 document.body）から KeyboardEvent を発火するヘルパー。
 * window.dispatchEvent だと target = window になり closest が呼べないため
 * 要素経由で bubbles させる（usePdfShortcuts.test.ts と同じ作法）。
 */
function pressKey(
  key: string,
  options: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: Element;
    isComposing?: boolean;
    keyCode?: number;
  } = {}
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
  });
  if (options.isComposing !== undefined) {
    Object.defineProperty(event, "isComposing", { value: options.isComposing });
  }
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: options.keyCode });
  }
  (options.target ?? document.body).dispatchEvent(event);
  return event;
}

describe("useUndoShortcuts: 基本操作", () => {
  it("Ctrl+Z で undo が発火する", () => {
    renderHook(() => useUndoShortcuts());
    expect(currentValue()).toBe("200");
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("100");
  });

  it("Meta+Z（mac 系）でも undo が発火する", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { metaKey: true });
    expect(currentValue()).toBe("100");
  });

  it("Ctrl+Y で redo が発火する", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("100");
    pressKey("y", { ctrlKey: true });
    expect(currentValue()).toBe("200");
  });

  it("Ctrl+Shift+Z でも redo が発火する", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { ctrlKey: true });
    pressKey("z", { ctrlKey: true, shiftKey: true });
    expect(currentValue()).toBe("200");
  });

  it("Ctrl 系修飾なしの z では発火しない", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z");
    expect(currentValue()).toBe("200");
  });

  it("Ctrl+Alt+Z（AltGr 対策）では発火しない", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { ctrlKey: true, altKey: true });
    expect(currentValue()).toBe("200");
  });

  it("大文字 Z（CapsLock 等）でも発火する", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("Z", { ctrlKey: true });
    expect(currentValue()).toBe("100");
  });

  it("unmount 後は発火しない", () => {
    const { unmount } = renderHook(() => useUndoShortcuts());
    unmount();
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("200");
  });

  it("enabled=false のとき発火しない（ステップ③以外のガード）", () => {
    renderHook(() => useUndoShortcuts(false));
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("200");
  });

  it("enabled が false→true に変わるとリスナーが有効になる", () => {
    const { rerender } = renderHook(({ on }) => useUndoShortcuts(on), {
      initialProps: { on: false },
    });
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("200");

    rerender({ on: true });
    pressKey("z", { ctrlKey: true });
    expect(currentValue()).toBe("100");
  });
});

describe("useUndoShortcuts: onAction フィードバック", () => {
  it("undo 成功で ('undo', true) が呼ばれる", () => {
    const calls: [string, boolean][] = [];
    renderHook(() => useUndoShortcuts(true, (t, a) => calls.push([t, a])));
    pressKey("z", { ctrlKey: true });
    expect(calls).toEqual([["undo", true]]);
  });

  it("履歴が空のときは ('undo', false)（空振りの可視化）", () => {
    useReportStore.setState({ past: [], future: [] });
    const calls: [string, boolean][] = [];
    renderHook(() => useUndoShortcuts(true, (t, a) => calls.push([t, a])));
    pressKey("z", { ctrlKey: true });
    expect(calls).toEqual([["undo", false]]);
  });

  it("redo 側も applied を正しく報告する", () => {
    const calls: [string, boolean][] = [];
    renderHook(() => useUndoShortcuts(true, (t, a) => calls.push([t, a])));
    pressKey("y", { ctrlKey: true }); // future 空 → 空振り
    pressKey("z", { ctrlKey: true }); // undo 成功
    pressKey("y", { ctrlKey: true }); // redo 成功
    expect(calls).toEqual([
      ["redo", false],
      ["undo", true],
      ["redo", true],
    ]);
  });

  it("ガードで発火しなかったキー入力では onAction が呼ばれない", () => {
    const calls: [string, boolean][] = [];
    renderHook(() => useUndoShortcuts(true, (t, a) => calls.push([t, a])));
    const input = document.createElement("input");
    document.body.appendChild(input);
    pressKey("z", { ctrlKey: true, target: input });
    expect(calls).toHaveLength(0);
  });
});

describe("useUndoShortcuts: ガード", () => {
  it("input フォーカス中はネイティブ undo を優先して発火しない", () => {
    renderHook(() => useUndoShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    pressKey("z", { ctrlKey: true, target: input });
    expect(currentValue()).toBe("200");
  });

  it("textarea フォーカス中も発火しない", () => {
    renderHook(() => useUndoShortcuts());
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    pressKey("z", { ctrlKey: true, target: textarea });
    expect(currentValue()).toBe("200");
  });

  it("gridcell（セルにフォーカスしたナビゲーション状態）では発火する", () => {
    // isEditingTarget と違い gridcell はブロックしない — セル削除・移動の直後こそ
    // Ctrl+Z が必要で、そのときフォーカスは gridcell にある
    renderHook(() => useUndoShortcuts());
    const cell = document.createElement("td");
    cell.setAttribute("role", "gridcell");
    document.body.appendChild(cell);
    pressKey("z", { ctrlKey: true, target: cell });
    expect(currentValue()).toBe("100");
  });

  it("IME 変換中（isComposing）は発火しない", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { ctrlKey: true, isComposing: true });
    expect(currentValue()).toBe("200");
  });

  it("IME 確定キー（keyCode 229 互換フォールバック）は発火しない", () => {
    renderHook(() => useUndoShortcuts());
    pressKey("z", { ctrlKey: true, keyCode: 229 });
    expect(currentValue()).toBe("200");
  });
});
