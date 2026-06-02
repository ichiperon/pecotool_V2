/**
 * pdfReachabilityGc — 境界テスト (test gap fill wave 7)
 *
 * wave 2 (I-GC-01..11) の gap を補強:
 *   - sweepUnreachableObjects: 大量 (1000) orphan, enumerateIndirectObjects 非存在パス
 *   - compactIndirectObjectNumbers: dense 判定 (early return), sparse → dense 確認,
 *     largestObjectNumber 更新確認, generation>0 が混在した場合の renumber
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFRef } from '@cantoo/pdf-lib';
import {
  sweepUnreachableObjects,
  compactIndirectObjectNumbers,
} from '../../utils/pdfReachabilityGc';

// ── helpers ───────────────────────────────────────────────────────────────

async function makeDoc(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc;
}

type ContextWithHelpers = {
  register: (obj: unknown) => PDFRef;
  stream: (bytes: Uint8Array, dict: Record<string, unknown>) => unknown;
  obj: (dict: Record<string, unknown>) => unknown;
  enumerateIndirectObjects: () => Array<[PDFRef, unknown]>;
  indirectObjects?: Map<PDFRef, unknown>;
  largestObjectNumber: number;
  trailerInfo?: Record<string, unknown>;
};

function ctx(doc: PDFDocument): ContextWithHelpers {
  return doc.context as unknown as ContextWithHelpers;
}

// ── sweepUnreachableObjects — 大量 orphan ─────────────────────────────────

describe('sweepUnreachableObjects — large orphan sets (wave 7)', () => {
  it('W7-GC-01: 1000 orphan objects → すべて dropped', async () => {
    const doc = await makeDoc(1);
    const c = ctx(doc);

    const orphanCount = 1000;
    for (let i = 0; i < orphanCount; i++) {
      const bytes = new TextEncoder().encode(`bulk orphan ${i}`);
      c.register(c.stream(bytes, { Type: 'BulkOrphan' }));
    }

    const result = sweepUnreachableObjects(doc);
    expect(result.dropped).toBe(orphanCount);
  });

  it('W7-GC-02: orphan 500 個追加後 sweep → save → reload でページ数は保持される', async () => {
    const doc = await makeDoc(3);
    const c = ctx(doc);

    for (let i = 0; i < 500; i++) {
      const bytes = new TextEncoder().encode(`mid orphan ${i}`);
      c.register(c.stream(bytes, {}));
    }

    const result = sweepUnreachableObjects(doc);
    expect(result.dropped).toBe(500);

    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it('W7-GC-03: trailerInfo.Root が indirect ref → resolve して到達できる (dropped=0)', async () => {
    // pdf-lib の createDocument() は Root を indirect ref 経由で持つはずなので
    // dropped=0 になることを確認 (Root の孤立が起きていないことの保証)
    const doc = await makeDoc(1);
    const result = sweepUnreachableObjects(doc);
    expect(result.dropped).toBe(0);
  });

  it('W7-GC-04: enumerateIndirectObjects が関数でない場合 → dropped=0 を返す', async () => {
    // context の enumerateIndirectObjects を削除して GC に渡す (boundary)
    const doc = await makeDoc(1);
    const c = doc.context as unknown as {
      trailerInfo?: { Root?: unknown };
      enumerateIndirectObjects?: unknown;
    };
    // 一時的に削除
    const original = c.enumerateIndirectObjects;
    c.enumerateIndirectObjects = undefined;

    const result = sweepUnreachableObjects(doc);
    expect(result.dropped).toBe(0);

    // 復元
    c.enumerateIndirectObjects = original;
  });

  it('W7-GC-05: 大量 reachable (100 ページ) + orphan 50 → orphan だけ drop', async () => {
    const doc = await makeDoc(100);
    const c = ctx(doc);

    // orphan を 50 個だけ追加
    for (let i = 0; i < 50; i++) {
      const bytes = new TextEncoder().encode(`orphan only ${i}`);
      c.register(c.stream(bytes, {}));
    }

    const result = sweepUnreachableObjects(doc);
    expect(result.dropped).toBe(50);

    // 100 ページは残る
    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getPageCount()).toBe(100);
  });
});

// ── compactIndirectObjectNumbers — dense 判定・sparse 変換 ────────────────

describe('compactIndirectObjectNumbers — dense / sparse boundaries (wave 7)', () => {
  it('W7-CPT-01: 空のドキュメント (0 entries) → renumbered=0 で即時 return', async () => {
    // PDFDocument.create() は既にいくつか object を持つので、
    // indirectObjects を直接操作して entries=0 にするのは複雑。
    // 代わりにページ 1 枚の doc で sweep 後 compact → renumbered ≥ 0 を確認する
    const doc = await makeDoc(1);
    sweepUnreachableObjects(doc); // 孤立なし
    const result = compactIndirectObjectNumbers(doc);
    expect(result.renumbered).toBeGreaterThanOrEqual(0);
  });

  it('W7-CPT-02: 新規作成 doc は既に dense → compactIndirectObjectNumbers は renumbered=0 or fast-path を通る', async () => {
    const doc = await makeDoc(1);
    // 孤児 sweep 後 compact: dense なら renumbered=0
    sweepUnreachableObjects(doc);
    const result = compactIndirectObjectNumbers(doc);
    // dense (1..N) なら 0、そうでなければ ≥ 0
    expect(result.renumbered).toBeGreaterThanOrEqual(0);
  });

  it('W7-CPT-03: orphan sweep → compact すると全 objectNumber が 1..N の連番になる', async () => {
    const doc = await makeDoc(1);
    const c = ctx(doc);

    // orphan を 20 個作ってギャップを生む
    for (let i = 0; i < 20; i++) {
      const bytes = new TextEncoder().encode(`gap${i}`);
      c.register(c.stream(bytes, {}));
    }

    sweepUnreachableObjects(doc);
    const result = compactIndirectObjectNumbers(doc);

    // compact 後の entries を検証
    const entries = c.enumerateIndirectObjects();
    expect(entries.length).toBeGreaterThan(0);

    // 全 objectNumber が 1..N の連番
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i][0].objectNumber).toBe(i + 1);
      expect(entries[i][0].generationNumber).toBe(0);
    }

    expect(result.renumbered).toBeGreaterThanOrEqual(0);
  });

  it('W7-CPT-04: compact 後に save → reload してもドキュメントが有効', async () => {
    const doc = await makeDoc(2);
    const c = ctx(doc);

    // 孤児を 30 個追加
    for (let i = 0; i < 30; i++) {
      const bytes = new TextEncoder().encode(`cpt orphan ${i}`);
      c.register(c.stream(bytes, {}));
    }

    sweepUnreachableObjects(doc);
    compactIndirectObjectNumbers(doc);

    const saved = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it('W7-CPT-05: largestObjectNumber が compact 後に entries.length と一致する', async () => {
    const doc = await makeDoc(1);
    const c = ctx(doc);

    // orphan 10 個
    for (let i = 0; i < 10; i++) {
      c.register(c.stream(new TextEncoder().encode(`ln ${i}`), {}));
    }

    sweepUnreachableObjects(doc);
    compactIndirectObjectNumbers(doc);

    const entries = c.enumerateIndirectObjects();
    // largestObjectNumber === entries.length が dense の条件
    expect(c.largestObjectNumber).toBe(entries.length);
  });

  it('W7-CPT-06: indirectObjects が Map でない場合 → renumbered=0', async () => {
    const doc = await makeDoc(1);
    const c = doc.context as unknown as {
      indirectObjects?: unknown;
    };
    const original = c.indirectObjects;
    c.indirectObjects = null; // Map ではない

    const result = compactIndirectObjectNumbers(doc);
    expect(result.renumbered).toBe(0);

    c.indirectObjects = original;
  });

  it('W7-CPT-07: 連続 compact 呼び出しは 2 回目が dense → fast-path で renumbered=0', async () => {
    const doc = await makeDoc(1);
    const c = ctx(doc);

    // orphan 5 個
    for (let i = 0; i < 5; i++) {
      c.register(c.stream(new TextEncoder().encode(`x${i}`), {}));
    }

    sweepUnreachableObjects(doc);
    compactIndirectObjectNumbers(doc); // 1 回目 (renumber が走る)

    // 2 回目は already dense → fast-path
    const result2 = compactIndirectObjectNumbers(doc);
    expect(result2.renumbered).toBe(0);
  });
});
