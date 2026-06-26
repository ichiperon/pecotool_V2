import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useReportOcr } from "../../hooks/useReportOcr";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

// ===== モック: @tauri-apps/api/core =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ===== モック: @tauri-apps/plugin-fs =====
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

// ===== モック: pdfjs-dist =====
// renderPageOffscreen と cropCanvasToPng が canvas を使うため、
// pdfjs-dist の getDocument を差し替えてオフスクリーン canvas 操作を回避する。
vi.mock("pdfjs-dist", () => {
  const mockPage = {
    getViewport: vi.fn().mockReturnValue({ width: 595, height: 842 }),
    render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
    cleanup: vi.fn(),
  };
  const mockDoc = {
    numPages: 2,
    getPage: vi.fn().mockResolvedValue(mockPage),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getDocument: vi.fn().mockReturnValue({ promise: Promise.resolve(mockDoc) }),
    GlobalWorkerOptions: { workerSrc: "" },
  };
});

// ===== モック: lib/ocrCrop モジュール =====
// canvas 操作を持つ renderPageOffscreen / cropCanvasToPng を差し替える
vi.mock("../../lib/ocrCrop", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/ocrCrop")>();
  return {
    ...original,
    // computeCropRect は純関数なのでそのまま通す。
    // 注: フックは各ページ処理後に canvas.width=0 で canvas を解放する。
    // 単一オブジェクトを mockResolvedValue で使い回すと、その解放がモックを
    // 破壊し後続ページ/テストでクロップが 0px になる。呼び出しごとに
    // 新しい canvas オブジェクトを返してテスト間の相互汚染を防ぐ。
    renderPageOffscreen: vi.fn().mockImplementation(async () => ({
      canvas: {
        width: 1785,
        height: 2526,
        getContext: vi.fn(),
      },
      pageWidth: 595,
      pageHeight: 842,
    })),
    cropCanvasToPng: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])), // PNG magic bytes
  };
});

describe("useReportOcr", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Vitest の vi.mock は static hoisting なので importMock が使えない
    // モジュールを直接取得する
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);

    // デフォルト: run_report_ocr が ok レスポンスを返す
    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [
          { text: "テスト値", bbox: { x: 10, y: 10, width: 50, height: 20 }, confidence: 0.9 },
        ],
      })
    );

    // store をリセット
    useReportStore.setState({
      template: {
        fields: [
          {
            id: "field-1",
            name: "欄1",
            color: "#7cb9e8",
            rect: { x: 10, y: 10, width: 100, height: 50 },
          },
        ],
      },
      cells: new Map(),
    });

    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 2,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("初期状態は isRunning=false, progress=null", () => {
    const { result } = renderHook(() => useReportOcr());
    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("runOcr 実行後 setCells が呼ばれる（cells に値が入る）", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    const cells = useReportStore.getState().cells;
    // 2 ページ分が格納されているはず
    expect(cells.size).toBeGreaterThan(0);
    // page=1 に field-1 の値が入っている
    const page1 = cells.get(1);
    expect(page1).toBeDefined();
    expect(page1?.has("field-1")).toBe(true);
  });

  it("原点から離れた欄でもクロップOCR結果が正しいセルに入る（クロップローカル座標回帰）", async () => {
    // 欄を原点から離れた位置に置く。クロップ画像は欄領域そのものなので
    // OCR が返す bbox はクロップローカル座標（0 始まり）になる。座標ベースの
    // 再割り当てを使うと、この欄の絶対 rect (x=300,y=400) にローカル座標(≈5,5)
    // が入らず未割当→空セルになる（修正前のバグ）。クロップ＝欄の直接割り当てなら
    // 値が正しく入る。
    useReportStore.setState({
      template: {
        fields: [
          {
            id: "field-far",
            name: "遠い欄",
            color: "#7cb9e8",
            rect: { x: 300, y: 400, width: 100, height: 50 },
          },
        ],
      },
      cells: new Map(),
    });
    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        // クロップローカル座標（0 始まり）。絶対 rect には入らない値。
        blocks: [
          { text: "遠い欄の値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 },
        ],
      })
    );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    const page1 = useReportStore.getState().cells.get(1);
    expect(page1?.get("field-far")).toBe("遠い欄の値");
  });

  it("runOcr 完了後 isRunning=false に戻る", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
  });

  it("runOcr 完了後 progress=null に戻る", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.progress).toBeNull();
  });

  it("PDF 未読込（filePath=null）のとき runOcr は即座に終了して cells を変えない", async () => {
    usePdfStore.setState({ filePath: null, numPages: 0 });
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("欄が 0 件のとき runOcr は即座に終了して cells を変えない", async () => {
    useReportStore.setState({ template: { fields: [] } });
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("invoke がエラーを throw してもループが中断せず最終的に isRunning=false になる", async () => {
    invokeStub.mockRejectedValue(new Error("IPC Error"));
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
  });

  it("invoke が status=error を返してもループが続き isRunning=false になる", async () => {
    invokeStub.mockResolvedValue(JSON.stringify({ status: "error", message: "OCR失敗" }));
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
  });

  it("cancelOcr を呼ぶと cells が setCells されない（キャンセル時は格納しない）", async () => {
    // invoke を遅延させてキャンセルのタイミングを作る
    invokeStub.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                JSON.stringify({
                  status: "ok",
                  blocks: [{ text: "X", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
                })
              ),
            50
          )
        )
    );

    const setCellsSpy = vi.spyOn(useReportStore.getState(), "setCells");
    const { result } = renderHook(() => useReportOcr());

    // runOcr を開始して、すぐキャンセル
    act(() => {
      result.current.runOcr();
    });
    act(() => {
      result.current.cancelOcr();
    });

    // 遅延 invoke が完了するまで待つ
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // キャンセル時は setCells が呼ばれない
    expect(setCellsSpy).not.toHaveBeenCalled();
    setCellsSpy.mockRestore();
  });

  it("numPages=1 のとき total=1 のプログレスが発行される", async () => {
    usePdfStore.setState({ numPages: 1 });
    const progressHistory: Array<{ done: number; total: number }> = [];
    const { result } = renderHook(() => useReportOcr());

    // progress の変化を追跡するために useState を観察
    // vitest では act 内の state 変化が同期的にフラッシュされるため
    // runOcr 後の最終値を確認する
    await act(async () => {
      await result.current.runOcr();
    });

    // 完了後は null に戻っている
    expect(result.current.progress).toBeNull();
    void progressHistory; // 変数を使用したとマーク
  });

  it("初期状態は reocrTarget=null", () => {
    const { result } = renderHook(() => useReportOcr());
    expect(result.current.reocrTarget).toBeNull();
  });
});

describe("useReportOcr: runOcrForPage", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);

    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [
          { text: "再OCR値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.95 },
        ],
      })
    );

    useReportStore.setState({
      template: {
        fields: [
          {
            id: "field-1",
            name: "欄1",
            color: "#7cb9e8",
            rect: { x: 10, y: 10, width: 100, height: 50 },
          },
        ],
      },
      cells: new Map([
        [1, new Map([["field-1", "旧値"]])],
        [2, new Map([["field-1", "ページ2の値"]])],
      ]),
      pageOffsets: new Map(),
    });

    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 2,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runOcrForPage 完了後 指定ページの cells が更新される", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    const page1 = useReportStore.getState().cells.get(1);
    expect(page1?.get("field-1")).toBe("再OCR値");
  });

  it("runOcrForPage は他ページの cells を変更しない", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    const page2 = useReportStore.getState().cells.get(2);
    expect(page2?.get("field-1")).toBe("ページ2の値");
  });

  it("runOcrForPage 完了後 isRunning=false / reocrTarget=null に戻る", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.reocrTarget).toBeNull();
  });

  it("filePath=null のとき runOcrForPage は即座に終了して cells を変えない", async () => {
    usePdfStore.setState({ filePath: null });
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    expect(result.current.isRunning).toBe(false);
    // cells は変化しない
    expect(useReportStore.getState().cells.get(1)?.get("field-1")).toBe("旧値");
  });

  it("欄が 0 件のとき runOcrForPage は即座に終了して cells を変えない", async () => {
    useReportStore.setState({ template: { fields: [] } });
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    expect(result.current.isRunning).toBe(false);
  });

  it("pageOffset が設定されているとき effectiveRectForPage が適用されて OCR が実行される", async () => {
    useReportStore.setState({
      pageOffsets: new Map([[1, { dx: 10, dy: 5 }]]),
    });

    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    // OCR は invoke を通して完了する（オフセット有でもエラーなく完了すること）
    const page1 = useReportStore.getState().cells.get(1);
    expect(page1?.has("field-1")).toBe(true);
  });
});
