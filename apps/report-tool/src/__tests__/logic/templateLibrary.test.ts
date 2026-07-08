import { describe, it, expect } from "vitest";
import {
  TEMPLATE_SCHEMA_VERSION,
  newTemplateId,
  parseTemplateRecord,
  serializeTemplate,
  validateTemplateName,
} from "../../logic/templateLibrary";
import type { ReportField } from "../../types/report";

const SAMPLE_FIELDS: ReportField[] = [
  { id: "f1", name: "金額", color: "#7cb9e8", rect: { x: 0, y: 0, width: 100, height: 20 } },
  {
    id: "f2",
    name: "明細",
    color: "#90c8a0",
    rect: { x: 0, y: 30, width: 100, height: 20 },
    isLineItem: true,
  },
];

describe("newTemplateId", () => {
  it("呼び出すたびに一意な文字列 id を返す", () => {
    const a = newTemplateId();
    const b = newTemplateId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("validateTemplateName", () => {
  it("通常の名前は有効", () => {
    expect(validateTemplateName("請求書テンプレート")).toEqual({ ok: true });
  });

  it("空文字は無効", () => {
    const result = validateTemplateName("");
    expect(result.ok).toBe(false);
  });

  it("空白のみは無効", () => {
    const result = validateTemplateName("   ");
    expect(result.ok).toBe(false);
  });

  it("101文字は無効（上限100文字）", () => {
    const result = validateTemplateName("あ".repeat(101));
    expect(result.ok).toBe(false);
  });

  it("100文字ちょうどは有効", () => {
    const result = validateTemplateName("あ".repeat(100));
    expect(result.ok).toBe(true);
  });
});

describe("serializeTemplate", () => {
  it("schemaVersion=1・fields・name・savedAt を含む JSON を生成する", () => {
    const json = serializeTemplate(SAMPLE_FIELDS, "請求書A", "2026-07-08T00:00:00.000Z", {
      id: "tmpl-1",
    });
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(parsed.id).toBe("tmpl-1");
    expect(parsed.name).toBe("請求書A");
    expect(parsed.savedAt).toBe("2026-07-08T00:00:00.000Z");
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[1].isLineItem).toBe(true);
  });

  it("savedAt は引数の値をそのまま使う（Date.now を内部で呼ばない）", () => {
    const fixed = "2020-01-01T00:00:00.000Z";
    const json1 = serializeTemplate(SAMPLE_FIELDS, "A", fixed, { id: "x" });
    const json2 = serializeTemplate(SAMPLE_FIELDS, "A", fixed, { id: "x" });
    expect(JSON.parse(json1).savedAt).toBe(fixed);
    expect(json1).toBe(json2);
  });

  it("id 省略時は newTemplateId() で自動採番される", () => {
    const json = serializeTemplate(SAMPLE_FIELDS, "A", "2026-01-01T00:00:00.000Z");
    const parsed = JSON.parse(json);
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id.length).toBeGreaterThan(0);
  });

  it("sourcePageWidth/Height 省略時はキー自体を出力しない", () => {
    const json = serializeTemplate(SAMPLE_FIELDS, "A", "2026-01-01T00:00:00.000Z", { id: "x" });
    const parsed = JSON.parse(json);
    expect("sourcePageWidth" in parsed).toBe(false);
    expect("sourcePageHeight" in parsed).toBe(false);
  });

  it("sourcePageWidth/Height を指定すれば出力に含まれる", () => {
    const json = serializeTemplate(SAMPLE_FIELDS, "A", "2026-01-01T00:00:00.000Z", {
      id: "x",
      sourcePageWidth: 595,
      sourcePageHeight: 842,
    });
    const parsed = JSON.parse(json);
    expect(parsed.sourcePageWidth).toBe(595);
    expect(parsed.sourcePageHeight).toBe(842);
  });
});

describe("parseTemplateRecord", () => {
  it("serializeTemplate の出力を往復パースできる", () => {
    const json = serializeTemplate(SAMPLE_FIELDS, "請求書A", "2026-07-08T00:00:00.000Z", {
      id: "tmpl-1",
    });
    const result = parseTemplateRecord(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.id).toBe("tmpl-1");
      expect(result.record.name).toBe("請求書A");
      expect(result.record.fields).toHaveLength(2);
      expect(result.record.fields[0]).toEqual(SAMPLE_FIELDS[0]);
      expect(result.record.fields[1]).toEqual(SAMPLE_FIELDS[1]);
    }
  });

  it("JSON.parse 失敗を検出する", () => {
    const result = parseTemplateRecord("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/パース/);
    }
  });

  it("配列トップレベルなど object でない場合を検出する", () => {
    const result = parseTemplateRecord("[1,2,3]");
    expect(result.ok).toBe(false);
  });

  it("schemaVersion が 1 以外なら未対応として拒否する", () => {
    const record = { schemaVersion: 2, id: "x", name: "A", fields: [], savedAt: "2026-01-01" };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/schemaVersion/);
    }
  });

  it("id 欠落を検出する", () => {
    const record = { schemaVersion: 1, name: "A", fields: [], savedAt: "2026-01-01" };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("name 欠落を検出する", () => {
    const record = { schemaVersion: 1, id: "x", fields: [], savedAt: "2026-01-01" };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("savedAt 欠落を検出する", () => {
    const record = { schemaVersion: 1, id: "x", name: "A", fields: [] };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("fields が配列でない場合を検出する", () => {
    const record = { schemaVersion: 1, id: "x", name: "A", fields: "not-array", savedAt: "2026-01-01" };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("fields 内の要素に rect が欠落している場合を検出する", () => {
    const record = {
      schemaVersion: 1,
      id: "x",
      name: "A",
      fields: [{ id: "f1", name: "金額", color: "#000" }],
      savedAt: "2026-01-01",
    };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("fields 内の要素の rect が型不正な場合を検出する", () => {
    const record = {
      schemaVersion: 1,
      id: "x",
      name: "A",
      fields: [{ id: "f1", name: "金額", color: "#000", rect: { x: "0", y: 0, width: 1, height: 1 } }],
      savedAt: "2026-01-01",
    };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(false);
  });

  it("isLineItem が boolean でない場合はフィールドから除外される（無視される）", () => {
    const record = {
      schemaVersion: 1,
      id: "x",
      name: "A",
      fields: [
        {
          id: "f1",
          name: "金額",
          color: "#000",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          isLineItem: "true",
        },
      ],
      savedAt: "2026-01-01",
    };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.fields[0].isLineItem).toBeUndefined();
    }
  });

  it("fields 空配列は許容される", () => {
    const record = { schemaVersion: 1, id: "x", name: "A", fields: [], savedAt: "2026-01-01" };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.fields).toEqual([]);
    }
  });

  it("sourcePageWidth/Height が number なら record に含める", () => {
    const record = {
      schemaVersion: 1,
      id: "x",
      name: "A",
      fields: [],
      savedAt: "2026-01-01",
      sourcePageWidth: 595,
      sourcePageHeight: 842,
    };
    const result = parseTemplateRecord(JSON.stringify(record));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.sourcePageWidth).toBe(595);
      expect(result.record.sourcePageHeight).toBe(842);
    }
  });
});
