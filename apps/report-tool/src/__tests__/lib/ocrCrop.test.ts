import { describe, it, expect } from "vitest";
import { computeCropRect } from "../../lib/ocrCrop";

describe("computeCropRect", () => {
  describe("基本変換", () => {
    it("renderScale=1, canvas 内に収まる場合 → page座標 = 物理px座標", () => {
      const rect = { x: 10, y: 20, width: 100, height: 50 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.x).toBe(10);
      expect(result.y).toBe(20);
      expect(result.width).toBe(100);
      expect(result.height).toBe(50);
    });

    it("renderScale=2 → 物理px は page座標の 2 倍", () => {
      const rect = { x: 10, y: 20, width: 100, height: 50 };
      const result = computeCropRect(rect, 2.0, 2000, 1500);
      expect(result.x).toBe(20);
      expect(result.y).toBe(40);
      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
    });

    it("renderScale=3 → 物理px は page座標の 3 倍", () => {
      const rect = { x: 5, y: 10, width: 30, height: 20 };
      const result = computeCropRect(rect, 3.0, 2000, 1500);
      expect(result.x).toBe(15);
      expect(result.y).toBe(30);
      expect(result.width).toBe(90);
      expect(result.height).toBe(60);
    });
  });

  describe("クランプ: 左上端の処理", () => {
    it("x<0 の場合は x=0 にクランプされる", () => {
      const rect = { x: -5, y: 10, width: 50, height: 30 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.x).toBe(0);
    });

    it("y<0 の場合は y=0 にクランプされる", () => {
      const rect = { x: 10, y: -5, width: 50, height: 30 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.y).toBe(0);
    });

    it("x<0 にクランプされると width が狭まる", () => {
      // x=-5 → 0 にクランプ。x2 = ceil(-5+50) = 45。width = 45-0 = 45
      const rect = { x: -5, y: 0, width: 50, height: 10 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.x).toBe(0);
      expect(result.width).toBe(45);
    });
  });

  describe("クランプ: 右下端の処理", () => {
    it("x+width が canvas 幅を超えると width がクランプされる", () => {
      // rect.x=700, width=200 → x2=900 > 800 → x2=800, width=100
      const rect = { x: 700, y: 0, width: 200, height: 10 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.x).toBe(700);
      expect(result.width).toBe(100);
    });

    it("y+height が canvas 高さを超えると height がクランプされる", () => {
      const rect = { x: 0, y: 550, width: 50, height: 100 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.y).toBe(550);
      expect(result.height).toBe(50);
    });
  });

  describe("width/height がゼロになるケース", () => {
    it("完全に canvas の外（右側）にある場合 → width=0", () => {
      const rect = { x: 900, y: 0, width: 50, height: 10 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.width).toBe(0);
    });

    it("完全に canvas の外（下側）にある場合 → height=0", () => {
      const rect = { x: 0, y: 700, width: 50, height: 100 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.height).toBe(0);
    });

    it("width=0 の rect → width=0 を返す", () => {
      const rect = { x: 10, y: 10, width: 0, height: 20 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.width).toBe(0);
    });

    it("height=0 の rect → height=0 を返す", () => {
      const rect = { x: 10, y: 10, width: 20, height: 0 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.height).toBe(0);
    });
  });

  describe("renderScale=3.0 の典型的なシナリオ", () => {
    it("A4 縦（595×842 pt）のキャンバス中央に 100×50pt の欄を配置", () => {
      const scale = 3.0;
      const canvasW = Math.round(595 * scale); // 1785
      const canvasH = Math.round(842 * scale); // 2526
      const rect = { x: 100, y: 200, width: 100, height: 50 };
      const result = computeCropRect(rect, scale, canvasW, canvasH);
      expect(result.x).toBe(Math.floor(100 * scale));     // 300
      expect(result.y).toBe(Math.floor(200 * scale));     // 600
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    });

    it("canvas 境界ちょうどの欄 → クロップ結果が canvas に収まる", () => {
      const scale = 3.0;
      const canvasW = 900;
      const canvasH = 600;
      // page座標 (0,0)〜(300,200) → scale=3 で canvas全体
      const rect = { x: 0, y: 0, width: 300, height: 200 };
      const result = computeCropRect(rect, scale, canvasW, canvasH);
      expect(result.x + result.width).toBeLessThanOrEqual(canvasW);
      expect(result.y + result.height).toBeLessThanOrEqual(canvasH);
    });
  });

  describe("浮動小数点の floor/ceil", () => {
    it("page座標が整数でないとき floor で x,y を決め ceil で右下端を決める", () => {
      // x=10.3 → floor(10.3)=10, x2=ceil(10.3+50.7)=ceil(61.0)=61, width=51
      const rect = { x: 10.3, y: 20.6, width: 50.7, height: 30.9 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result.x).toBe(10);       // floor(10.3)
      expect(result.y).toBe(20);       // floor(20.6)
      expect(result.width).toBe(51);   // ceil(61.0)-10 = 61-10 = 51
    });
  });

  describe("境界ケース追加（ブリーフ#3: 完全canvas外・複合負座標・render_scale 2.0/3.0）", () => {
    it("x,y ともに負で欄全体が左上方向に canvas 外 → x=0,y=0,width=0,height=0", () => {
      // rawX=-100,rawW=20 → x2=ceil(-80)=-80 → x=0, width=max(0,-80-0)=0（y も同様）
      const rect = { x: -100, y: -100, width: 20, height: 20 };
      const result = computeCropRect(rect, 1.0, 800, 600);
      expect(result).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it("renderScale=2.0 で負座標の開始点と右下はみ出しが同時に発生 → canvas いっぱいにクランプされる", () => {
      const rect = { x: -10, y: -10, width: 500, height: 400 };
      const result = computeCropRect(rect, 2.0, 800, 600);
      expect(result).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    });

    it("renderScale=3.0 で欄が canvas よりはるかに大きい（四方すべてはみ出し）→ canvas ぴったりに収まる", () => {
      const scale = 3.0;
      const canvasW = Math.round(595 * scale); // 1785
      const canvasH = Math.round(842 * scale); // 2526
      const rect = { x: -1000, y: -1000, width: 5000, height: 5000 };
      const result = computeCropRect(rect, scale, canvasW, canvasH);
      expect(result).toEqual({ x: 0, y: 0, width: canvasW, height: canvasH });
    });

    it("canvasWidth=0 の退化ケース → width は 0 にクランプされる（height は影響を受けない）", () => {
      const rect = { x: 5, y: 5, width: 50, height: 50 };
      const result = computeCropRect(rect, 1.0, 0, 600);
      expect(result.x).toBe(5);
      expect(result.width).toBe(0);
      expect(result.height).toBe(50);
    });

    it("renderScale=2.0 で x のみ負・非整数の欄 → floor/ceil とクランプが両立する", () => {
      // rawX=-7 → x=max(0,floor(-7))=0, x2=ceil(-7+40.4)=ceil(33.4)=34 → width=34
      // rawY=20,rawH=30 → y=20, y2=ceil(50)=50 → height=30（負座標ではない側は通常どおり）
      const rect = { x: -3.5, y: 10, width: 20.2, height: 15 };
      const result = computeCropRect(rect, 2.0, 800, 600);
      expect(result).toEqual({ x: 0, y: 20, width: 34, height: 30 });
    });
  });
});
