import { describe, it, expect } from "vitest";
import {
  pageToDeviceFactor,
  pageRectToDevice,
  clientPointToPage,
  dragToPageRect,
} from "../../lib/coordinates";

describe("pageToDeviceFactor", () => {
  it("zoom=100, dpr=1 のとき factor=1.0", () => {
    expect(pageToDeviceFactor({ zoom: 100, dpr: 1 })).toBeCloseTo(1.0);
  });

  it("zoom=200, dpr=2 のとき factor=4.0", () => {
    expect(pageToDeviceFactor({ zoom: 200, dpr: 2 })).toBeCloseTo(4.0);
  });

  it("zoom=150, dpr=1 のとき factor=1.5", () => {
    expect(pageToDeviceFactor({ zoom: 150, dpr: 1 })).toBeCloseTo(1.5);
  });

  it("zoom=0 のとき factor > 0 でゼロ除算しない", () => {
    const factor = pageToDeviceFactor({ zoom: 0, dpr: 1 });
    expect(factor).toBeGreaterThan(0);
  });

  it("zoom=-100 でもゼロ除算しない", () => {
    const factor = pageToDeviceFactor({ zoom: -100, dpr: 1 });
    expect(factor).toBeGreaterThan(0);
  });

  it("dpr=2, zoom=100 のとき factor=2.0", () => {
    expect(pageToDeviceFactor({ zoom: 100, dpr: 2 })).toBeCloseTo(2.0);
  });
});

describe("pageRectToDevice", () => {
  it("factor=1 のとき入力と同じ値を返す", () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    const result = pageRectToDevice(rect, { zoom: 100, dpr: 1 });
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(50);
  });

  it("factor=2 のとき全成分が2倍になる", () => {
    const rect = { x: 5, y: 10, width: 30, height: 20 };
    const result = pageRectToDevice(rect, { zoom: 200, dpr: 1 });
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(60);
    expect(result.height).toBeCloseTo(40);
  });

  it("zoom=100, dpr=2 のとき全成分が2倍（高DPI）", () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    const result = pageRectToDevice(rect, { zoom: 100, dpr: 2 });
    expect(result.width).toBeCloseTo(200);
    expect(result.height).toBeCloseTo(100);
  });
});

describe("clientPointToPage", () => {
  it("zoom=100, dpr=1: cssLocal座標がそのままpage座標になる", () => {
    const result = clientPointToPage(
      { x: 110, y: 220 },
      { left: 10, top: 20 },
      { zoom: 100, dpr: 1 }
    );
    // cssLocal = (110-10, 220-20) = (100, 200)
    // page = cssLocal / (zoom/100) = (100/1, 200/1) = (100, 200)
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(200);
  });

  it("zoom=200, dpr=1: page座標はcssLocalの半分", () => {
    const result = clientPointToPage(
      { x: 110, y: 220 },
      { left: 10, top: 20 },
      { zoom: 200, dpr: 1 }
    );
    // cssLocal = (100, 200); page = (100/2, 200/2) = (50, 100)
    expect(result.x).toBeCloseTo(50);
    expect(result.y).toBeCloseTo(100);
  });

  it("dpr=1 と dpr=2 で同じpage座標を返す（dprが打ち消される）", () => {
    const client = { x: 150, y: 250 };
    const canvasRect = { left: 50, top: 50 };
    const params100 = { zoom: 100, dpr: 1 };
    const params100dpr2 = { zoom: 100, dpr: 2 };

    const resultDpr1 = clientPointToPage(client, canvasRect, params100);
    const resultDpr2 = clientPointToPage(client, canvasRect, params100dpr2);

    expect(resultDpr1.x).toBeCloseTo(resultDpr2.x);
    expect(resultDpr1.y).toBeCloseTo(resultDpr2.y);
  });

  it("zoom=200, dpr=1とdpr=2で同じpage座標を返す", () => {
    const client = { x: 300, y: 400 };
    const canvasRect = { left: 100, top: 100 };

    const r1 = clientPointToPage(client, canvasRect, { zoom: 200, dpr: 1 });
    const r2 = clientPointToPage(client, canvasRect, { zoom: 200, dpr: 2 });

    expect(r1.x).toBeCloseTo(r2.x);
    expect(r1.y).toBeCloseTo(r2.y);
  });

  it("canvasRectのleft/topが正しく減算される", () => {
    const result = clientPointToPage(
      { x: 50, y: 80 },
      { left: 30, top: 60 },
      { zoom: 100, dpr: 1 }
    );
    // cssLocal = (50-30, 80-60) = (20, 20)
    expect(result.x).toBeCloseTo(20);
    expect(result.y).toBeCloseTo(20);
  });
});

describe("dragToPageRect", () => {
  it("左上→右下ドラッグで正のwidth/heightを返す", () => {
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 10, y: 20 },
      { x: 110, y: 120 },
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(100);
  });

  it("右下→左上ドラッグ（逆方向）でもwidth/heightが正になる", () => {
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 110, y: 120 },
      { x: 10, y: 20 },
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(100);
  });

  it("右上→左下ドラッグでもwidth/heightが正になる", () => {
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 110, y: 20 },
      { x: 10, y: 120 },
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(100);
  });

  it("canvasRectのoffsetが正しく考慮される", () => {
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 50, top: 50 };
    const result = dragToPageRect(
      { x: 60, y: 70 },  // cssLocal = (10, 20)
      { x: 160, y: 170 }, // cssLocal = (110, 120)
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(100);
  });

  it("zoom=200 のとき page座標はCSS座標の半分スケール", () => {
    const params = { zoom: 200, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 0, y: 0 },
      { x: 200, y: 100 },
      canvasRect,
      params
    );
    // cssLocal は (0,0)→(200,100)。page = cssLocal / (zoom/100) = (200/2, 100/2) = (100, 50)
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(50);
  });

  it("rectのx/yはMath.minで左上基点になる", () => {
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 200, y: 300 },
      { x: 50, y: 80 },
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(50);
    expect(result.y).toBeCloseTo(80);
  });

  it("左下→右上ドラッグ（第4象限）でもwidth/height が正になる", () => {
    // あやめ追加: 4象限目ドラッグ（startがendより左下・右上の組み合わせ）
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 10, y: 120 },
      { x: 110, y: 20 },
      canvasRect,
      params
    );
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(100);
  });

  it("同一点ドラッグ: start==end のとき width=height=0 を返す", () => {
    // あやめ追加: 誤クリック境界（width/height が正の値でないため addField は呼ばれない）
    const params = { zoom: 100, dpr: 1 };
    const canvasRect = { left: 0, top: 0 };
    const result = dragToPageRect(
      { x: 50, y: 80 },
      { x: 50, y: 80 },
      canvasRect,
      params
    );
    expect(result.width).toBeCloseTo(0);
    expect(result.height).toBeCloseTo(0);
  });
});

describe("係数整合性: pageRectToDevice と clientPointToPage の逆引き", () => {
  it("zoom=150,dpr=2: page幅WがdeviceでW*factorになり、cssWidth逆引きで元のWに戻る", () => {
    // あやめ追加（最重要）: pageRectToDevice と clientPointToPage の変換係数が整合することを確認。
    // pageRectToDevice でW→device、deviceWidth/dpr でCSSサイズ、clientPointToPage で page座標に戻す。
    const params = { zoom: 150, dpr: 2 };
    const W = 200; // page幅
    const pageRect = { x: 0, y: 0, width: W, height: 100 };

    // page → device
    const deviceRect = pageRectToDevice(pageRect, params);
    // factor = (150/100)*2 = 3.0
    expect(deviceRect.width).toBeCloseTo(W * 3);

    // device幅 / dpr = CSS上の幅
    const cssWidth = deviceRect.width / params.dpr;
    // cssWidth = (W * 3) / 2 = W * 1.5

    // CSS幅の端点（CSS座標）を clientPointToPage で page座標に逆引き
    // canvasRect.left=0 とするとclientX=cssWidthがcssLocal=cssWidth
    const restored = clientPointToPage(
      { x: cssWidth, y: 0 },
      { left: 0, top: 0 },
      params
    );
    // page = cssLocal * dpr / factor = cssWidth * 2 / 3 = (W*1.5)*2/3 = W
    expect(restored.x).toBeCloseTo(W);
  });
});
