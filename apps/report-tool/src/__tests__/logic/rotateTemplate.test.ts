import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveRotation,
  rotateRectCW,
  rotateRectCCW,
  rotateOffsetCW,
  rotateOffsetCCW,
} from "../../logic/rotateTemplate";
import { useReportStore } from "../../store/reportStore";
import { usePdfStore } from "../../store/pdfStore";

const W = 595; // A4縦の幅
const H = 842; // A4縦の高さ

describe("effectiveRotation", () => {
  it("ページ固有 /Rotate とユーザー回転を加算合成し 0..270 に正規化する", () => {
    expect(effectiveRotation(0, 90)).toBe(90);
    expect(effectiveRotation(90, 90)).toBe(180);
    expect(effectiveRotation(270, 90)).toBe(0);
    expect(effectiveRotation(0, -90)).toBe(270);
    expect(effectiveRotation(180, 270)).toBe(90);
  });
});

describe("rotateRectCW / rotateRectCCW", () => {
  const rect = { x: 100, y: 200, width: 50, height: 30 };

  it("CW: 旧左下角が新左上に写り、幅と高さが入れ替わる", () => {
    const r = rotateRectCW(rect, W, H);
    expect(r).toEqual({ x: H - 200 - 30, y: 100, width: 30, height: 50 });
  });

  it("CCW: 旧右上角が新左上に写る", () => {
    const r = rotateRectCCW(rect, W, H);
    expect(r).toEqual({ x: 200, y: W - 100 - 50, width: 30, height: 50 });
  });

  it("CW→CCW の往復で元に戻る（回転後空間の寸法は H×W）", () => {
    const once = rotateRectCW(rect, W, H);
    const back = rotateRectCCW(once, H, W);
    expect(back).toEqual(rect);
  });

  it("原点の rect（左上角）は CW で右上へ写る", () => {
    const r = rotateRectCW({ x: 0, y: 0, width: 10, height: 20 }, W, H);
    expect(r).toEqual({ x: H - 20, y: 0, width: 20, height: 10 });
  });
});

describe("rotateOffsetCW / rotateOffsetCCW", () => {
  it("CW: 右向き(+dx)は下向き(+dy)へ、下向き(+dy)は左向き(-dx)へ", () => {
    expect(rotateOffsetCW({ dx: 5, dy: 0 })).toEqual({ dx: 0, dy: 5 });
    expect(rotateOffsetCW({ dx: 0, dy: 3 })).toEqual({ dx: -3, dy: 0 });
  });

  it("CW→CCW の往復で元に戻る", () => {
    const v = { dx: 7, dy: -4 };
    expect(rotateOffsetCCW(rotateOffsetCW(v))).toEqual(v);
  });
});

describe("reportStore.rotateTemplateSpace", () => {
  const RECT = { x: 100, y: 200, width: 50, height: 30 };

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
  });

  it("欄 rect と pageOffsets を回転後空間へ写像し、cells は保持する", () => {
    useReportStore.getState().addField(RECT, "金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.setState({
      cells: new Map([[1, [new Map([[id, "1000"]])]]]),
      pageOffsets: new Map([[2, { dx: 5, dy: 0 }]]),
    });

    useReportStore.getState().rotateTemplateSpace(90, W, H);

    const f = useReportStore.getState().template.fields[0];
    expect(f.rect).toEqual({ x: H - 200 - 30, y: 100, width: 30, height: 50 });
    expect(useReportStore.getState().pageOffsets.get(2)).toEqual({ dx: 0, dy: 5 });
    // cells は同じ物理領域を指し続けるため保持
    expect(useReportStore.getState().cells.get(1)?.[0]?.get(id)).toBe("1000");
  });

  it("回転はロード境界として undo 履歴をクリアする", () => {
    useReportStore.getState().addField(RECT, "金額");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setCells(new Map([[1, [new Map([[id, "a"]])]]]));
    useReportStore.getState().setCellValue(1, id, "b");
    expect(useReportStore.getState().past).toHaveLength(1);

    useReportStore.getState().rotateTemplateSpace(90, W, H);
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(useReportStore.getState().future).toHaveLength(0);
  });

  it("CW→CCW の往復で rect が元に戻る", () => {
    useReportStore.getState().addField(RECT, "金額");
    useReportStore.getState().rotateTemplateSpace(90, W, H);
    useReportStore.getState().rotateTemplateSpace(-90, H, W); // 回転後空間の寸法で戻す
    expect(useReportStore.getState().template.fields[0].rect).toEqual(RECT);
  });
});

describe("pdfStore.rotation / rotateBy", () => {
  beforeEach(() => {
    usePdfStore.getState().reset();
  });

  it("rotateBy(90) が 0→90→180→270→0 と循環する", () => {
    const s = usePdfStore.getState();
    expect(usePdfStore.getState().rotation).toBe(0);
    s.rotateBy(90);
    expect(usePdfStore.getState().rotation).toBe(90);
    s.rotateBy(90);
    s.rotateBy(90);
    s.rotateBy(90);
    expect(usePdfStore.getState().rotation).toBe(0);
  });

  it("rotateBy(-90) で 0→270", () => {
    usePdfStore.getState().rotateBy(-90);
    expect(usePdfStore.getState().rotation).toBe(270);
  });

  it("別 PDF を開く（setPdf）と回転が 0 に戻る", () => {
    usePdfStore.getState().rotateBy(90);
    usePdfStore.getState().setPdf("/new.pdf", 3);
    expect(usePdfStore.getState().rotation).toBe(0);
  });

  it("reset で回転が 0 に戻る", () => {
    usePdfStore.getState().rotateBy(180 as unknown as 90); // 90刻みAPIのため2回でも同義
    usePdfStore.getState().rotateBy(90);
    usePdfStore.getState().reset();
    expect(usePdfStore.getState().rotation).toBe(0);
  });
});
