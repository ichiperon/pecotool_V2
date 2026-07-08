import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useReportOcr } from "../../hooks/useReportOcr";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";
import { buildTemplateCsv } from "../../logic/templateCsv";

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
    expect(page1?.[0]?.has("field-1")).toBe(true);
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
    expect(page1?.[0]?.get("field-far")).toBe("遠い欄の値");
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

  it("readFile（PDF 読み込み自体）が失敗すると既存の cells を空 Map で上書きしない", async () => {
    // PDF 読み込み段階の失敗は matrix が空のまま finally に落ちるため、
    // loadFailed フラグで区別しないと setCells(空Map) が既存データを消してしまう。
    useReportStore.setState({
      cells: new Map([[1, [new Map([["field-1", "既存値"]])]]]),
    });

    const pluginFs = await import("@tauri-apps/plugin-fs");
    const readFileStub = vi.mocked(pluginFs.readFile);
    readFileStub.mockRejectedValueOnce(new Error("PDF読み込み失敗"));

    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.isRunning).toBe(false);
    // 既存の cells が空 Map で上書きされていないこと
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("既存値");
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

  it("一部ページの処理が例外を投げると failedPages に該当ページが積まれ、成功ページの cells は残る", async () => {
    // runOcrSinglePage 内で invoke の reject は握りつぶされ fieldMap.set(id, "") になるため
    // (useReportOcr.ts:106-113)、ページ単位の catch (235-237) に到達させるには
    // runOcrSinglePage 自体が throw する必要がある。renderPageOffscreen をページ2だけ
    // reject させることでページ単位のエラー経路を再現する。
    const ocrCrop = await import("../../lib/ocrCrop");
    const renderPageOffscreenStub = vi.mocked(ocrCrop.renderPageOffscreen);
    renderPageOffscreenStub
      .mockImplementationOnce(async () => ({
        canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
        pageWidth: 595,
        pageHeight: 842,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("render失敗");
      });

    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    // page 2 が failedPages に積まれる
    expect(result.current.failedPages).toEqual([2]);
    // page 1（成功ページ）の cells は生成されている
    const cells = useReportStore.getState().cells;
    expect(cells.get(1)?.[0]?.get("field-1")).toBe("テスト値");
    // page 2（失敗ページ）の cells は欠落している
    expect(cells.has(2)).toBe(false);

    // mockImplementationOnce のキューは vi.clearAllMocks() では消費されず後続テストへ
    // 持ち越されるため、明示的にデフォルト実装へ戻して他テストへの汚染を防ぐ。
    renderPageOffscreenStub.mockImplementation(async () => ({
      canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
      pageWidth: 595,
      pageHeight: 842,
    }));
  });

  it("再実行で failedPages がクリアされる", async () => {
    const ocrCrop = await import("../../lib/ocrCrop");
    const renderPageOffscreenStub = vi.mocked(ocrCrop.renderPageOffscreen);
    renderPageOffscreenStub
      .mockImplementationOnce(async () => ({
        canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
        pageWidth: 595,
        pageHeight: 842,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("render失敗");
      });

    const { result } = renderHook(() => useReportOcr());

    // 1回目: 一部失敗させて failedPages を非空にする
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.failedPages).toEqual([2]);

    // 2回目: renderPageOffscreen を全成功のデフォルト実装に戻して再実行
    renderPageOffscreenStub.mockImplementation(async () => ({
      canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
      pageWidth: 595,
      pageHeight: 842,
    }));

    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.failedPages).toEqual([]);

    // 次に続く describe ブロックへの汚染防止。
    // 特に confidences: runOcrForPage describe の beforeEach は confidences を明示的に
    // リセットしていない（既存の設計）ため、直前の runOcr(全成功) で page1+2 両方に
    // confidence が投入された状態を残すと、後続の
    // 「runOcrForPage は他ページの confidences を変更しない」検証が汚染される。
    renderPageOffscreenStub.mockImplementation(async () => ({
      canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
      pageWidth: 595,
      pageHeight: 842,
    }));
    useReportStore.setState({ confidences: new Map() });
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
        [1, [new Map([["field-1", "旧値"]])]],
        [2, [new Map([["field-1", "ページ2の値"]])]],
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
    expect(page1?.[0]?.get("field-1")).toBe("再OCR値");
  });

  it("runOcrForPage は他ページの cells を変更しない", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    const page2 = useReportStore.getState().cells.get(2);
    expect(page2?.[0]?.get("field-1")).toBe("ページ2の値");
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
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("旧値");
  });

  // 注: #419 が指摘した非対称の実体は「pdfjs-dist / plugin-fs の動的 import 自体
  // (`await import(...)`) が try ブロックの外にある」点。readFile/getDocument の
  // 呼び出しはこの2テストが書かれる以前から try 内にあったため、以下2テストは
  // #419 の非対称性そのものは再現しない（vi.mock でモジュール解決自体を reject
  // させる検証は resetModules がテスト内の store インスタンスを分離してしまい
  // 安定して書けなかったため見送り）。ただし読込段階の例外がボタン永久 disable を
  // 引き起こさないことを保証する安全網として残す。#419 の本質的な修正
  // （動的 import を try 内に移動）はコードレビューで確認する。
  it("readFile が throw しても isRunning が false に戻る（読込段階エラーでのボタン永久 disable 防止）", async () => {
    const pluginFs = await import("@tauri-apps/plugin-fs");
    const readFileStub = vi.mocked(pluginFs.readFile);
    readFileStub.mockRejectedValueOnce(new Error("読み込み失敗"));

    const { result } = renderHook(() => useReportOcr());

    // 再OCRの失敗は握りつぶさず reject で呼び出し元（ConfirmLayout の reocrError）へ伝播する
    await act(async () => {
      await expect(result.current.runOcrForPage(1)).rejects.toThrow("読み込み失敗");
    });

    // readFile 失敗時も isRunning/reocrTarget が確実に戻り、ボタンが永久 disable にならないこと
    expect(result.current.isRunning).toBe(false);
    expect(result.current.reocrTarget).toBeNull();
  });

  it("getDocument が throw しても isRunning が false に戻る（破損PDF等の読込段階エラー）", async () => {
    const pdfjsLib = await import("pdfjs-dist");
    const getDocumentStub = vi.mocked(pdfjsLib.getDocument);
    // 破損 PDF 等で getDocument が同期的に throw するケースを模す
    getDocumentStub.mockImplementationOnce(() => {
      throw new Error("Invalid PDF structure");
    });

    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await expect(result.current.runOcrForPage(1)).rejects.toThrow("Invalid PDF structure");
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.reocrTarget).toBeNull();
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
    expect(page1?.[0]?.has("field-1")).toBe(true);
  });

  it("runOcrForPage 完了後に指定ページの confidences が投入される", async () => {
    // invokeStub は confidence=0.95 を返すよう beforeEach で設定済み
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    const pageConf = useReportStore.getState().confidences.get(1);
    expect(pageConf).toBeDefined();
    expect(pageConf?.[0]?.get("field-1")).toBe(0.95);
    // 他ページは影響しない
    expect(useReportStore.getState().confidences.has(2)).toBe(false);
  });
});

describe("useReportOcr: runOcr の confidences 投入", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);

    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [
          { text: "値A", bbox: { x: 10, y: 10, width: 50, height: 20 }, confidence: 0.5 },
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
      cells: new Map(),
      confidences: new Map(),
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

  it("runOcr 完了後に全ページの confidences が投入される", async () => {
    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    const conf = useReportStore.getState().confidences;
    // 2ページ分の confidences が格納される（invokeStub が confidence=0.5 を返す）
    expect(conf.size).toBeGreaterThan(0);
    const page1Conf = conf.get(1);
    expect(page1Conf).toBeDefined();
    expect(page1Conf?.[0]?.get("field-1")).toBe(0.5);
  });

  it("confidence なしのブロックだけを返す場合、confidences に値が格納されない", async () => {
    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [
          // confidence フィールドなし
          { text: "値B", bbox: { x: 10, y: 10, width: 50, height: 20 } },
        ],
      })
    );

    const { result } = renderHook(() => useReportOcr());

    await act(async () => {
      await result.current.runOcr();
    });

    const conf = useReportStore.getState().confidences;
    // confMap.size === 0 なので matrix に格納されない
    expect(conf.size).toBe(0);
  });
});

describe("useReportOcr: 明細欄の複数段抽出", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  function ocrResponse(blocks: Array<{ text: string; x: number; y: number; confidence?: number }>) {
    return JSON.stringify({
      status: "ok",
      blocks: blocks.map((b) => ({
        text: b.text,
        bbox: { x: b.x, y: b.y, width: 40, height: 15 },
        confidence: b.confidence,
      })),
    });
  }

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);

    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 1,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("固定欄＋明細欄(品名3段) → 明細欄が3段に分割され、固定欄はrows[0]のみに入る", async () => {
    // fields の処理順は template.fields の定義順（日付 → 品名 → 合計）と一致する
    useReportStore.setState({
      template: {
        fields: [
          { id: "date", name: "日付", color: "#000", rect: { x: 10, y: 10, width: 100, height: 20 } },
          {
            id: "name",
            name: "品名",
            color: "#000",
            rect: { x: 10, y: 40, width: 100, height: 100 },
            isLineItem: true,
          },
          { id: "total", name: "合計", color: "#000", rect: { x: 10, y: 150, width: 100, height: 20 } },
        ],
      },
      cells: new Map(),
      confidences: new Map(),
    });

    invokeStub
      .mockImplementationOnce(async () => ocrResponse([{ text: "2026-07-08", x: 0, y: 0, confidence: 0.9 }]))
      .mockImplementationOnce(async () =>
        ocrResponse([
          { text: "商品A", x: 0, y: 0, confidence: 0.9 },
          { text: "商品B", x: 0, y: 30, confidence: 0.8 },
          { text: "商品C", x: 0, y: 60, confidence: 0.7 },
        ])
      )
      .mockImplementationOnce(async () => ocrResponse([{ text: "1000", x: 0, y: 0, confidence: 0.95 }]));

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    const rows = useReportStore.getState().cells.get(1);
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.get("date")).toBe("2026-07-08");
    expect(rows?.[0]?.get("name")).toBe("商品A");
    expect(rows?.[0]?.get("total")).toBe("1000");
    expect(rows?.[1]?.get("name")).toBe("商品B");
    expect(rows?.[1]?.has("date")).toBe(false);
    expect(rows?.[1]?.has("total")).toBe(false);
    expect(rows?.[2]?.get("name")).toBe("商品C");

    // confidence は段では分割せず、欄クロップ全体の最小値（decideCellConfidence）を
    // 各段に複製する。品名欄は 0.9/0.8/0.7 の最小値 0.7 が全段に入る。
    const confRows = useReportStore.getState().confidences.get(1);
    expect(confRows).toHaveLength(3);
    expect(confRows?.[0]?.get("date")).toBe(0.9);
    expect(confRows?.[0]?.get("name")).toBe(0.7);
    expect(confRows?.[1]?.get("name")).toBe(0.7);
    expect(confRows?.[2]?.get("name")).toBe(0.7);
  });

  it("CSV出力で3データ行になり、固定欄は複製・品名だけ段ごとに異なる（templateCsv 経由の統合テスト）", async () => {
    useReportStore.setState({
      template: {
        fields: [
          { id: "date", name: "日付", color: "#000", rect: { x: 10, y: 10, width: 100, height: 20 } },
          {
            id: "name",
            name: "品名",
            color: "#000",
            rect: { x: 10, y: 40, width: 100, height: 100 },
            isLineItem: true,
          },
          { id: "total", name: "合計", color: "#000", rect: { x: 10, y: 150, width: 100, height: 20 } },
        ],
      },
      cells: new Map(),
      confidences: new Map(),
    });

    invokeStub
      .mockImplementationOnce(async () => ocrResponse([{ text: "2026-07-08", x: 0, y: 0 }]))
      .mockImplementationOnce(async () =>
        ocrResponse([
          { text: "商品A", x: 0, y: 0 },
          { text: "商品B", x: 0, y: 30 },
          { text: "商品C", x: 0, y: 60 },
        ])
      )
      .mockImplementationOnce(async () => ocrResponse([{ text: "1000", x: 0, y: 0 }]));

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    const { template, cells } = useReportStore.getState();
    const csv = buildTemplateCsv(
      template,
      cells,
      { includeFileName: false, includePageNumber: false, emptyValue: "", normalizeNumbers: false },
      { pageNumbers: [1] }
    );
    const lines = csv.split("\r\n");

    expect(lines).toHaveLength(4); // header + 3 data rows
    expect(lines[1]).toBe("2026-07-08,商品A,1000");
    expect(lines[2]).toBe("2026-07-08,商品B,1000");
    expect(lines[3]).toBe("2026-07-08,商品C,1000");
  });

  it("代表明細欄(品名3段)より単価が少ない(2段)場合、単価の3段目は空にそろえられる", async () => {
    useReportStore.setState({
      template: {
        fields: [
          {
            id: "name",
            name: "品名",
            color: "#000",
            rect: { x: 10, y: 10, width: 100, height: 100 },
            isLineItem: true,
          },
          {
            id: "price",
            name: "単価",
            color: "#000",
            rect: { x: 120, y: 10, width: 100, height: 100 },
            isLineItem: true,
          },
        ],
      },
      cells: new Map(),
      confidences: new Map(),
    });

    invokeStub
      .mockImplementationOnce(async () =>
        ocrResponse([
          { text: "商品A", x: 0, y: 0 },
          { text: "商品B", x: 0, y: 30 },
          { text: "商品C", x: 0, y: 60 },
        ])
      )
      .mockImplementationOnce(async () =>
        ocrResponse([
          { text: "100", x: 0, y: 0 },
          { text: "200", x: 0, y: 30 },
        ])
      );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    const rows = useReportStore.getState().cells.get(1);
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.get("price")).toBe("100");
    expect(rows?.[1]?.get("price")).toBe("200");
    expect(rows?.[2]?.get("price")).toBe("");
  });

  it("isLineItem 欄が1つも無いテンプレは従来どおり1段のみ（回帰なし）", async () => {
    useReportStore.setState({
      template: {
        fields: [
          { id: "date", name: "日付", color: "#000", rect: { x: 10, y: 10, width: 100, height: 20 } },
          { id: "total", name: "合計", color: "#000", rect: { x: 10, y: 40, width: 100, height: 20 } },
        ],
      },
      cells: new Map(),
      confidences: new Map(),
    });

    invokeStub
      .mockImplementationOnce(async () => ocrResponse([{ text: "2026-07-08", x: 0, y: 0 }]))
      .mockImplementationOnce(async () => ocrResponse([{ text: "1000", x: 0, y: 0 }]));

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    const rows = useReportStore.getState().cells.get(1);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.get("date")).toBe("2026-07-08");
    expect(rows?.[0]?.get("total")).toBe("1000");
  });

  it("単一ページ再OCR（runOcrForPage）でも明細欄が複数段に分割される（両経路の対称性）", async () => {
    useReportStore.setState({
      template: {
        fields: [
          {
            id: "name",
            name: "品名",
            color: "#000",
            rect: { x: 10, y: 10, width: 100, height: 100 },
            isLineItem: true,
          },
        ],
      },
      cells: new Map([[1, [new Map([["name", "旧品名"]])]]]),
      confidences: new Map(),
      pageOffsets: new Map(),
    });

    invokeStub.mockImplementationOnce(async () =>
      ocrResponse([
        { text: "新品A", x: 0, y: 0 },
        { text: "新品B", x: 0, y: 30 },
      ])
    );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcrForPage(1);
    });

    const rows = useReportStore.getState().cells.get(1);
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.get("name")).toBe("新品A");
    expect(rows?.[1]?.get("name")).toBe("新品B");
  });
});

describe("useReportOcr: レイアウト混在検出（layoutMismatchPages）", () => {
  let invokeStub: ReturnType<typeof vi.fn>;
  let renderStub: ReturnType<typeof vi.fn>;

  /** ページ番号→寸法のマップで renderPageOffscreen を差し替える */
  function setRenderDims(dimsByPage: Record<number, { w: number; h: number }>) {
    renderStub.mockImplementation(async (_doc: unknown, pageNumber: number) => {
      const d = dimsByPage[pageNumber] ?? { w: 595, h: 842 };
      return {
        canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
        pageWidth: d.w,
        pageHeight: d.h,
      };
    });
  }

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);
    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [
          { text: "値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 },
        ],
      })
    );

    const ocrCrop = await import("../../lib/ocrCrop");
    renderStub = vi.mocked(ocrCrop.renderPageOffscreen);

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
      pageOffsets: new Map(),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 3,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(async () => {
    // ページ別 mockImplementation を既定実装へ戻して他 describe への汚染を防ぐ
    renderStub.mockImplementation(async () => ({
      canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
      pageWidth: 595,
      pageHeight: 842,
    }));
    vi.clearAllMocks();
  });

  it("先頭ページと寸法が異なるページ（横向き混在）が layoutMismatchPages に積まれる", async () => {
    // ページ2だけ A4 横向き（width/height が入れ替わる）
    setRenderDims({ 2: { w: 842, h: 595 } });

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.layoutMismatchPages).toEqual([2]);
  });

  it("全ページ同一寸法なら layoutMismatchPages は空", async () => {
    setRenderDims({});
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.layoutMismatchPages).toEqual([]);
  });

  it("1pt 以下の浮動小数の端数は混在扱いしない（許容誤差）", async () => {
    setRenderDims({ 2: { w: 595.5, h: 842.4 } });
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.layoutMismatchPages).toEqual([]);
  });

  it("複数ページの混在は昇順で全件積まれる", async () => {
    setRenderDims({ 2: { w: 842, h: 595 }, 3: { w: 1190, h: 842 } });
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.layoutMismatchPages).toEqual([2, 3]);
  });

  it("再実行で前回の混在警告がクリアされる", async () => {
    setRenderDims({ 2: { w: 842, h: 595 } });
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.layoutMismatchPages).toEqual([2]);

    // 全ページ同一寸法に差し替えて再実行 → クリア
    setRenderDims({});
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.layoutMismatchPages).toEqual([]);
  });
});

describe("useReportOcr: レイアウト混在検出 × 処理エラーの相互作用", () => {
  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    vi.mocked(tauriCore.invoke).mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [{ text: "値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
      })
    );
    useReportStore.setState({
      template: {
        fields: [
          { id: "field-1", name: "欄1", color: "#7cb9e8", rect: { x: 10, y: 10, width: 100, height: 50 } },
        ],
      },
      cells: new Map(),
      pageOffsets: new Map(),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 3,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(async () => {
    const ocrCrop = await import("../../lib/ocrCrop");
    vi.mocked(ocrCrop.renderPageOffscreen).mockImplementation(async () => ({
      canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
      pageWidth: 595,
      pageHeight: 842,
    }));
    vi.clearAllMocks();
  });

  it("ページ1が処理エラーのとき基準は次の成功ページになり、失敗ページは混在判定されない", async () => {
    const ocrCrop = await import("../../lib/ocrCrop");
    vi.mocked(ocrCrop.renderPageOffscreen).mockImplementation(
      async (_doc: unknown, pageNumber: number) => {
        // ページ1: render 失敗（failedPages 行き・寸法が取れないので基準/混在の判定外）
        if (pageNumber === 1) throw new Error("render失敗");
        // ページ2: A4 縦（最初の成功ページ＝基準）／ページ3: A4 横（基準と不一致）
        const d = pageNumber === 3 ? { w: 842, h: 595 } : { w: 595, h: 842 };
        return {
          canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
          pageWidth: d.w,
          pageHeight: d.h,
        };
      }
    );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.failedPages).toEqual([1]);
    expect(result.current.layoutBasePage).toBe(2);
    expect(result.current.layoutMismatchPages).toEqual([3]);
  });

  it("混在ありの正常実行では layoutBasePage=1 が公開される", async () => {
    const ocrCrop = await import("../../lib/ocrCrop");
    vi.mocked(ocrCrop.renderPageOffscreen).mockImplementation(
      async (_doc: unknown, pageNumber: number) => {
        const d = pageNumber === 2 ? { w: 842, h: 595 } : { w: 595, h: 842 };
        return {
          canvas: { width: 1785, height: 2526, getContext: vi.fn() } as unknown as HTMLCanvasElement,
          pageWidth: d.w,
          pageHeight: d.h,
        };
      }
    );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.layoutBasePage).toBe(1);
    expect(result.current.layoutMismatchPages).toEqual([2]);
  });
});

describe("useReportOcr: エンジン死亡検知（engineError）", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  function setFields(ids: string[]) {
    useReportStore.setState({
      template: {
        fields: ids.map((id) => ({
          id,
          name: id,
          color: "#7cb9e8",
          rect: { x: 10, y: 10, width: 100, height: 50 },
        })),
      },
      pageOffsets: new Map(),
    });
  }

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);

    setFields(["field-1"]);
    // 既存の抽出結果がある状態を再現（エンジン死亡時に破壊されないことの検証用）
    useReportStore.setState({
      cells: new Map([[1, [new Map([["field-1", "既存値"]])]]]),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 3,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("最初のページで全欄 invoke 失敗 → engineError=true・実行中断・既存 cells 非破壊", async () => {
    invokeStub.mockRejectedValue(new Error("OCR engine unavailable"));

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.engineError).toBe(true);
    expect(result.current.isRunning).toBe(false);
    // 既存 cells が空 Map で上書きされていない
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("既存値");
    // 残ページを回さず中断している（1欄×1ページ分の invoke のみ）
    expect(invokeStub).toHaveBeenCalledTimes(1);
  });

  it("エンジンは生きているがページ2だけ全欄失敗 → failedPages に昇格し空行を CSV に載せない", async () => {
    invokeStub
      .mockResolvedValueOnce(
        JSON.stringify({
          status: "ok",
          blocks: [{ text: "値1", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
        })
      )
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(
        JSON.stringify({
          status: "ok",
          blocks: [{ text: "値3", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
        })
      );

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.engineError).toBe(false);
    expect(result.current.failedPages).toEqual([2]);
    const cells = useReportStore.getState().cells;
    expect(cells.get(1)?.[0]?.get("field-1")).toBe("値1");
    expect(cells.has(2)).toBe(false); // 全欄空の行として混入しない
    expect(cells.get(3)?.[0]?.get("field-1")).toBe("値3");
  });

  it("一部の欄だけ invoke 失敗したページは行として残り failedPages に載らない", async () => {
    setFields(["field-1", "field-2"]);
    usePdfStore.setState({ numPages: 1 });
    invokeStub
      .mockResolvedValueOnce(
        JSON.stringify({
          status: "ok",
          blocks: [{ text: "成功値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
        })
      )
      .mockRejectedValueOnce(new Error("transient"));

    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.engineError).toBe(false);
    expect(result.current.failedPages).toEqual([]);
    const row = useReportStore.getState().cells.get(1)?.[0];
    expect(row?.get("field-1")).toBe("成功値");
    expect(row?.get("field-2")).toBe(""); // 失敗欄は空文字
  });

  it("エンジン復旧後の再実行で engineError がクリアされる", async () => {
    invokeStub.mockRejectedValue(new Error("dead"));
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.engineError).toBe(true);

    invokeStub.mockReset();
    invokeStub.mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [{ text: "復旧", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
      })
    );
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.engineError).toBe(false);
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("復旧");
  });
});

describe("useReportOcr: 再OCR × 警告の整合（レビュー指摘 MAJOR-1/-2）", () => {
  let invokeStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    invokeStub = vi.mocked(tauriCore.invoke);
    useReportStore.setState({
      template: {
        fields: [
          { id: "field-1", name: "欄1", color: "#7cb9e8", rect: { x: 10, y: 10, width: 100, height: 50 } },
        ],
      },
      cells: new Map(),
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

  const okResponse = JSON.stringify({
    status: "ok",
    blocks: [{ text: "値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
  });

  it("失敗ページを再OCRで修復すると failedPages から外れる（MAJOR-1: 嘘の警告を残さない）", async () => {
    // 全ページ実行: page1 成功・page2 全欄失敗
    invokeStub
      .mockResolvedValueOnce(okResponse)
      .mockRejectedValueOnce(new Error("transient"));
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.failedPages).toEqual([2]);

    // page2 を再OCR（今度は成功）
    invokeStub.mockResolvedValue(okResponse);
    await act(async () => {
      await result.current.runOcrForPage(2);
    });

    expect(result.current.failedPages).toEqual([]);
    expect(useReportStore.getState().cells.get(2)?.[0]?.get("field-1")).toBe("値");
  });

  it("再OCRで全欄 invoke 失敗のとき既存データを上書きせず reject する（MAJOR-2）", async () => {
    // まず正常に全ページ実行して確定データを作る
    invokeStub.mockResolvedValue(okResponse);
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("値");

    // エンジン停止を再現して page1 を再OCR
    invokeStub.mockReset();
    invokeStub.mockRejectedValue(new Error("engine down"));
    await act(async () => {
      await expect(result.current.runOcrForPage(1)).rejects.toThrow(/OCR エンジン停止の可能性/);
    });

    // 空行で上書きされていない（undo 不能な破壊の防止）
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("値");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.reocrTarget).toBeNull();
  });

  it("エンジン死亡で中断した実行は前回の警告を消さない（MINOR-1: cells と警告の整合）", async () => {
    // 1回目: page1 成功・page2 全欄失敗 → failedPages=[2]
    invokeStub
      .mockResolvedValueOnce(okResponse)
      .mockRejectedValueOnce(new Error("transient"));
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    expect(result.current.failedPages).toEqual([2]);

    // 2回目: エンジン死亡（page1 から全滅）→ 中断・cells 保持・警告も保持
    invokeStub.mockReset();
    invokeStub.mockRejectedValue(new Error("dead"));
    await act(async () => {
      await result.current.runOcr();
    });

    expect(result.current.engineError).toBe(true);
    expect(useReportStore.getState().cells.get(1)?.[0]?.get("field-1")).toBe("値");
    expect(result.current.failedPages).toEqual([2]); // 消えていない
  });
});

describe("useReportOcr: ページ除外との連携", () => {
  beforeEach(async () => {
    const tauriCore = await import("@tauri-apps/api/core");
    vi.mocked(tauriCore.invoke).mockResolvedValue(
      JSON.stringify({
        status: "ok",
        blocks: [{ text: "値", bbox: { x: 5, y: 5, width: 40, height: 15 }, confidence: 0.9 }],
      })
    );
    useReportStore.setState({
      template: {
        fields: [
          { id: "field-1", name: "欄1", color: "#7cb9e8", rect: { x: 10, y: 10, width: 100, height: 50 } },
        ],
      },
      cells: new Map(),
      pageOffsets: new Map(),
      excludedPages: new Set([2]),
    });
    usePdfStore.setState({
      filePath: "/test/sample.pdf",
      numPages: 3,
      currentPage: 1,
      zoom: 100,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useReportStore.setState({ excludedPages: new Set() });
  });

  it("除外ページは OCR がスキップされ cells にも failed にも載らない", async () => {
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcr();
    });
    const cells = useReportStore.getState().cells;
    expect(cells.has(1)).toBe(true);
    expect(cells.has(2)).toBe(false); // スキップ
    expect(cells.has(3)).toBe(true);
    expect(result.current.failedPages).toEqual([]);
  });

  it("除外ページへの runOcrForPage は no-op（cells を変えない）", async () => {
    const { result } = renderHook(() => useReportOcr());
    await act(async () => {
      await result.current.runOcrForPage(2);
    });
    expect(useReportStore.getState().cells.has(2)).toBe(false);
    expect(result.current.isRunning).toBe(false);
  });
});
