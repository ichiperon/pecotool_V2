import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore, FIELD_COLOR_PALETTE } from "../../store/reportStore";

// zustand ストアはモジュールシングルトンなので各テスト前にリセットする
beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    mode: "idle",
    selectedFieldId: null,
  });
});

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 50 };

describe("addField", () => {
  it("フィールドを 1 件追加できる", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "金額");
    const { fields } = useReportStore.getState().template;
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe("金額");
    expect(fields[0].rect).toEqual(SAMPLE_RECT);
  });

  it("id が一意の文字列で採番される", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().addField(SAMPLE_RECT, "B");
    const { fields } = useReportStore.getState().template;
    // id の形式ではなく一意性を検証する（UUID ベースのため固定パターンに依存しない）
    expect(fields[0].id).not.toBe(fields[1].id);
    expect(typeof fields[0].id).toBe("string");
    expect(fields[0].id.length).toBeGreaterThan(0);
  });

  it("連続 addField で id がすべて一意である", () => {
    for (let i = 0; i < 5; i++) {
      useReportStore.getState().addField(SAMPLE_RECT, `欄${i + 1}`);
    }
    const { fields } = useReportStore.getState().template;
    const ids = fields.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("name 省略時は自動命名される（欄 n 形式）", () => {
    useReportStore.getState().addField(SAMPLE_RECT);
    const { fields } = useReportStore.getState().template;
    expect(fields[0].name).toMatch(/^欄 \d+$/);
  });

  it("色はパレットから未使用色を自動割当する", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    const color1 = useReportStore.getState().template.fields[0].color;
    useReportStore.getState().addField(SAMPLE_RECT, "B");
    const color2 = useReportStore.getState().template.fields[1].color;
    expect(FIELD_COLOR_PALETTE).toContain(color1);
    expect(FIELD_COLOR_PALETTE).toContain(color2);
    // 最初の 2 色は別色であるべき
    expect(color1).not.toBe(color2);
  });

  it("パレット全色使用後は循環する（8色超え）", () => {
    // 8 色すべてを埋める
    for (let i = 0; i < FIELD_COLOR_PALETTE.length; i++) {
      useReportStore.getState().addField(SAMPLE_RECT, `欄${i}`);
    }
    // 9 枚目を追加
    useReportStore.getState().addField(SAMPLE_RECT, "追加欄");
    const { fields } = useReportStore.getState().template;
    const lastColor = fields[fields.length - 1].color;
    // 循環するのでパレット内の値が使われる
    expect(FIELD_COLOR_PALETTE).toContain(lastColor);
  });
});

describe("removeField", () => {
  it("指定した id のフィールドを削除する", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().removeField(id);
    expect(useReportStore.getState().template.fields).toHaveLength(0);
  });

  it("存在しない id を渡しても他のフィールドに影響しない", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().removeField("non-existent");
    expect(useReportStore.getState().template.fields).toHaveLength(1);
  });

  it("削除した id が selectedFieldId だった場合 → null になる", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().selectField(id);
    expect(useReportStore.getState().selectedFieldId).toBe(id);
    useReportStore.getState().removeField(id);
    expect(useReportStore.getState().selectedFieldId).toBeNull();
  });

  it("削除した id が selectedFieldId でない場合 → selectedFieldId を維持する", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().addField(SAMPLE_RECT, "B");
    const fields = useReportStore.getState().template.fields;
    const idA = fields[0].id;
    const idB = fields[1].id;
    useReportStore.getState().selectField(idA);
    useReportStore.getState().removeField(idB);
    expect(useReportStore.getState().selectedFieldId).toBe(idA);
  });
});

describe("renameField", () => {
  it("指定した id のフィールド名を変更する", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "旧名");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().renameField(id, "新名");
    expect(useReportStore.getState().template.fields[0].name).toBe("新名");
  });

  it("他フィールドには影響しない", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().addField(SAMPLE_RECT, "B");
    const { fields } = useReportStore.getState().template;
    useReportStore.getState().renameField(fields[0].id, "A改");
    const updated = useReportStore.getState().template.fields;
    expect(updated[0].name).toBe("A改");
    expect(updated[1].name).toBe("B");
  });
});

describe("setFieldColor", () => {
  it("指定した id の色を変更できる", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    const id = useReportStore.getState().template.fields[0].id;
    useReportStore.getState().setFieldColor(id, "#ff0000");
    expect(useReportStore.getState().template.fields[0].color).toBe("#ff0000");
  });
});

describe("clearTemplate", () => {
  it("全フィールドをクリアする", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().addField(SAMPLE_RECT, "B");
    useReportStore.getState().clearTemplate();
    expect(useReportStore.getState().template.fields).toHaveLength(0);
  });

  it("clearTemplate 後に addField すると自動命名が「欄 1」に戻る", () => {
    useReportStore.getState().addField(SAMPLE_RECT, "A");
    useReportStore.getState().addField(SAMPLE_RECT);
    useReportStore.getState().clearTemplate();
    useReportStore.getState().addField(SAMPLE_RECT);
    const { fields } = useReportStore.getState().template;
    expect(fields[0].name).toBe("欄 1");
  });
});

describe("setMode / selectField", () => {
  it("モードを切り替えられる", () => {
    useReportStore.getState().setMode("defineField");
    expect(useReportStore.getState().mode).toBe("defineField");
    useReportStore.getState().setMode("idle");
    expect(useReportStore.getState().mode).toBe("idle");
  });

  it("selectedFieldId を設定・クリアできる", () => {
    useReportStore.getState().selectField("field-1");
    expect(useReportStore.getState().selectedFieldId).toBe("field-1");
    useReportStore.getState().selectField(null);
    expect(useReportStore.getState().selectedFieldId).toBeNull();
  });
});

describe("setCells", () => {
  it("CellMatrix をストアに設定できる", () => {
    const matrix: Map<number, Map<string, string>> = new Map([
      [1, new Map([["f1", "100"]])],
    ]);
    useReportStore.getState().setCells(matrix);
    const stored = useReportStore.getState().cells;
    expect(stored.get(1)?.get("f1")).toBe("100");
  });
});
