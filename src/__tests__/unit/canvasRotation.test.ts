/**
 * canvasRotation.ts の純粋関数の単体テスト
 *
 * 検証項目:
 *   1. bboxToRotatedScreen / rotatedScreenToBbox の往復一致 (0/90/180/270)
 *   2. applyRotationTransform が r=0 のとき ctx.transform を呼ばない
 *   3. applyRotationTransform が各 rotation で正しい変換行列を適用する
 *   4. #405 (PCT-174): bboxRectToRotatedScreenRect / rotatedScreenRectToBbox
 *      の往復一致・寸法 swap（回転90/270で width/height が入れ替わる）
 */
import { describe, it, expect, vi } from "vitest";
import {
  bboxToRotatedScreen,
  rotatedScreenToBbox,
  bboxRectToRotatedScreenRect,
  rotatedScreenRectToBbox,
  applyRotationTransform,
  type CanvasRotationParams,
  type RectXYWH,
} from "../../utils/canvasRotation";

const VW = 400;
const VH = 300;

const paramsOf = (rotation: number): CanvasRotationParams => ({ rotation, vw: VW, vh: VH });

// 往復テストのヘルパー
function roundTrip(x: number, y: number, rotation: number) {
  const params = paramsOf(rotation);
  const screen = bboxToRotatedScreen(x, y, params);
  const back = rotatedScreenToBbox(screen.x, screen.y, params);
  return back;
}

describe("bboxToRotatedScreen / rotatedScreenToBbox 往復一致", () => {
  const testPoints = [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: VW, y: VH },
    { x: 123.456, y: 78.9 },
  ];

  describe("rotation=0", () => {
    it("r=0 は恒等変換", () => {
      for (const { x, y } of testPoints) {
        const result = bboxToRotatedScreen(x, y, paramsOf(0));
        expect(result).toEqual({ x, y });
      }
    });
  });

  for (const rotation of [0, 90, 180, 270]) {
    describe(`rotation=${rotation}`, () => {
      // #429 (PCT-198) 是正: 旧実装は rotation=0 専用の early-return アサートを
      // 全 rotation 共通の it として定義しており、90/180/270 では `if (rotation !== 0) return`
      // により本文実行前に return してアサート 0 個のまま常時 PASS していた（テスト数の水増し）。
      // rotation!=0 では round-trip 一致に加え、恒等変換ではない（座標が変化する）ことを
      // 明示的にアサートし、変換が実際に適用されていることを検証する。
      if (rotation !== 0) {
        it(`r=${rotation} は恒等変換ではない（少なくとも1点は座標が変化する）`, () => {
          const changed = testPoints.some(({ x, y }) => {
            const result = bboxToRotatedScreen(x, y, paramsOf(rotation));
            return result.x !== x || result.y !== y;
          });
          expect(changed).toBe(true);
        });
      }

      for (const { x, y } of testPoints) {
        it(`(${x}, ${y}) が往復で一致する`, () => {
          const result = roundTrip(x, y, rotation);
          expect(result.x).toBeCloseTo(x, 8);
          expect(result.y).toBeCloseTo(y, 8);
        });
      }
    });
  }
});

// 注: VW=400, VH=300 と vw≠vh にしているのは、R=90/270 の vw/vh 取り違え
// (PCT-119) を検出するため。正方形にすると swap バグが隠れる。
// 期待値は pdfjs getViewport(R) の変換と一致する（マリンが pdf.mjs と数値突合）。
describe("bboxToRotatedScreen の具体値検証", () => {
  it("r=90: (100, 50) → (VW - 50, 100) = (350, 100)", () => {
    // r=90 変換: (x, y) → (vw - y, x)
    const result = bboxToRotatedScreen(100, 50, paramsOf(90));
    expect(result.x).toBeCloseTo(VW - 50); // 350
    expect(result.y).toBeCloseTo(100);
  });

  it("r=180: (100, 50) → (VW - 100, VH - 50) = (300, 250)", () => {
    const result = bboxToRotatedScreen(100, 50, paramsOf(180));
    expect(result.x).toBeCloseTo(VW - 100); // 300
    expect(result.y).toBeCloseTo(VH - 50); // 250
  });

  it("r=270: (100, 50) → (50, VH - 100) = (50, 200)", () => {
    // r=270 変換: (x, y) → (y, vh - x)
    const result = bboxToRotatedScreen(100, 50, paramsOf(270));
    expect(result.x).toBeCloseTo(50);
    expect(result.y).toBeCloseTo(VH - 100); // 200
  });

  it("r=0: (100, 50) は変化しない", () => {
    const result = bboxToRotatedScreen(100, 50, paramsOf(0));
    expect(result).toEqual({ x: 100, y: 50 });
  });
});

describe("rotatedScreenToBbox の具体値検証 (逆変換)", () => {
  it("r=90: screen(350, 100) → bbox(100, 50)", () => {
    // 逆変換: x = ry = 100, y = vw - rx = 400 - 350 = 50
    const result = rotatedScreenToBbox(350, 100, paramsOf(90));
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(50);
  });

  it("r=180: screen(300, 250) → bbox(100, 50)", () => {
    const result = rotatedScreenToBbox(300, 250, paramsOf(180));
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(50);
  });

  it("r=270: screen(50, 200) → bbox(100, 50)", () => {
    // 逆変換: x = vh - ry = 300 - 200 = 100, y = rx = 50
    const result = rotatedScreenToBbox(50, 200, paramsOf(270));
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(50);
  });
});

describe("applyRotationTransform", () => {
  const makeCtx = () => ({
    transform: vi.fn(),
  }) as unknown as CanvasRenderingContext2D;

  it("r=0 のとき ctx.transform を呼ばない", () => {
    const ctx = makeCtx();
    applyRotationTransform(ctx, paramsOf(0));
    expect(ctx.transform).not.toHaveBeenCalled();
  });

  it("r=90: ctx.transform(0, 1, -1, 0, VW, 0) を呼ぶ", () => {
    const ctx = makeCtx();
    applyRotationTransform(ctx, paramsOf(90));
    expect(ctx.transform).toHaveBeenCalledWith(0, 1, -1, 0, VW, 0);
  });

  it("r=180: ctx.transform(-1, 0, 0, -1, VW, VH) を呼ぶ", () => {
    const ctx = makeCtx();
    applyRotationTransform(ctx, paramsOf(180));
    expect(ctx.transform).toHaveBeenCalledWith(-1, 0, 0, -1, VW, VH);
  });

  it("r=270: ctx.transform(0, -1, 1, 0, 0, VH) を呼ぶ", () => {
    const ctx = makeCtx();
    applyRotationTransform(ctx, paramsOf(270));
    expect(ctx.transform).toHaveBeenCalledWith(0, -1, 1, 0, 0, VH);
  });

  it("rotation=360 (mod 0) は r=0 と同じく ctx.transform を呼ばない", () => {
    const ctx = makeCtx();
    applyRotationTransform(ctx, { rotation: 360, vw: VW, vh: VH });
    expect(ctx.transform).not.toHaveBeenCalled();
  });
});

// #405 (PCT-174): 範囲指定 OCR の crop 領域変換で使う rect 版 helper。
// bboxRectToRotatedScreenRect は 4隅を bboxToRotatedScreen で変換して
// bounding box を取る実装のため、往復一致と寸法 swap を実測で縛る。
describe("bboxRectToRotatedScreenRect / rotatedScreenRectToBbox 往復一致", () => {
  const testRects: RectXYWH[] = [
    { x: 0, y: 0, width: 50, height: 30 },
    { x: 100, y: 50, width: 80, height: 40 },
    { x: 10.5, y: 20.25, width: 33.3, height: 12.75 },
    { x: 0, y: 0, width: VW, height: VH }, // ページ全体相当
  ];

  for (const rotation of [0, 90, 180, 270]) {
    describe(`rotation=${rotation}`, () => {
      for (const rect of testRects) {
        it(`rect(${rect.x}, ${rect.y}, ${rect.width}x${rect.height}) が往復で一致する`, () => {
          const params = paramsOf(rotation);
          const screenRect = bboxRectToRotatedScreenRect(rect, params);
          const back = rotatedScreenRectToBbox(screenRect, params);
          expect(back.x).toBeCloseTo(rect.x, 8);
          expect(back.y).toBeCloseTo(rect.y, 8);
          expect(back.width).toBeCloseTo(rect.width, 8);
          expect(back.height).toBeCloseTo(rect.height, 8);
        });
      }
    });
  }

  it("r=0 は恒等変換", () => {
    const rect = { x: 10, y: 20, width: 50, height: 30 };
    const result = bboxRectToRotatedScreenRect(rect, paramsOf(0));
    expect(result).toEqual(rect);
  });
});

describe("bboxRectToRotatedScreenRect: 回転90/270での寸法 swap", () => {
  // VW=400, VH=300 (vw≠vh) で、R=90/270 のとき width/height が
  // 入れ替わることを実測で縛る（PCT-119 系の vw/vh 取り違えバグの再発防止）。
  const rect: RectXYWH = { x: 100, y: 50, width: 80, height: 40 };

  it("r=90: 変換後の width/height は元の height/width に一致する", () => {
    const result = bboxRectToRotatedScreenRect(rect, paramsOf(90));
    expect(result.width).toBeCloseTo(rect.height); // 40
    expect(result.height).toBeCloseTo(rect.width); // 80
  });

  it("r=180: 変換後の width/height は元のまま (swap なし)", () => {
    const result = bboxRectToRotatedScreenRect(rect, paramsOf(180));
    expect(result.width).toBeCloseTo(rect.width); // 80
    expect(result.height).toBeCloseTo(rect.height); // 40
  });

  it("r=270: 変換後の width/height は元の height/width に一致する", () => {
    const result = bboxRectToRotatedScreenRect(rect, paramsOf(270));
    expect(result.width).toBeCloseTo(rect.height); // 40
    expect(result.height).toBeCloseTo(rect.width); // 80
  });

  it("r=90: 具体値 — bbox rect(100,50,80x40) → screen rect", () => {
    // 4隅: (100,50)→(350,100) (180,50)→(350,180) (100,90)→(310,100) (180,90)→(310,180)
    // (bboxToRotatedScreen: (x,y) → (vw-y, x))
    // min/max: x∈[310,350] y∈[100,180]
    const result = bboxRectToRotatedScreenRect(rect, paramsOf(90));
    expect(result.x).toBeCloseTo(310);
    expect(result.y).toBeCloseTo(100);
    expect(result.width).toBeCloseTo(40);
    expect(result.height).toBeCloseTo(80);
  });
});
