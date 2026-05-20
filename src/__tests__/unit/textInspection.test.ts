import { describe, expect, it } from "vitest";
import type { PageData, TextBlock } from "../../types";
import {
  detectBboxAnomalies,
  detectCharacterFragmentation,
  detectDuplicateBlocks,
  detectIsolatedBlocks,
  detectReadingOrderAnomalies,
  detectSentenceFragmentation,
  detectSymbolStructure,
  runTextInspection,
} from "../../utils/textInspection";

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: "block-1",
    text: "テスト",
    originalText: "テスト",
    bbox: { x: 0, y: 0, width: 40, height: 20 },
    writingMode: "horizontal",
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 800,
    height: 1000,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    isTextExtracted: true,
    ...overrides,
  };
}

describe("detectCharacterFragmentation", () => {
  it("detects consecutive horizontal one-character blocks", () => {
    const blocks = [
      makeBlock({ id: "a", text: "あ", bbox: { x: 0, y: 0, width: 10, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "い", bbox: { x: 11, y: 1, width: 10, height: 20 }, order: 1 }),
      makeBlock({ id: "c", text: "う", bbox: { x: 22, y: 0, width: 10, height: 20 }, order: 2 }),
    ];

    const issues = detectCharacterFragmentation(blocks, { pageIndex: 0 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "character_fragmentation",
      severity: "warning",
      blockIds: ["a", "b", "c"],
      text: "あいう",
      bbox: { x: 0, y: 0, width: 32, height: 21 },
    });
  });

  it("ignores distant one-character blocks", () => {
    const blocks = [
      makeBlock({ id: "a", text: "あ", bbox: { x: 0, y: 0, width: 10, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "い", bbox: { x: 100, y: 0, width: 10, height: 20 }, order: 1 }),
    ];

    expect(detectCharacterFragmentation(blocks, { pageIndex: 0 })).toEqual([]);
  });

  it("ignores only two consecutive one-character blocks", () => {
    const blocks = [
      makeBlock({ id: "a", text: "あ", bbox: { x: 0, y: 0, width: 10, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "い", bbox: { x: 11, y: 0, width: 10, height: 20 }, order: 1 }),
    ];

    expect(detectCharacterFragmentation(blocks, { pageIndex: 0 })).toEqual([]);
  });
});

describe("detectSentenceFragmentation", () => {
  it("detects adjacent blocks after a particle ending", () => {
    const blocks = [
      makeBlock({ id: "a", text: "これは", bbox: { x: 0, y: 0, width: 50, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "テストです", bbox: { x: 56, y: 0, width: 80, height: 20 }, order: 1 }),
    ];

    const issues = detectSentenceFragmentation(blocks, { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "sentence_fragmentation",
      severity: "info",
      blockIds: ["a", "b"],
      text: "これはテストです",
    });
  });

  it("ignores blocks after sentence-ending punctuation", () => {
    const blocks = [
      makeBlock({ id: "a", text: "完了しました。", bbox: { x: 0, y: 0, width: 100, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "次の文", bbox: { x: 110, y: 0, width: 60, height: 20 }, order: 1 }),
    ];

    expect(detectSentenceFragmentation(blocks, { pageIndex: 0, pageWidth: 800, pageHeight: 1000 })).toEqual([]);
  });
});

describe("detectSymbolStructure", () => {
  it("detects unclosed opening symbols with the symbol_structure category", () => {
    const issues = detectSymbolStructure([
      makeBlock({ id: "a", text: "「テスト", order: 0 }),
    ], { pageIndex: 0 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "symbol_structure",
      severity: "warning",
      blockIds: ["a"],
      text: "「",
    });
  });

  it("detects suspicious line-start and line-end symbols while keeping bracket stack matching", () => {
    const issues = detectSymbolStructure([
      makeBlock({ id: "a", text: "これは「", bbox: { x: 0, y: 0, width: 70, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "テスト」", bbox: { x: 0, y: 24, width: 70, height: 20 }, order: 1 }),
      makeBlock({ id: "c", text: "、補足", bbox: { x: 0, y: 48, width: 70, height: 20 }, order: 2 }),
    ], { pageIndex: 0 });

    expect(issues.map((issue) => issue.title)).toEqual([
      "行末の記号構造が不自然です",
      "行頭の記号構造が不自然です",
    ]);
    expect(issues.every((issue) => issue.category === "symbol_structure")).toBe(true);
  });

  it("accepts correctly nested symbols", () => {
    const issues = detectSymbolStructure([
      makeBlock({ id: "a", text: "「（テスト）」", order: 0 }),
    ], { pageIndex: 0 });

    expect(issues).toEqual([]);
  });
});

describe("detectReadingOrderAnomalies", () => {
  it("detects reversed reading order on the same horizontal line", () => {
    const issues = detectReadingOrderAnomalies([
      makeBlock({ id: "right", text: "後", bbox: { x: 80, y: 0, width: 30, height: 20 }, order: 0 }),
      makeBlock({ id: "left", text: "先", bbox: { x: 0, y: 0, width: 30, height: 20 }, order: 1 }),
    ], { pageIndex: 0 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "reading_order_anomaly",
      severity: "warning",
      blockIds: ["right", "left"],
    });
  });

  it("ignores normal horizontal reading order", () => {
    const issues = detectReadingOrderAnomalies([
      makeBlock({ id: "left", text: "先", bbox: { x: 0, y: 0, width: 30, height: 20 }, order: 0 }),
      makeBlock({ id: "right", text: "後", bbox: { x: 40, y: 0, width: 30, height: 20 }, order: 1 }),
    ], { pageIndex: 0 });

    expect(issues).toEqual([]);
  });

  it("detects adjacent order blocks that are too far apart", () => {
    const issues = detectReadingOrderAnomalies([
      makeBlock({ id: "near-start", text: "先", bbox: { x: 0, y: 0, width: 30, height: 20 }, order: 0 }),
      makeBlock({ id: "far-next", text: "後", bbox: { x: 650, y: 800, width: 30, height: 20 }, order: 1 }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "reading_order_anomaly",
      severity: "warning",
      blockIds: ["near-start", "far-next"],
      title: "読み順で隣接する BB が離れています",
    });
  });

  it("detects nearby blocks whose orders are separated", () => {
    const issues = detectReadingOrderAnomalies([
      makeBlock({ id: "a", text: "A", bbox: { x: 0, y: 0, width: 20, height: 20 }, order: 0 }),
      makeBlock({ id: "middle", text: "別", bbox: { x: 0, y: 80, width: 40, height: 20 }, order: 1 }),
      makeBlock({ id: "other", text: "別2", bbox: { x: 0, y: 120, width: 40, height: 20 }, order: 2 }),
      makeBlock({ id: "b", text: "B", bbox: { x: 22, y: 0, width: 20, height: 20 }, order: 3 }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues.some((issue) => (
      issue.title === "近接する BB の読み順が離れています" &&
      issue.blockIds.join(",") === "a,b"
    ))).toBe(true);
  });
});

describe("detectIsolatedBlocks", () => {
  it("detects a small isolated OCR block", () => {
    const issues = detectIsolatedBlocks([
      makeBlock({ id: "a", text: "本文です", bbox: { x: 0, y: 0, width: 100, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "続きです", bbox: { x: 0, y: 30, width: 100, height: 20 }, order: 1 }),
      makeBlock({ id: "dust", text: "・", bbox: { x: 600, y: 800, width: 5, height: 5 }, order: 2 }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "isolated_block",
      severity: "warning",
      blockIds: ["dust"],
      text: "・",
    });
  });

  it("ignores a small block near surrounding text", () => {
    const issues = detectIsolatedBlocks([
      makeBlock({ id: "a", text: "本文です", bbox: { x: 0, y: 0, width: 100, height: 20 }, order: 0 }),
      makeBlock({ id: "mark", text: "※", bbox: { x: 108, y: 4, width: 8, height: 8 }, order: 1 }),
      makeBlock({ id: "b", text: "続きです", bbox: { x: 0, y: 30, width: 100, height: 20 }, order: 2 }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toEqual([]);
  });
});

describe("detectDuplicateBlocks", () => {
  it("detects duplicated text blocks at nearly the same bbox", () => {
    const issues = detectDuplicateBlocks([
      makeBlock({ id: "a", text: "重複", bbox: { x: 10, y: 20, width: 40, height: 16 }, order: 0 }),
      makeBlock({ id: "b", text: "重複", bbox: { x: 11, y: 21, width: 40, height: 16 }, order: 1 }),
    ], { pageIndex: 0 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "duplicate_block",
      severity: "error",
      blockIds: ["a", "b"],
      text: "重複",
    });
  });

  it("ignores same text in distant bboxes", () => {
    const issues = detectDuplicateBlocks([
      makeBlock({ id: "a", text: "見出し", bbox: { x: 0, y: 0, width: 60, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "見出し", bbox: { x: 0, y: 200, width: 60, height: 20 }, order: 1 }),
    ], { pageIndex: 0 });

    expect(issues).toEqual([]);
  });
});

describe("detectBboxAnomalies", () => {
  it("detects empty-text blocks", () => {
    const issues = detectBboxAnomalies([
      makeBlock({ id: "empty", text: "   ", bbox: { x: 0, y: 0, width: 40, height: 20 } }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "bbox_anomaly",
      severity: "error",
      blockIds: ["empty"],
      title: "空テキストの BB",
    });
  });

  it("detects invalid bbox sizes", () => {
    const issues = detectBboxAnomalies([
      makeBlock({ id: "bad", bbox: { x: 0, y: 0, width: 0, height: 20 } }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "bbox_anomaly",
      severity: "error",
      blockIds: ["bad"],
    });
  });

  it("ignores valid bboxes inside the page", () => {
    const issues = detectBboxAnomalies([
      makeBlock({ id: "ok", bbox: { x: 10, y: 20, width: 100, height: 20 } }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toEqual([]);
  });

  it("detects bbox sizes that are extreme for the text length", () => {
    const issues = detectBboxAnomalies([
      makeBlock({ id: "wide", text: "短", bbox: { x: 10, y: 20, width: 300, height: 20 } }),
    ], { pageIndex: 0, pageWidth: 800, pageHeight: 1000 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      category: "bbox_anomaly",
      severity: "warning",
      blockIds: ["wide"],
      title: "文字数に対して BB が大きすぎます",
    });
  });
});

describe("runTextInspection", () => {
  it("runs enabled BB/OCR checks without mutating PageData", async () => {
    const blocks = [
      makeBlock({ id: "a", text: "あ", bbox: { x: 0, y: 0, width: 10, height: 20 }, order: 0 }),
      makeBlock({ id: "b", text: "い", bbox: { x: 11, y: 0, width: 10, height: 20 }, order: 1 }),
      makeBlock({ id: "c", text: "う", bbox: { x: 22, y: 0, width: 10, height: 20 }, order: 2 }),
    ];
    const page = makePage({ textBlocks: blocks });

    const result = await runTextInspection(page);

    expect(result.issues.map((issue) => issue.category)).toEqual(["character_fragmentation"]);
    expect(page.textBlocks).toBe(blocks);
    expect(page.isDirty).toBe(false);
  });

  it("honors disabled checks", async () => {
    const page = makePage({
      textBlocks: [
        makeBlock({ id: "a", text: "あ", bbox: { x: 0, y: 0, width: 10, height: 20 }, order: 0 }),
        makeBlock({ id: "b", text: "い", bbox: { x: 11, y: 0, width: 10, height: 20 }, order: 1 }),
        makeBlock({ id: "c", text: "う", bbox: { x: 22, y: 0, width: 10, height: 20 }, order: 2 }),
      ],
    });

    const result = await runTextInspection(page, { checks: { character_fragmentation: false } });

    expect(result.issues).toEqual([]);
  });

  it("reports unextracted and empty-page states without mutating PageData", async () => {
    const unextracted = await runTextInspection(makePage({ isTextExtracted: false }));
    const empty = await runTextInspection(makePage({ isTextExtracted: true }));

    expect(unextracted).toMatchObject({ issues: [], skippedReason: "text_not_extracted" });
    expect(empty).toMatchObject({ issues: [], skippedReason: "no_text" });
  });
});
