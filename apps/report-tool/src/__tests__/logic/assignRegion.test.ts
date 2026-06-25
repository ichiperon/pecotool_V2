import { describe, it, expect } from "vitest";
import {
  assignRegionByCoord,
  assignBlocksToFields,
} from "../../logic/assignRegion";
import type { BoundingBox, ReportField, ReportBlock } from "../../types/report";

// ヘルパ: フィールドを簡単に作る
function makeField(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number
): ReportField {
  return { id, name: id, color: "#000", rect: { x, y, width: w, height: h } };
}

// ヘルパ: bbox
function bb(x: number, y: number, w: number, h: number): BoundingBox {
  return { x, y, width: w, height: h };
}

// ヘルパ: ブロック
function makeBlock(
  bbox: BoundingBox,
  fieldId: string | null = null,
  isManual = false
): ReportBlock {
  return { text: "text", bbox, fieldId, isManual };
}

describe("assignRegionByCoord", () => {
  const fieldA = makeField("A", 0, 0, 100, 100);
  const fieldB = makeField("B", 200, 0, 100, 100);

  it("中心が 1 欄に入る場合 → その欄の id を返す", () => {
    // bbox 中心は (50, 50) → fieldA に入る
    const result = assignRegionByCoord(bb(0, 0, 100, 100), [fieldA, fieldB]);
    expect(result).toBe("A");
  });

  it("中心が別欄に入る場合 → 対応する id を返す", () => {
    // bbox 中心は (250, 50) → fieldB に入る
    const result = assignRegionByCoord(bb(200, 0, 100, 100), [fieldA, fieldB]);
    expect(result).toBe("B");
  });

  it("どの欄にも入らない場合 → null を返す", () => {
    // bbox 中心は (350, 50) → どこにも入らない
    const result = assignRegionByCoord(bb(300, 0, 100, 100), [fieldA, fieldB]);
    expect(result).toBeNull();
  });

  it("fields が空配列の場合 → null を返す", () => {
    const result = assignRegionByCoord(bb(50, 50, 10, 10), []);
    expect(result).toBeNull();
  });

  it("複数欄に中心が入る場合 → 重なり面積最大の欄を返す", () => {
    // fieldC と fieldD が重なる領域にある小さな bbox
    // fieldC: (0,0,200,100) / fieldD: (100,0,200,100)
    // 重なりは x=100〜200 の帯
    const fieldC = makeField("C", 0, 0, 200, 100);
    const fieldD = makeField("D", 100, 0, 200, 100);
    // bbox = (90, 0, 100, 100) → 中心 = (140, 50) → 両方に入る
    // fieldC との重なり: x=[100,190], y=[0,100] → 90*100=9000
    // fieldD との重なり: x=[100,190], y=[0,100] → 90*100=9000 → 同値なら最初に選んだほう
    // 完全に fieldD に寄せる bbox を使う
    // bbox = (150, 0, 100, 100) → 中心 (200, 50) → 両方の右端・左端ちょうど
    // C内: cx=200 <= 0+200=200 ✓, D内: cx=200 >= 100 かつ <= 300 ✓
    // C との重なり: x=[150,200], y=[0,100] → 50*100=5000
    // D との重なり: x=[150,250], y=[0,100] → 100*100=10000 → D を選ぶ
    const result = assignRegionByCoord(bb(150, 0, 100, 100), [fieldC, fieldD]);
    expect(result).toBe("D");
  });

  it("境界線上（ちょうど端）の中心 → 欄に含まれる", () => {
    // fieldA: x=0,y=0,w=100,h=100 → 右端は x=100
    // bbox 中心が x=100, y=50 ちょうど → 含まれる（<= 演算子で判定）
    const result = assignRegionByCoord(bb(100, 0, 0, 100), [fieldA]);
    // 中心は (100, 50)、fieldA の rect x+width = 100 → cx <= 100 は true
    expect(result).toBe("A");
  });

  it("中心が欄の外側 1px → null を返す", () => {
    // bbox 中心が x=100.5 → fieldA の右端(100)より外
    // width=1 → cx = 100.5 + 0.5 = 101 → fieldA の右端より外
    const result = assignRegionByCoord(bb(101, 0, 0, 100), [fieldA]);
    expect(result).toBeNull();
  });
});

describe("assignBlocksToFields", () => {
  const fieldA = makeField("A", 0, 0, 100, 100);
  const fieldB = makeField("B", 200, 0, 100, 100);
  const fields = [fieldA, fieldB];

  it("通常ブロックに fieldId を付与する", () => {
    const blocks: ReportBlock[] = [
      makeBlock(bb(0, 0, 100, 100)),  // 中心(50,50) → A
      makeBlock(bb(200, 0, 100, 100)), // 中心(250,50) → B
    ];
    const result = assignBlocksToFields(blocks, fields);
    expect(result[0].fieldId).toBe("A");
    expect(result[1].fieldId).toBe("B");
  });

  it("未割当のブロックは null になる", () => {
    const blocks: ReportBlock[] = [makeBlock(bb(500, 500, 10, 10))];
    const result = assignBlocksToFields(blocks, fields);
    expect(result[0].fieldId).toBeNull();
  });

  it("isManual=true かつ reAssignManual=false → 既存 fieldId を尊重する", () => {
    const block = makeBlock(bb(0, 0, 100, 100), "B", true); // 座標はA圏内だが fieldId=B
    const result = assignBlocksToFields([block], fields, {
      reAssignManual: false,
    });
    expect(result[0].fieldId).toBe("B");
  });

  it("isManual=true かつ reAssignManual=true → 座標で再判定する", () => {
    const block = makeBlock(bb(0, 0, 100, 100), "B", true); // 座標はA圏内
    const result = assignBlocksToFields([block], fields, {
      reAssignManual: true,
    });
    expect(result[0].fieldId).toBe("A");
  });

  it("isManual=true かつ fieldId=null → 座標判定する", () => {
    const block: ReportBlock = {
      text: "t",
      bbox: bb(0, 0, 100, 100),
      fieldId: null,
      isManual: true,
    };
    const result = assignBlocksToFields([block], fields);
    // fieldId=null なので reAssignManual に関わらず座標判定する
    expect(result[0].fieldId).toBe("A");
  });

  it("元の blocks 配列を変更しない（イミュータブル）", () => {
    const original: ReportBlock[] = [makeBlock(bb(0, 0, 100, 100))];
    assignBlocksToFields(original, fields);
    expect(original[0].fieldId).toBeNull();
  });
});
