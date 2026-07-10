import { describe, it, expect } from "vitest";
import {
  serializeSession,
  deserializeSession,
  SESSION_SCHEMA_VERSION,
} from "../../logic/sessionCodec";
import type { SessionInput } from "../../logic/sessionCodec";

function sampleInput(): SessionInput {
  return {
    pdfPath: "C:\docs\請求書.pdf",
    pdfFingerprint: "abc123def456",
    savedAt: "2026-07-08T05:00:00.000Z",
    rotation: 90,
    fields: [
      { id: "f1", name: "金額", color: "#7cb9e8", rect: { x: 1, y: 2, width: 3, height: 4 } },
      { id: "f2", name: "明細", color: "#90c8a0", rect: { x: 5, y: 6, width: 7, height: 8 }, isLineItem: true },
    ],
    cells: new Map([
      [1, [new Map([["f1", "1000"], ["f2", "りんご"]]), new Map([["f2", "みかん"]])]],
      [3, [new Map([["f1", ""]])]],
    ]),
    confidences: new Map([[1, [new Map([["f1", 0.9]]), new Map([["f2", 0.4]])]]]),
    edited: new Map([[1, [new Set(["f1"]), new Set<string>()]]]),
    pageOffsets: new Map([[3, { dx: 2, dy: -1 }]]),
    excludedPages: new Set([2]),
    diagnostics: {
      failedPages: [4, 7],
      layoutMismatchPages: [5],
      layoutBasePage: 1,
    },
  };
}

describe("sessionCodec: 往復", () => {
  it("serialize → deserialize で全スライスが等価に復元される", () => {
    const input = sampleInput();
    const result = deserializeSession(serializeSession(input));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.session;
    expect(s.pdfPath).toBe(input.pdfPath);
    expect(s.pdfFingerprint).toBe(input.pdfFingerprint);
    expect(s.savedAt).toBe(input.savedAt);
    expect(s.rotation).toBe(90);
    expect(s.fields).toEqual(input.fields);
    expect(s.cells.get(1)?.[0]?.get("f1")).toBe("1000");
    expect(s.cells.get(1)?.[1]?.get("f2")).toBe("みかん");
    expect(s.cells.get(3)?.[0]?.get("f1")).toBe("");
    expect(s.confidences.get(1)?.[1]?.get("f2")).toBe(0.4);
    expect(s.edited.get(1)?.[0]?.has("f1")).toBe(true);
    expect(s.edited.get(1)?.[1]?.size).toBe(0);
    expect(s.pageOffsets.get(3)).toEqual({ dx: 2, dy: -1 });
    expect(s.excludedPages.has(2)).toBe(true);
    expect(s.diagnostics).toEqual(input.diagnostics);
  });

  it("空の作業状態も往復できる", () => {
    const input: SessionInput = {
      ...sampleInput(),
      cells: new Map(),
      confidences: new Map(),
      edited: new Map(),
      pageOffsets: new Map(),
      excludedPages: new Set(),
      fields: [],
      rotation: 0,
      diagnostics: { failedPages: [], layoutMismatchPages: [], layoutBasePage: null },
    };
    const r = deserializeSession(serializeSession(input));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.cells.size).toBe(0);
    expect(r.session.excludedPages.size).toBe(0);
    expect(r.session.diagnostics).toEqual({
      failedPages: [],
      layoutMismatchPages: [],
      layoutBasePage: null,
    });
  });
});

describe("sessionCodec: v2 スキーマ（#446 fingerprint / #447 diagnostics）", () => {
  it("v1（SESSION_SCHEMA_VERSION より前）は ok:false で拒否する（誤復元よりデータ保護を優先）", () => {
    const json = serializeSession(sampleInput()).replace(
      `"version":${SESSION_SCHEMA_VERSION}`,
      '"version":1'
    );
    const r = deserializeSession(json);
    expect(r.ok).toBe(false);
  });

  it("pdfFingerprint 欠落は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    delete obj.pdfFingerprint;
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("pdfFingerprint が空文字は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.pdfFingerprint = "";
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("diagnostics 欠落は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    delete obj.diagnostics;
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("diagnostics.failedPages が number[] でない場合は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.diagnostics.failedPages = ["2", "3"];
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("diagnostics.layoutBasePage が number でも null でもない場合は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.diagnostics.layoutBasePage = "1";
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("diagnostics.layoutBasePage=null は許容される", () => {
    const input: SessionInput = {
      ...sampleInput(),
      diagnostics: { failedPages: [], layoutMismatchPages: [], layoutBasePage: null },
    };
    const r = deserializeSession(serializeSession(input));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.diagnostics.layoutBasePage).toBeNull();
  });
});

describe("sessionCodec: 不正入力の拒否", () => {
  it("壊れた JSON は ok:false", () => {
    expect(deserializeSession("{oops").ok).toBe(false);
  });

  it("未知バージョンは ok:false（黙って半端に復元しない）", () => {
    const json = serializeSession(sampleInput()).replace(
      `"version":${SESSION_SCHEMA_VERSION}`,
      '"version":999'
    );
    const r = deserializeSession(json);
    expect(r.ok).toBe(false);
  });

  it("pdfPath 欠落は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    delete obj.pdfPath;
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("データ部が配列でない場合も例外にせず ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.cells = "broken";
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });
});

describe("sessionCodec: 値レベル検証（レビューMEDIUM回帰）", () => {
  it("rotation が 90 刻みでない（45等）は ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.rotation = 45;
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("セル値に非 string（数値）が混入していたら ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.cells = [[1, [[["f1", 123]]]]];
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });

  it("fields に null 要素・rect 欠落があれば ok:false", () => {
    const obj = JSON.parse(serializeSession(sampleInput()));
    obj.fields = [null];
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
    obj.fields = [{ id: "f1", name: "金額" }]; // rect なし
    expect(deserializeSession(JSON.stringify(obj)).ok).toBe(false);
  });
});
