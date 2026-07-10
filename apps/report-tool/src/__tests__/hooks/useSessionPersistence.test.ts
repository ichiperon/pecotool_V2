import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSessionPersistence,
  SESSION_AUTOSAVE_DEBOUNCE_MS,
} from "../../hooks/useSessionPersistence";
import { serializeSession } from "../../logic/sessionCodec";
import type { SessionFileStorage, SessionSaveResult } from "../../lib/sessionFileStorage";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

const RECT = { x: 0, y: 0, width: 100, height: 30 };
/** テスト全体で使う固定フィンガープリント。実際のハッシュ値である必要はない（文字列一致のみ検証）。 */
const FAKE_FINGERPRINT = "fp-test-abc123";

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

function makeDeferredLoadStorage(json: string): {
  storage: SessionFileStorage;
  resolveLoad: () => void;
} {
  let resolveLoad!: (result: { ok: true; json: string }) => void;
  const storage: SessionFileStorage = {
    save: vi.fn().mockResolvedValue({ ok: true }),
    load: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    ),
    clear: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    storage,
    resolveLoad: () => resolveLoad({ ok: true, json }),
  };
}

/**
 * save の完了タイミングをテストから手動制御できるストレージモック
 * （single-flight/コアレスの検証用）。
 *
 * save() は呼ばれた時点では未解決の Promise を返し、resolveNext() で
 * 呼び出し順に1件ずつ解決する。maxConcurrent は「同時に何本 save が
 * pending だったか」の最大値（1 を超えたら並走している＝バグ）。
 */
function makeControllableStorage(): {
  storage: SessionFileStorage;
  saveCalls: string[];
  pendingCount: () => number;
  maxConcurrent: () => number;
  resolveNext: (result?: SessionSaveResult) => void;
} {
  const saveCalls: string[] = [];
  let active = 0;
  let peak = 0;
  const resolvers: Array<(r: SessionSaveResult) => void> = [];

  const storage: SessionFileStorage = {
    save: vi.fn().mockImplementation((json: string) => {
      saveCalls.push(json);
      active++;
      peak = Math.max(peak, active);
      return new Promise<SessionSaveResult>((resolve) => {
        resolvers.push((r) => {
          active--;
          resolve(r);
        });
      });
    }),
    load: vi.fn().mockResolvedValue({ ok: false, missing: true }),
    clear: vi.fn().mockResolvedValue({ ok: true }),
  };

  return {
    storage,
    saveCalls,
    pendingCount: () => resolvers.length,
    maxConcurrent: () => peak,
    resolveNext: (result: SessionSaveResult = { ok: true }) => {
      const resolver = resolvers.shift();
      if (!resolver) throw new Error("resolveNext: 解決待ちの save がありません");
      resolver(result);
    },
  };
}

/** 溜まったマイクロタスクを十分な回数フラッシュする（Promise チェーンの多段 await 用）。 */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * 復元用の保存済みセッション JSON を作る。
 * fingerprint 省略時は FAKE_FINGERPRINT（setPdf 側の既定と一致させることで
 * 復元テストが「同一パス・同一内容」の状況を素直に再現できる）。
 * diagnostics 省略時は failedPages=[3] を含める（#447: 復元後も同じ警告が
 * 出ることを検証するテストで使う）。
 */
function savedSessionFor(
  pdfPath: string,
  fingerprint: string = FAKE_FINGERPRINT,
  diagnostics: { failedPages: number[]; layoutMismatchPages: number[]; layoutBasePage: number | null } = {
    failedPages: [3],
    layoutMismatchPages: [],
    layoutBasePage: null,
  }
): string {
  useReportStore.getState().addField(RECT, "金額");
  const id = useReportStore.getState().template.fields[0].id;
  const json = serializeSession({
    pdfPath,
    pdfFingerprint: fingerprint,
    savedAt: "2026-07-08T05:00:00.000Z",
    rotation: 90,
    fields: useReportStore.getState().template.fields,
    cells: new Map([[1, [new Map([[id, "保存済み値"]])]]]),
    confidences: new Map(),
    edited: new Map([[1, [new Set([id])]]]),
    pageOffsets: new Map([[1, { dx: 1, dy: 1 }]]),
    excludedPages: new Set([2]),
    diagnostics,
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
    // #447: failedPages 等は store 化されたため、useState 時代と違い
    // renderHook をまたいでも自動的には空に戻らない。テスト間の汚染防止のため明示リセット。
    failedPages: [],
    layoutMismatchPages: [],
    layoutBasePage: null,
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
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
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
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("保存 JSON に store の OCR 診断状態と pdfFingerprint が入る（#446 #447 保存側の配線）", async () => {
    // 復元系テストは serializeSession を直接使って JSON を作るため、
    // saveNow が store の failedPages 等を diagnostics へ詰める配線は
    // ここで保存側から縛る（詰め忘れて空配列を書いても復元テストは通ってしまう）。
    const storage = makeStorage();
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "1000"]])]]]));
      useReportStore.getState().setFailedPages([4, 7]);
      useReportStore.getState().setLayoutMismatchPages([2]);
      useReportStore.getState().setLayoutBasePage(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });

    expect(storage.saved.length).toBeGreaterThan(0);
    const parsed = JSON.parse(storage.saved[storage.saved.length - 1]);
    expect(parsed.pdfFingerprint).toBe(FAKE_FINGERPRINT);
    expect(parsed.diagnostics).toEqual({
      failedPages: [4, 7],
      layoutMismatchPages: [2],
      layoutBasePage: 1,
    });
  });

  it("pdfFingerprint 未確定（setPdf に fingerprint なし）の間は cells があっても保存しない（#446）", async () => {
    const storage = makeStorage();
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      // fingerprint を渡さない setPdf（読込途中・旧経路を模す）。
      // fingerprint なしで保存されたセッションは v2 スキーマで復元不可能になるため、
      // saveNow はこの状態では保存をスキップしなければならない。
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "1000"]])]]]));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("pdfFingerprint 未確定なら flushNow も保存せず false を返す（#446）", async () => {
    const storage = makeStorage();
    const { result } = renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "1000"]])]]]));
    });

    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await result.current.flushNow();
    });
    expect(flushed).toBe(false);
    expect(storage.save).not.toHaveBeenCalled();
  });
});

describe("useSessionPersistence: 復元", () => {
  it("同じ PDF を開くと確認のうえ全スライスが復元される", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
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
    // #447: OCR 診断状態（失敗ページ等）も復元される
    // （CsvExportButton の failedPages 警告ゲートは同じ値を props で受け取るため、
    // ここで store に正しく入ることを検証すれば警告表示側の挙動も担保される。
    // CsvExportButton 自体の「failedPages があると alert を表示する」検証は
    // 別ファイル __tests__/components/CsvExportButton.test.tsx で既に持っている）。
    expect(rs.failedPages).toEqual([3]);
    expect(rs.layoutMismatchPages).toEqual([]);
    expect(rs.layoutBasePage).toBeNull();
  });

  it("layoutMismatchPages / layoutBasePage も非空・非 null の値で復元される（#447）", async () => {
    // 既定の savedSessionFor は layoutMismatchPages=[] / layoutBasePage=null のため、
    // 「初期値と同じ値の復元」では復元漏れを検出できない。非空値で縛る。
    const json = savedSessionFor("/docs/a.pdf", FAKE_FINGERPRINT, {
      failedPages: [3, 8],
      layoutMismatchPages: [5],
      layoutBasePage: 2,
    });
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(window.confirm).toHaveBeenCalled();
    const rs = useReportStore.getState();
    expect(rs.failedPages).toEqual([3, 8]);
    expect(rs.layoutMismatchPages).toEqual([5]);
    expect(rs.layoutBasePage).toBe(2);
  });

  it("同じパスでも fingerprint が異なれば復元を提案しない（#446: 中身が変わったPDFの誤復元防止）", async () => {
    const json = savedSessionFor("/docs/a.pdf", "old-fingerprint");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      // setPdf に渡す fingerprint は savedSessionFor のものと異なる
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, "new-fingerprint");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().cells.size).toBe(0);
    expect(useReportStore.getState().failedPages).toEqual([]);
  });

  it("別の PDF のセッションは適用しない（確認も出さない）", async () => {
    const json = savedSessionFor("/docs/other.pdf");
    const storage = makeStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
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
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
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
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("session load中に完了した新OCRを旧sessionで上書きしない（#459）", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const { storage, resolveLoad } = makeDeferredLoadStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storage.load).toHaveBeenCalledTimes(1);

    act(() => {
      useReportStore.getState().addField(RECT, "新OCR欄");
      const id = useReportStore.getState().template.fields[0].id;
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "NEW"]])]]]));
      resolveLoad();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    const rs = useReportStore.getState();
    const id = rs.template.fields[0].id;
    expect(rs.cells.get(1)?.[0]?.get(id)).toBe("NEW");
  });

  it("session load中のfield追加を旧sessionで上書きしない（#459）", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const { storage, resolveLoad } = makeDeferredLoadStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      useReportStore.getState().addField(RECT, "新規追加欄");
      resolveLoad();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().template.fields.map((field) => field.name)).toEqual([
      "新規追加欄",
    ]);
  });

  it("session load中にPDFを切り替えると古いload結果を適用しない（#459）", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const { storage, resolveLoad } = makeDeferredLoadStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      usePdfStore.getState().setPdf("/docs/b.pdf", 1, "fp-b");
      resolveLoad();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("session load中に同一PDFを再読込しても古いload結果を適用しない（#459）", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const { storage, resolveLoad } = makeDeferredLoadStorage(json);
    renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      resolveLoad();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("session load中にコンポーネントがアンマウントされたら復元confirmを出さない（レビュー差し戻し・#459追い修正）", async () => {
    const json = savedSessionFor("/docs/a.pdf");
    const { storage, resolveLoad } = makeDeferredLoadStorage(json);
    const { unmount } = renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storage.load).toHaveBeenCalledTimes(1);

    // load 完了 (Tauri invoke 相当の非同期処理) を待っている間に画面遷移等で
    // コンポーネントがアンマウントされるケース。
    unmount();

    act(() => {
      resolveLoad();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    // disposed ガードが無いと、アンマウント後に「前回の続きから再開しますか？」の
    // confirm ダイアログだけ遅れて出てしまう（UX 漏れ）。
    expect(window.confirm).not.toHaveBeenCalled();
    expect(useReportStore.getState().cells.size).toBe(0);
  });
});

describe("useSessionPersistence: flushNow（クローズ前フラッシュ・レビューHIGH回帰）", () => {
  it("デバウンス満了前でも flushNow で即時保存され true を返す", async () => {
    const storage = makeStorage();
    const { result } = renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "直前編集"]])]]]));
    });

    // デバウンス（2秒）を待たずにフラッシュ
    let saved = false;
    await act(async () => {
      saved = await result.current.flushNow();
    });
    expect(saved).toBe(true);
    expect(storage.saved[storage.saved.length - 1]).toContain("直前編集");

    // フラッシュ済みなので保留タイマーからの二重保存はない
    const countAfterFlush = storage.saved.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(storage.saved.length).toBe(countAfterFlush);
  });

  it("抽出データが無ければ flushNow は false（保存しない）", async () => {
    const storage = makeStorage();
    const { result } = renderHook(() => useSessionPersistence(storage));
    let saved = true;
    await act(async () => {
      saved = await result.current.flushNow();
    });
    expect(saved).toBe(false);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("保存失敗時は false を返す（クローズ側が警告文言に切り替えられる）", async () => {
    const storage = makeStorage();
    (storage.save as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: "disk" });
    const { result } = renderHook(() => useSessionPersistence(storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "v"]])]]]));
    });

    let saved = true;
    await act(async () => {
      saved = await result.current.flushNow();
    });
    expect(saved).toBe(false);
  });
});

describe("useSessionPersistence: single-flight（#450 frontend・保存の排他/コアレス）", () => {
  it("save 実行中に schedule が発火しても save は並走しない（実行中は追い打ちフラグのみ）", async () => {
    const ctl = makeControllableStorage();
    renderHook(() => useSessionPersistence(ctl.storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "v1"]])]]]));
    });

    // 1回目のデバウンス発火 → save 開始（未解決のまま保留）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(ctl.storage.save).toHaveBeenCalledTimes(1);
    expect(ctl.pendingCount()).toBe(1);

    // 実行中にさらに編集 → 再度デバウンス発火させる
    act(() => {
      useReportStore.getState().setCellValue(1, id, "v2");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });

    // 実行中の save に追い打ちフラグが立つだけで、新規 save はまだ呼ばれない
    expect(ctl.storage.save).toHaveBeenCalledTimes(1);
    expect(ctl.maxConcurrent()).toBe(1);

    // 1本目を解決 → コアレスされた2本目（最新state）が自動的に走る
    await act(async () => {
      ctl.resolveNext({ ok: true });
      await flushMicrotasks();
    });
    expect(ctl.storage.save).toHaveBeenCalledTimes(2);
    expect(ctl.saveCalls[1]).toContain("v2");
    expect(ctl.maxConcurrent()).toBe(1); // 一度も同時に2本走っていない

    // 後始末
    await act(async () => {
      ctl.resolveNext({ ok: true });
      await flushMicrotasks();
    });
  });

  it("flushNow は in-flight 完了を待ってから最新 state で最終保存し true を返す", async () => {
    const ctl = makeControllableStorage();
    const { result } = renderHook(() => useSessionPersistence(ctl.storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "旧値"]])]]]));
    });

    // デバウンス発火 → 1本目の save が実行中（未解決）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(ctl.storage.save).toHaveBeenCalledTimes(1);

    // 実行中に state を更新してから flushNow を呼ぶ
    act(() => {
      useReportStore.getState().setCellValue(1, id, "最新値");
    });

    let flushPromise: Promise<boolean> = Promise.resolve(false);
    act(() => {
      flushPromise = result.current.flushNow();
    });

    // flushNow は待機中: 1本目が解決するまで2本目は呼ばれない
    await flushMicrotasks();
    expect(ctl.storage.save).toHaveBeenCalledTimes(1);

    // 1本目を解決 → flushNow が待っていた最終 save（最新state）が走る
    await act(async () => {
      ctl.resolveNext({ ok: true });
      await flushMicrotasks();
    });
    expect(ctl.storage.save).toHaveBeenCalledTimes(2);
    expect(ctl.saveCalls[1]).toContain("最新値");
    expect(ctl.maxConcurrent()).toBe(1);

    let flushed: boolean | undefined;
    await act(async () => {
      ctl.resolveNext({ ok: true }); // 2本目（flushNow の最終save）を解決
      flushed = await flushPromise;
    });
    expect(flushed).toBe(true);
  });

  it("実行中に save 要求が重なっても storage.save は常に1本ずつしか走らない（並走なしの直接検証）", async () => {
    const ctl = makeControllableStorage();
    const { result } = renderHook(() => useSessionPersistence(ctl.storage));

    act(() => {
      usePdfStore.getState().setPdf("/docs/a.pdf", 2, FAKE_FINGERPRINT);
      useReportStore.getState().addField(RECT, "金額");
    });
    const id = useReportStore.getState().template.fields[0].id;
    act(() => {
      useReportStore.getState().setCells(new Map([[1, [new Map([[id, "v1"]])]]]));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_AUTOSAVE_DEBOUNCE_MS + 10);
    });
    expect(ctl.storage.save).toHaveBeenCalledTimes(1);

    // 実行中に flushNow を2連打（両方とも同じ in-flight を待つ側に回る）
    let p1: Promise<boolean> = Promise.resolve(false);
    let p2: Promise<boolean> = Promise.resolve(false);
    act(() => {
      p1 = result.current.flushNow();
      p2 = result.current.flushNow();
    });
    await flushMicrotasks();
    expect(ctl.maxConcurrent()).toBe(1);
    expect(ctl.storage.save).toHaveBeenCalledTimes(1); // まだ1本目実行中

    // 保留中の save をすべて解決し切るまで、同時実行数が1を超えないことを確認する
    await act(async () => {
      while (ctl.pendingCount() > 0) {
        ctl.resolveNext({ ok: true });
        await flushMicrotasks();
        expect(ctl.maxConcurrent()).toBe(1);
      }
    });

    await act(async () => {
      await Promise.all([p1, p2]);
    });
    // 最後まで一度も並走しなかったこと
    expect(ctl.maxConcurrent()).toBe(1);
  });
});
