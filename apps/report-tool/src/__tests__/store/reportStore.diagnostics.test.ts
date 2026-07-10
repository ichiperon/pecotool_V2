import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore } from "../../store/reportStore";

/**
 * OCR 診断状態（failedPages / layoutMismatchPages / layoutBasePage）の store 側検証。
 *
 * #447 (PCT-211) で useReportOcr のローカル state から reportStore へ移した際の
 * 受入基準を縛る:
 * - 診断状態は undo/redo に巻き込まれない（HistorySnapshot に含めない・past に積まない）
 * - resetExtractedData（PDF 差し替え等のロード境界）でクリアされる
 * - setFailedPages は関数形式で差分更新できる（再OCR成功ページの警告解除に使う）
 */

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

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
    excludedPages: new Set(),
    failedPages: [],
    layoutMismatchPages: [],
    layoutBasePage: null,
  });
});

/** 欄を1つ追加して id を返す（addField は undo 対象外なので履歴は汚れない） */
function makeField(name = "金額"): string {
  useReportStore.getState().addField(SAMPLE_RECT, name);
  const fields = useReportStore.getState().template.fields;
  return fields[fields.length - 1].id;
}

describe("診断状態の setter", () => {
  it("setFailedPages: 配列で置換できる", () => {
    useReportStore.getState().setFailedPages([2, 5]);
    expect(useReportStore.getState().failedPages).toEqual([2, 5]);
  });

  it("setFailedPages: 関数形式で現在値から差分更新できる（再OCR成功ページの警告解除パターン）", () => {
    useReportStore.getState().setFailedPages([2, 5, 9]);
    // useReportOcr.runOcrForPage が再OCR成功時に行うのと同じフィルタ更新
    useReportStore.getState().setFailedPages((prev) => prev.filter((p) => p !== 5));
    expect(useReportStore.getState().failedPages).toEqual([2, 9]);
  });

  it("setLayoutMismatchPages: 配列で置換できる", () => {
    useReportStore.getState().setLayoutMismatchPages([3]);
    expect(useReportStore.getState().layoutMismatchPages).toEqual([3]);
  });

  it("setLayoutBasePage: number と null を設定できる", () => {
    useReportStore.getState().setLayoutBasePage(1);
    expect(useReportStore.getState().layoutBasePage).toBe(1);
    useReportStore.getState().setLayoutBasePage(null);
    expect(useReportStore.getState().layoutBasePage).toBeNull();
  });
});

describe("診断状態は undo/redo に巻き込まれない（#447）", () => {
  it("診断状態の更新は undo 履歴（past）に積まれない", () => {
    useReportStore.getState().setFailedPages([2]);
    useReportStore.getState().setLayoutMismatchPages([3]);
    useReportStore.getState().setLayoutBasePage(1);
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(useReportStore.getState().future).toHaveLength(0);
  });

  it("セル編集を undo しても診断状態は巻き戻らない（cells だけ戻る）", () => {
    const id = makeField();
    // setCells はロード境界＝履歴クリア。この時点の診断状態が「OCR 直後」を模す
    useReportStore.getState().setCells(new Map([[1, [new Map([[id, "100"]])]]]));
    useReportStore.getState().setFailedPages([4]);

    // セル編集（履歴に積まれる）→ その後に診断状態が更新される
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().setFailedPages([4, 7]);

    useReportStore.getState().undo();

    // cells は編集前へ戻るが、診断状態はスナップショット対象外なので最新のまま
    expect(useReportStore.getState().cells.get(1)?.[0]?.get(id)).toBe("100");
    expect(useReportStore.getState().failedPages).toEqual([4, 7]);
  });

  it("redo でも診断状態は変わらない", () => {
    const id = makeField();
    useReportStore.getState().setCells(new Map([[1, [new Map([[id, "100"]])]]]));
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().setFailedPages([4, 7]);
    useReportStore.getState().undo();

    useReportStore.getState().redo();

    expect(useReportStore.getState().cells.get(1)?.[0]?.get(id)).toBe("200");
    expect(useReportStore.getState().failedPages).toEqual([4, 7]);
  });
});

describe("resetExtractedData と診断状態（#447）", () => {
  it("resetExtractedData で failedPages / layoutMismatchPages / layoutBasePage がクリアされる", () => {
    useReportStore.getState().setFailedPages([2, 5]);
    useReportStore.getState().setLayoutMismatchPages([3]);
    useReportStore.getState().setLayoutBasePage(1);

    useReportStore.getState().resetExtractedData();

    const s = useReportStore.getState();
    expect(s.failedPages).toEqual([]);
    expect(s.layoutMismatchPages).toEqual([]);
    expect(s.layoutBasePage).toBeNull();
  });
});
