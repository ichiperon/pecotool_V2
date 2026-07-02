/**
 * sweepNonDirtyPage: 未編集ページの **非破壊修復** の検証。
 *
 * 仕様（変更後）:
 *   BT...ET（OCR/手補正テキストレイヤー）はバイト等価で温存し、
 *   - BT 外に漏れたテキスト演算子（Acrobat "text operator outside text object" エラーの主因）
 *   - 過去保存で累積した空 q-Q ラッパー
 *   のみを除去する（stripStrayTextOperatorsOutsideTextObjects 経由）。
 *
 *   旧実装は損傷ページで BT...ET ごと strip していたため、再描画材料 (メタ) を持たない
 *   ファイルでは原本テキストが消失していた。本テストはテキストが保持されること、
 *   かつエラー原因が除去されることを保証する（リグレッション固定）。
 *
 *   PCT-059: stream あたり decode は 1 回に保つ。
 *
 * モックなし (実 @cantoo/pdf-lib + 実 pdfContentStream)。
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';
import { inflate, deflate } from 'pako';
import {
  collectPageContentRefCounts,
  sweepNonDirtyPage,
  pageHasTextOperatorDamage,
} from '../../utils/pdfSaverCore';
import { hasTextOperatorsOutsideTextObjects } from '../../utils/pdfContentStream';

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
function runSweep(doc: PDFDocument): void {
  const counts = collectPageContentRefCounts(doc);
  sweepNonDirtyPage(getPage0Node(doc), doc.context, counts, '[sweep]');
}

interface StreamSnapshot {
  filter: string | null;
  raw: number[];
  decoded: string;
}

/** 処理後の doc を保存→再読込し、ページ0の全 content stream を列挙する。 */
async function snapshotPage0Streams(doc: PDFDocument): Promise<StreamSnapshot[]> {
  const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const reloaded = await loadDoc(saved);
  const page = reloaded.getPage(0);
  const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
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
      try { decoded = decodeLatin1(inflate(raw)); } catch { decoded = decodeLatin1(raw); }
    } else {
      decoded = decodeLatin1(raw);
    }
    snapshots.push({ filter: filterName, raw: Array.from(raw), decoded });
  }
  return snapshots;
}

// ── Content fixtures ──────────────────────────────────────────────────────────

// 空 q-Q ラッパー (cm のみ・描画なし → 除去対象) + 正常な BT...ET
const CONTENT_WITH_EMPTY_QQ =
  'q\n1 0 0 1 5 5 cm\nQ\nBT /F1 12 Tf (keep) Tj ET\n0 0 100 100 re f';

// 描画入り q-Q (保持) + 正常な BT...ET → 無変更で通過するはず
const CONTENT_NO_EMPTY_QQ = 'q\n0 0 100 100 re f\nQ\nBT /F1 12 Tf (keep) Tj ET';

// 損傷: 正常な BT...ET の外に Tj / TL が漏れている（mondai の損傷ページと同型）
const CONTENT_DAMAGED =
  'BT /F1 12 Tf (inside) Tj ET\n(orphan) Tj\n12 TL\n0 0 100 100 re f';

// ── 1. 非破壊修復の挙動 ────────────────────────────────────────────────────────

describe('sweepNonDirtyPage — 非破壊修復', () => {
  it('損傷ページ: BT...ET 内テキストは保持し、BT 外の漏れ演算子のみ除去する', async () => {
    const source = await buildPdf([{ content: CONTENT_DAMAGED, filter: 'flate' }]);
    const doc = await loadDoc(source);
    runSweep(doc);
    const snap = await snapshotPage0Streams(doc);
    expect(snap).toHaveLength(1);
    // BT...ET 内の手補正テキストは保持
    expect(snap[0].decoded).toContain('(inside) Tj');
    // BT 外に漏れていたテキスト演算子は除去
    expect(snap[0].decoded).not.toContain('(orphan)');
    expect(snap[0].decoded).not.toMatch(/\bTL\b/);
    // 非テキスト描画は保持
    expect(snap[0].decoded).toContain('re f');
    // Acrobat エラーの原因（BT 外テキスト演算子）が解消されている
    expect(hasTextOperatorsOutsideTextObjects(encodeLatin1(snap[0].decoded))).toBe(false);
  }, 30_000);

  it('空 q-Q ありの損傷なしページ: 空 q-Q のみ除去し BT...ET は保持', async () => {
    const source = await buildPdf([{ content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' }]);
    const doc = await loadDoc(source);
    runSweep(doc);
    const snap = await snapshotPage0Streams(doc);
    expect(snap).toHaveLength(1);
    expect(snap[0].decoded).not.toContain('cm'); // 空 q-Q 除去
    expect(snap[0].decoded).toContain('(keep) Tj'); // テキスト保持
    expect(snap[0].decoded).toContain('re f');
  }, 30_000);

  it('空 q-Q なしの損傷なしページ: 描画 q-Q も BT...ET も保持（実質無変更）', async () => {
    const source = await buildPdf([{ content: CONTENT_NO_EMPTY_QQ, filter: 'flate' }]);
    const doc = await loadDoc(source);
    runSweep(doc);
    const snap = await snapshotPage0Streams(doc);
    expect(snap).toHaveLength(1);
    expect(snap[0].decoded).toContain('re f');
    expect(snap[0].decoded).toContain('(keep) Tj');
  }, 30_000);

  it('multi-stream の 2 本目に損傷: 各 stream 独立に修復し、テキストは保持される', async () => {
    const source = await buildPdf([
      { content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' },
      { content: CONTENT_DAMAGED, filter: 'flate' },
    ]);
    const doc = await loadDoc(source);
    runSweep(doc);
    const snap = await snapshotPage0Streams(doc);
    // per-stream 修復なので merge されず 2 本のまま
    expect(snap).toHaveLength(2);
    const joined = snap.map((s) => s.decoded).join('\n');
    expect(joined).toContain('(keep) Tj');
    expect(joined).toContain('(inside) Tj'); // 損傷 stream のテキストも保持
    expect(joined).not.toContain('(orphan)');
    for (const s of snap) {
      expect(hasTextOperatorsOutsideTextObjects(encodeLatin1(s.decoded))).toBe(false);
    }
  }, 30_000);

  it('decode 不能 (LZW) stream: contents / dict とも無変更', async () => {
    const lzwContent = 'q\n1 0 0 1 5 5 cm\nQ\n(x) Tj';
    const source = await buildPdf([{ content: lzwContent, filter: 'lzw' }]);
    const doc = await loadDoc(source);
    const page = doc.getPage(0);
    const rawContents = page.node.get(PDFName.of('Contents'));
    const stream = doc.context.lookup(rawContents as PDFObject) as PDFRawStream;
    const beforeBytes = Array.from(stream.getContents());
    runSweep(doc);
    expect(Array.from(stream.getContents())).toEqual(beforeBytes);
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    expect(filter instanceof PDFName && filter.asString()).toBe('/LZWDecode');
  }, 30_000);

  it('損傷なしページ: Filter=FlateDecode / DecodeParms 削除で in-place 書き戻す', async () => {
    const source = await buildPdf([{ content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' }]);
    const doc = await loadDoc(source);
    const page = doc.getPage(0);
    const rawContents = page.node.get(PDFName.of('Contents'));
    const stream = doc.context.lookup(rawContents as PDFObject) as PDFRawStream;
    stream.dict.set(PDFName.of('DecodeParms'), doc.context.obj({ Predictor: 1 }));
    runSweep(doc);
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    expect(filter instanceof PDFName && filter.asString()).toBe('/FlateDecode');
    expect(stream.dict.lookup(PDFName.of('DecodeParms'))).toBeUndefined();
    const decoded = decodeLatin1(inflate(stream.getContents()));
    expect(decoded).not.toContain('cm');
    expect(decoded).toContain('(keep) Tj');
  }, 30_000);

  it('Contents なしページ: 例外なく no-op で完了する', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    const counts = collectPageContentRefCounts(pdf);
    expect(() =>
      sweepNonDirtyPage(getPage0Node(pdf), pdf.context, counts, '[sweep]'),
    ).not.toThrow();
  }, 30_000);
});

// ── 2. decode 回数（PCT-059 維持）────────────────────────────────────────────

describe('sweepNonDirtyPage — decode 回数 (PCT-059 維持)', () => {
  async function loadWithSpy(
    bytes: Uint8Array,
  ): Promise<{ doc: PDFDocument; spy: ReturnType<typeof vi.spyOn> }> {
    const doc = await loadDoc(bytes);
    const page = doc.getPage(0);
    const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
    const stream = doc.context.lookup(rawContents as PDFObject);
    expect(stream).toBeInstanceOf(PDFRawStream);
    const spy = vi.spyOn(stream as PDFRawStream, 'getContents');
    return { doc, spy };
  }

  it('損傷なし FlateDecode ページ: stream decode は 1 回', async () => {
    const source = await buildPdf([{ content: CONTENT_WITH_EMPTY_QQ, filter: 'flate' }]);
    const run = await loadWithSpy(source);
    runSweep(run.doc);
    expect(run.spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('空 q-Q なし (書き戻しなし) でも stream decode は 1 回', async () => {
    const source = await buildPdf([{ content: CONTENT_NO_EMPTY_QQ, filter: 'flate' }]);
    const run = await loadWithSpy(source);
    runSweep(run.doc);
    expect(run.spy).toHaveBeenCalledTimes(1);
  }, 30_000);
});

// ── 3. pageHasTextOperatorDamage — ストリーム跨ぎ BT...ET の連結判定 (PCT-177 / #408) ──

describe('pageHasTextOperatorDamage — ストリーム跨ぎ判定 (PCT-177)', () => {
  function damageOfPage0(doc: PDFDocument): boolean {
    return pageHasTextOperatorDamage(getPage0Node(doc), doc.context);
  }

  it('BT が stream A・ET が stream B に分かれる合法構成を損傷と誤判定しない', async () => {
    // PDF 32000-1 §7.8.2: トークン境界での content stream 分割は合法。
    // 連結すると BT (Hi) Tj ET は正常に閉じるため損傷なし。
    const source = await buildPdf([
      { content: 'q 1 0 0 1 0 0 cm\nBT\n/F1 12 Tf\n(Hi) Tj\n', filter: 'flate' },
      { content: 'ET\nQ\n', filter: 'flate' },
    ]);
    const doc = await loadDoc(source);
    expect(damageOfPage0(doc)).toBe(false);
  }, 30_000);

  it('真に BT 外へ表示演算子が漏れた構成は連結後も損傷と判定する', async () => {
    const source = await buildPdf([
      { content: 'BT (inside) Tj ET\n', filter: 'flate' },
      { content: '(orphan) Tj\n', filter: 'flate' },
    ]);
    const doc = await loadDoc(source);
    expect(damageOfPage0(doc)).toBe(true);
  }, 30_000);

  it('単一 stream 内で閉じた BT...ET は損傷なし（非退行）', async () => {
    const source = await buildPdf([
      { content: 'q\nBT /F1 12 Tf (keep) Tj ET\nQ\n0 0 100 100 re f', filter: 'flate' },
    ]);
    const doc = await loadDoc(source);
    expect(damageOfPage0(doc)).toBe(false);
  }, 30_000);
});
