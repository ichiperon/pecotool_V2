import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSessionPersistence,
  SESSION_AUTOSAVE_DEBOUNCE_MS,
} from "../../hooks/useSessionPersistence";
import { serializeSession } from "../../logic/sessionCodec";
import type { SessionFileStorage } from "../../lib/sessionFileStorage";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

const RECT = { x: 0, y: 0, width: 100, height: 30 };

function makeStorage(loadJson?: string): SessionFileStorage & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    save: vi.fn().mockImplementation(async (json: string) => {
      saved.push(json);
      return { ok: true };
    }),
    load: vi
      .fn()
      .mockImplementation(async () =>
        loadJson !== undefined ? { ok: true, json: loadJson } : { ok: false, missing: true }
      ),
    clear: vi.fn().mockResolvedValue({ ok: true }),
  };
}

/** 復元用の保存済みセッション JSON を作る */
function savedSessionFor(pdfPath: string): string {
  useReportStore.getState().addField(RECT, "金額");
  const id = useReportStore.getState().template.fields[0].id;
  const json = serializeSession({
    pdfPath,
    savedAt: "2026-07-08T05:00:00.000Z",
    rotation: 90,
    fields: useReportStore.getState().template.fields,
    cells: new Map([[1, [new Map([[id, "保存済み値"]])]]]),
    confidences: new Map(),
    edited: new Map([[1, [new Set([id])]]]),
    pageOffsets: new Map([[1, { dx: 1, dy: 1 }]]),
    excludedPages: new Set([2]),
  });
  // テンプレは復元経路で入るので初期化し直す
  useReportStore.setState({ template: { fields: [] } });
  return json;
}

beforeEach(() => {
  vi.useFakeTimers();
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    edited: new Map(),
    past: [],
    future: [],
    lastUndoableTag: null,
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
    excludedPages: new Set(),
  });
  usePdfStore.getState().reset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSessionPersistence: 自動保存", () => {
  it("セル編集からデバウンス後に保存され、JSON に値が含まれる", async () => {
    const storage = makeStorage();
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "1000"]])]]]));
      useReportStore.getState().setCellValue(1, id, "2000");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });

    expect(storage.saved.length).toBeGreaterThan(0);
    const last = storage.saved[storage.saved.length - 1];
    expect(last).toContain("2000");
    expect(last).toContain("/docs/a.pdf");
  });

  it("cells が空の間は保存しない（reset 直後に有効セッションを潰さない）", async () => {
    const storage = makeStorage();
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
      useReportStore.getState().addField(RECT, "金額");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(storage.save).not.toHaveBeenCalled();
  });
});

describe("useSessionPersistence: 復元", () => {
  it("同じ PDF を開くと確認のうえ全スライスが復元される", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // offerRestore の setTimeout(0)
    });

    expect(window.confirm).toHaveBeenCalled();
    const rs = useReportStore.getState();
    expect(rs.template.fields).toHaveLength(1);
    const id = rs.template.fields[0].id;
    expect(rs.cells.get(1)?.[0]?.get(id)).toBe("保存済み値");
    expect(rs.edited.get(1)?.[0]?.has(id)).toBe(true);
    expect(rs.pageOffsets.get(1)).toEqual({ dx: 1, dy: 1 });
    expect(rs.excludedPages.has(2)).toBe(true);
    expect(usePdfStore.getState().rotation).toBe(90);
    // undo 履歴は持ち込まない
    expect(rs.past).toHaveLength(0);
  });

  it("別の PDF のセッションは適用しない（確認も出さない）", async () => {
    const json = savedSessionFor("/docs/other.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("確認でキャンセルすると復元しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const json = savedSessionFor("/docs/a.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("既に作業がある場合は復元を聞かない", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      useReportStore.getState().addField(RECT, "既存");
      const id = useReportStore.getState().template.fields[0].id;
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "作業中"]])]]]));
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(window.confirm).not.toHaveBeenCalled();
  });
});
