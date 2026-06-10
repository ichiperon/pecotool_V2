/**
 * PCT-059: sweepNonDirtyPage の等価性 + decode 回数削減テスト。
 *
 * sweepNonDirtyPage は、未編集ページに対する従来経路:
 *   pageHasTextOperatorDamage → (損傷時) replacePageTextContentStreams
 *   → stripEmptyQBlocksOnPage
 * を 1 関数に統合し、損傷なしページで decode (pako.inflate) を
 * stream あたり 2 回 → 1 回に削減する。
 *
 * 検証内容:
 *   1. differential 等価性: 同一 PDF を旧経路と新経路で処理し、
 *      最終 content stream のバイト列が完全一致すること
 *      (空 q-Q あり/なし、issue #1 損傷あり、multi-stream、decode 不能 LZW 混在)
 *   2. decode 回数: getContents 呼び出し回数 spy で
 *      損傷なし FlateDecode ページにつき 新経路=1回 / 旧経路=2回 を機械的に証明
 *   3. 単体: 損傷ページの BT...ET strip / 空 q-Q 除去 / decode 不能 stream 無変更
 *
 * モックなし (実 @cantoo/pdf-lib + 実 pdfContentStream) で検証する。
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';
import { deflate, inflate } from 'pako';
import {
  collectPageContentRefCounts,
  pageHasTextOperatorDamage,
  replacePageTextContentStreams,
  stripEmptyQBlocksOnPage,
  sweepNonDirtyPage,
} from '../../utils/pdfSaverCore';

// ── Helpers ───────────────────────────────────────────────────────────────────

type PageNodeLike = {
  get?: (key: PDFName) => PDFObject | undefined;
  Contents?: () => PDFObject | undefined;
  set: (key: PDFName, value: PDFObject) => void;
};

function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

interface StreamSpec {
  content: string;
  filter: 'flate' | 'lzw' | 'none';
}

/**
 * 指定の content stream 構成を持つ 1 ページ PDF を構築して保存バイト列を返す。
 * 複数 spec なら Contents は PDFArray、単一なら直接参照。
 */
async function buildPdf(specs: StreamSpec[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);

  const refs = specs.map((spec) => {
    const raw = encodeLatin1(spec.content);
    if (spec.filter === 'flate') {
      return pdf.context.register(
        pdf.context.stream(deflate(raw), { Filter: PDFName.of('FlateDecode') }),
      );
    }
    if (spec.filter === 'lzw') {
      // 実 LZW 圧縮は不要 (saver は filter 名だけ見て decode を諦める)
      return pdf.context.register(
        pdf.context.stream(raw, { Filter: PDFName.of('LZWDecode') }),
      );
    }
    return pdf.context.register(pdf.context.stream(raw));
  });

  if (refs.length === 1) {
    page.node.set(PDFName.of('Contents'), refs[0]);
  } else {
    page.node.set(PDFName.of('Contents'), pdf.context.obj(refs));
  }

  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
}

function getPage0Node(doc: PDFDocument): PageNodeLike {
  return doc.getPage(0).node as unknown as PageNodeLike;
}

/** 従来経路 (置換前の pdfSaver.ts / pdf.worker.ts の未編集ページループ本体と同一)。 */
function runOldPath(doc: PDFDocument): void {
  const counts = collectPageContentRefCounts(doc);
  const node = getPage0Node(doc);
  if (pageHasTextOperatorDamage(node, doc.context)) {
    replacePageTextContentStreams(node, doc.context, counts, '[old#1]');
  }
  stripEmptyQBlocksOnPage(node, doc.context);
}

/** 新経路 (PCT-059)。 */
function runNewPath(doc: PDFDocument): void {
  const counts = collectPageContentRefCounts(doc);
  sweepNonDirtyPage(getPage0Node(doc), doc.context, counts, '[new#1]');
}

interface StreamSnapshot {
  filter: string | null;
  raw: number[];
  decoded: string;
}

/**
 * 処理後の doc を保存→再読込し、ページ 0 の全 content stream について
 * { Filter 名, 圧縮後 raw バイト列, decode 済み latin1 文字列 } を列挙する。
 * raw バイト列まで比較することで「最終バイト列の完全一致」を保証する。
 */
async function snapshotPage0Streams(doc: PDFDocument): Promise<StreamSnapshot[]> {
  const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const reloaded = await loadDoc(saved);
  const page = reloaded.getPage(0);
  const rawContents =
    page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
  if (!rawContents) return [];
  const resolved = reloaded.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];

  const snapshots: StreamSnapshot[] = [];
  for (const streamRef of streams) {
    const stream = reloaded.context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    const filterName = filter instanceof PDFName ? filter.asString() : null;
    const raw = stream.getContents();
    let decoded: string;
    if (filterName === '/FlateDecode') {
      try {
        decoded = decodeLatin1(inflate(raw));
      } catch {
        decoded = decodeLatin1(raw);
      }
    } else {
      decoded = decodeLatin1(raw);
    }
    snapshots.push({ filter: filterName, raw: Array.from(raw), decoded });
  }
  return snapshots;
}

/** 同一構成の PDF を旧経路/新経路で処理し、最終 stream snapshot の一致を検証する。 */
async function assertDifferentialEquivalence(
  specs: StreamSpec[],
): Promise<{ oldSnap: StreamSnapshot[]; newSnap: StreamSnapshot[] }> {
  const source = await buildPdf(specs);

  const oldDoc = await loadDoc(source);
  runOldPath(oldDoc);
  const oldSnap = await snapshotPage0Streams(oldDoc);

  const newDoc = await loadDoc(source);
  runNewPath(newDoc);
  const newSnap = await snapshotPage0Streams(newDoc);

  expect(newSnap).toEqual(oldSnap);
  return { oldSnap, newSnap };
}

// ── Content fixtures ──────────────────────────────────────────────────────────

// 空 q-Q ラッパー (cm のみで描画オペレータなし → strip 対象) + 正常な BT...ET
const CONTENT_WITH_EMPTY_QQ =
  'q\n1 0 0 1 5 5 cm\nQ\nBT /F1 12 Tf (keep) Tj ET\n0 0 100 100 re f';

// 描画オペレータ入り q-Q (保持される) + 正常な BT...ET → 変更なしで通過するはず
const CONTENT_NO_EMPTY_QQ = 'q\n0 0 100 100 re f\nQ\nBT /F1 12 Tf (keep) Tj ET';

// issue #1 損傷: BT...ET の外に Tj / TL が漏れている
const CONTENT_DAMAGED =
  'BT /F1 12 Tf (inside) Tj ET\n(orphan) Tj\n12 TL\n0 0 100 100 re f';

// ── 1. differential 等価性 ────────────────────────────────────────────────────

describe('sweepNonDirtyPage — differential equivalence vs legacy path (PCT-059)', () => {
  it('空 q-Q ありの損傷なしページ: 旧経路と最終バイト列が一致する', async () => {
    const { newSnap } = await assertDifferentialEquivalence([
      { content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' },
    ]);
    // 空 q-Q は実際に除去され、BT...ET は保持されている (no-op で偶然一致ではない)
    expect(newSnap).toHaveLength(1);
    expect(newSnap[0].decoded).not.toContain('cm');
    expect(newSnap[0].decoded).toContain('(keep) Tj');
  }, 30_000);

  it('空 q-Q なしの損傷なしページ: 両経路とも無変更で一致する', async () => {
    const { newSnap } = await assertDifferentialEquivalence([
      { content: CONTENT_NO_EMPTY_QQ, filter: 'flate' },
    ]);
    expect(newSnap).toHaveLength(1);
    // 描画入り q-Q と BT...ET はどちらも保持される
    expect(newSnap[0].decoded).toContain('re f');
    expect(newSnap[0].decoded).toContain('(keep) Tj');
  }, 30_000);

  it('issue #1 損傷あり (BT 外 Tj/TL): 旧経路と最終バイト列が一致する', async () => {
    const { newSnap } = await assertDifferentialEquivalence([
      { content: CONTENT_DAMAGED, filter: 'flate' },
    ]);
    // 損傷経路では BT...ET と orphan テキスト演算子が strip される
    expect(newSnap).toHaveLength(1);
    expect(newSnap[0].decoded).not.toContain('(inside)');
    expect(newSnap[0].decoded).not.toContain('(orphan)');
    expect(newSnap[0].decoded).toContain('re f');
  }, 30_000);

  it('multi-stream Contents (Flate×3, 空 q-Q あり): 旧経路と一致する', async () => {
    const { newSnap } = await assertDifferentialEquivalence([
      { content: 'q\n1 0 0 1 5 5 cm\nQ\n0 0 10 10 re f', filter: 'flate' },
      { content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' },
      { content: 'q\n2 0 0 2 0 0 cm\nQ', filter: 'flate' },
    ]);
    expect(newSnap).toHaveLength(3);
  }, 30_000);

  it('decode 不能 (LZW) 混在 multi-stream: 旧経路と一致し LZW は無変更', async () => {
    const lzwContent = 'q\n1 0 0 1 5 5 cm\nQ\n(lzw-bytes) Tj';
    const { newSnap } = await assertDifferentialEquivalence([
      { content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' },
      { content: lzwContent, filter: 'lzw' },
      { content: 'q\n1 0 0 1 9 9 cm\nQ\n0 0 20 20 re f', filter: 'none' },
    ]);
    expect(newSnap).toHaveLength(3);
    // LZW stream は decode 不能なので両経路とも完全に元のまま
    // (損傷判定からも q-Q strip からも skip される)
    const lzwSnap = newSnap.find((s) => s.filter === '/LZWDecode');
    expect(lzwSnap).toBeDefined();
    expect(lzwSnap!.raw).toEqual(Array.from(encodeLatin1(lzwContent)));
  }, 30_000);

  it('multi-stream の 2 本目に損傷: early-exit 順序込みで旧経路と一致する', async () => {
    // 1 本目 (損傷なし・空 q-Q あり) を decode した後に 2 本目で損傷検出 →
    // 1 本目へ書き込みを行わずに従来 2 関数へ委譲することの検証
    const { newSnap } = await assertDifferentialEquivalence([
      { content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' },
      { content: CONTENT_DAMAGED, filter: 'flate' },
    ]);
    // replacePageTextContentStreams は merge して単一 stream に置換する
    expect(newSnap).toHaveLength(1);
    expect(newSnap[0].decoded).not.toContain('(inside)');
    expect(newSnap[0].decoded).not.toContain('(orphan)');
  }, 30_000);
});

// ── 2. decode 回数削減の機械的検証 ────────────────────────────────────────────

describe('sweepNonDirtyPage — decode count reduction (PCT-059)', () => {
  /** ページ 0 の単一 content stream (PDFRawStream) を取得して getContents を spy する。 */
  async function loadWithSpy(
    bytes: Uint8Array,
  ): Promise<{ doc: PDFDocument; spy: ReturnType<typeof vi.spyOn> }> {
    const doc = await loadDoc(bytes);
    const page = doc.getPage(0);
    const rawContents =
      page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
    const stream = doc.context.lookup(rawContents as PDFObject);
    expect(stream).toBeInstanceOf(PDFRawStream);
    const spy = vi.spyOn(stream as PDFRawStream, 'getContents');
    return { doc, spy };
  }

  it('損傷なし FlateDecode ページ: 新経路は stream decode 1 回 (旧経路は 2 回)', async () => {
    const source = await buildPdf([{ content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' }]);

    // 旧経路: pageHasTextOperatorDamage と stripEmptyQBlocksOnPage が各 1 回 decode → 2 回
    const oldRun = await loadWithSpy(source);
    runOldPath(oldRun.doc);
    expect(oldRun.spy).toHaveBeenCalledTimes(2);

    // 新経路: 1パス目の decode を共有 → 1 回
    const newRun = await loadWithSpy(source);
    runNewPath(newRun.doc);
    expect(newRun.spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('空 q-Q なし (書き戻しなし) でも decode は 新経路 1 回 / 旧経路 2 回', async () => {
    const source = await buildPdf([{ content: CONTENT_NO_EMPTY_QQ, filter: 'flate' }]);

    const oldRun = await loadWithSpy(source);
    runOldPath(oldRun.doc);
    expect(oldRun.spy).toHaveBeenCalledTimes(2);

    const newRun = await loadWithSpy(source);
    runNewPath(newRun.doc);
    expect(newRun.spy).toHaveBeenCalledTimes(1);
  }, 30_000);
});

// ── 3. 単体挙動 ───────────────────────────────────────────────────────────────

describe('sweepNonDirtyPage — unit behavior', () => {
  it('損傷ありページ: BT...ET と orphan テキスト演算子が strip される', async () => {
    const source = await buildPdf([{ content: CONTENT_DAMAGED, filter: 'flate' }]);
    const doc = await loadDoc(source);
    runNewPath(doc);
    const snap = await snapshotPage0Streams(doc);
    expect(snap).toHaveLength(1);
    expect(snap[0].decoded).not.toContain('(inside)');
    expect(snap[0].decoded).not.toContain('(orphan)');
    expect(snap[0].decoded).not.toMatch(/\bTj\b/);
    // 非テキスト描画は保持される
    expect(snap[0].decoded).toContain('re f');
  }, 30_000);

  it('損傷なしページ: 空 q-Q のみ除去し Filter=FlateDecode / DecodeParms 削除で書き戻す', async () => {
    const source = await buildPdf([{ content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' }]);
    const doc = await loadDoc(source);

    // DecodeParms の削除を検証するため、書き戻し前に no-op の DecodeParms を仕込む
    const page = doc.getPage(0);
    const rawContents = page.node.get(PDFName.of('Contents'));
    const stream = doc.context.lookup(rawContents as PDFObject) as PDFRawStream;
    stream.dict.set(PDFName.of('DecodeParms'), doc.context.obj({ Predictor: 1 }));

    runNewPath(doc);

    // 書き戻しは in-place (PDFRawStream のまま) — 直接 dict / contents を検証
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    expect(filter instanceof PDFName && filter.asString()).toBe('/FlateDecode');
    expect(stream.dict.lookup(PDFName.of('DecodeParms'))).toBeUndefined();
    const decoded = decodeLatin1(inflate(stream.getContents()));
    expect(decoded).not.toContain('cm'); // 空 q-Q ラッパー除去済み
    expect(decoded).toContain('(keep) Tj'); // BT...ET は保持
  }, 30_000);

  it('decode 不能 (LZW) 単独 stream: contents / dict とも無変更', async () => {
    const lzwContent = 'q\n1 0 0 1 5 5 cm\nQ\n(x) Tj';
    const source = await buildPdf([{ content: lzwContent, filter: 'lzw' }]);
    const doc = await loadDoc(source);

    const page = doc.getPage(0);
    const rawContents = page.node.get(PDFName.of('Contents'));
    const stream = doc.context.lookup(rawContents as PDFObject) as PDFRawStream;
    const beforeBytes = Array.from(stream.getContents());

    runNewPath(doc);

    expect(Array.from(stream.getContents())).toEqual(beforeBytes);
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    expect(filter instanceof PDFName && filter.asString()).toBe('/LZWDecode');
  }, 30_000);

  it('Contents なしページ: 例外なく no-op で完了する', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    const counts = collectPageContentRefCounts(pdf);
    expect(() =>
      sweepNonDirtyPage(getPage0Node(pdf), pdf.context, counts, '[new#1]'),
    ).not.toThrow();
  }, 30_000);
});
