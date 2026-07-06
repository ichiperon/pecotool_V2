/**
 * issue #100: Acrobat の text extraction (Ctrl+A → コピペ) で隣接 BB が連結される問題への
 * 回帰テスト。
 *
 * 真因:
 *   - pdf-lib は各 BB に独立した BT...ET を発行している (OK)
 *   - しかし Acrobat の text extraction は座標とフォントサイズに基づく heuristic で
 *     BT...ET 境界を無視して隣接 BB を連結する
 *   - 明示的な word-break 文字 (U+0020 invisible スペース等) が無いため
 *
 * 修正:
 *   - 各 BB の最後の run の末尾に invisible スペース (U+0020) を 1 文字付与する
 *   - renderMode 3 (invisible) で描画するので画面表示や印刷は完全に同等
 *
 * 検証方針:
 *   - 横書き / 縦書きそれぞれ 2 つの隣接 BB を持つ PDF を保存する
 *   - 保存後 content stream をデコードし、各 BT...ET 内に末尾スペースを示す
 *     Tj 演算子の content (U+0020 を含む) が存在することを byte レベルで検証
 *   - また、BT...ET の数が BB 数 (×run 数) に対して期待値以上であることを確認
 *
 * 不変条件 (リグレッション防止):
 *   - sanitizeTextForPdfCopy は U+0020 を strip しない (UNSAFE_PDF_COPY_CHARS の範囲外)
 *   - renderMode 3 が維持され、視覚的変更がない
 *   - 既存 #23 / #28 / #75 / #99 等の cm / Tm 不変条件を破壊しない
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock, WritingMode } from '../../types';
// #357: renderMode 3 不可視性の厳密検証ヘルパー
import { assertAllTextSegmentsHaveRenderMode3 } from './helpers/renderModeHelpers';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeEmptyPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeAdjacentHorizontalBlocksDoc(): PecoDocument {
  // 2 つの隣接 BB: 「あいう」「えお」を横並びに配置 (Acrobat の word-break heuristic を
  // テストするために bbox を密接させる)
  const blockA: TextBlock = {
    id: 'a',
    text: 'あいう',
    originalText: 'あいう',
    bbox: { x: 100, y: 100, width: 60, height: 20 },
    writingMode: 'horizontal' as WritingMode,
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const blockB: TextBlock = {
    // 隣接: blockA の右端 (160) のすぐ右に配置
    id: 'b',
    text: 'えお',
    originalText: 'えお',
    bbox: { x: 161, y: 100, width: 40, height: 20 },
    writingMode: 'horizontal' as WritingMode,
    order: 1,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [blockA, blockB],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'acrobat-wordbreak-h.pdf',
    fileName: 'acrobat-wordbreak-h.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

function makeAdjacentVerticalBlocksDoc(): PecoDocument {
  // 縦書きで 2 つの隣接 BB を上下に配置
  const blockA: TextBlock = {
    id: 'a',
    text: 'あいう',
    originalText: 'あいう',
    bbox: { x: 100, y: 80, width: 30, height: 200 },
    writingMode: 'vertical' as WritingMode,
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const blockB: TextBlock = {
    id: 'b',
    text: 'えお',
    originalText: 'えお',
    bbox: { x: 100, y: 285, width: 30, height: 100 },
    writingMode: 'vertical' as WritingMode,
    order: 1,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [blockA, blockB],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'acrobat-wordbreak-v.pdf',
    fileName: 'acrobat-wordbreak-v.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

/** ページ 0 の content stream を decode して返す */
function decodePage0Contents(doc: PDFDocument): Uint8Array | null {
  const page = doc.getPage(0);
  const rawContents = page.node.get(PDFName.of('Contents')) ?? page.node.Contents?.();
  if (!rawContents) return null;
  const resolved = doc.context.lookup(rawContents);
  const streams = resolved instanceof PDFArray ? resolved.asArray() : [rawContents];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef);
    if (!(s instanceof PDFRawStream)) return null;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { chunks.push(inflate(raw)); } catch { return null; }
    } else if (!filter) {
      chunks.push(raw);
    } else {
      return null;
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * content stream 中の Tj 演算子の operand (hex string `<...>` または literal `(...)`) を
 * 全て抽出する。
 * - Hex string: `<00200041...> Tj` ← CID/TrueType font の典型形式 (各 glyph index が
 *                                    16進 2 バイトずつ並ぶ)
 * - Literal string: `( ) Tj` ← StandardFonts (Helvetica 等) の場合
 *
 * 返り値は { hex: boolean; bytes: Uint8Array }[]。hex=true なら bytes は decode 後の値、
 * hex=false なら bytes は literal 内のバイト列。
 */
function extractTjOperands(latin1Text: string): Array<{ hex: boolean; bytes: Uint8Array; raw: string }> {
  const results: Array<{ hex: boolean; bytes: Uint8Array; raw: string }> = [];

  // Hex string operand: <...> Tj (空白許容)
  const hexRe = /<([0-9A-Fa-f\s]*)>\s*Tj\b/g;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(latin1Text)) !== null) {
    const cleaned = m[1].replace(/\s+/g, '');
    // 奇数桁の場合は最後に '0' 補完 (PDF 仕様)
    const padded = cleaned.length % 2 === 1 ? cleaned + '0' : cleaned;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < padded.length; i += 2) {
      bytes[i / 2] = parseInt(padded.substring(i, i + 2), 16);
    }
    results.push({ hex: true, bytes, raw: m[1] });
  }

  // Literal string operand: (...) Tj (バランスの取れた括弧を考慮しない簡易版)
  const litRe = /\(([^)]*)\)\s*Tj\b/g;
  while ((m = litRe.exec(latin1Text)) !== null) {
    const enc = new TextEncoder().encode(m[1]);
    results.push({ hex: false, bytes: enc, raw: m[1] });
  }

  return results;
}

/**
 * Tj operands の中に「U+0020 (= 半角スペース) を表す single-character entry」が
 * 含まれているかを判定する。
 *
 * - Hex string (TrueType font): 末尾の Tj が単一 glyph (= 2 バイト = 4 hex chars) で、
 *   かつ font の cmap で U+0020 にマップされるはず。
 *   厳密な cmap 検証は重いので、本テストでは「2 バイト幅の Tj operand が 1 つ以上存在」
 *   かつ「他のテキスト Tj とは別個に発行されている」ことで間接的に確認する。
 *
 * - Literal string (Helvetica): operand が exactly " " (0x20) を含む。
 *
 * issue #100 の修正により、各 BB 描画後に追加の drawText(' ', renderMode:3) が走るため、
 * 単独 Tj として空白用 operand が発行される。
 */
function findStandaloneSpaceTjs(operands: Array<{ hex: boolean; bytes: Uint8Array; raw: string }>): number {
  let count = 0;
  for (const op of operands) {
    if (op.hex) {
      // Hex (TrueType): 2 バイト = 1 glyph の Tj が空白の候補
      if (op.bytes.length === 2) {
        count++;
      }
    } else {
      // Literal: operand が単独の 0x20 (空白) のみで構成
      if (op.bytes.length === 1 && op.bytes[0] === 0x20) {
        count++;
      }
    }
  }
  return count;
}

describe('pdfSaver issue #100: Acrobat copy-paste word-break (trailing space)', () => {
  it('horizontal: 各 BB の末尾に invisible スペース (renderMode 3) が描画される', async () => {
    const primary = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const empty = await makeEmptyPdf();

    const saved = await buildPdfDocument(empty, makeAdjacentHorizontalBlocksDoc(), primary);
    const savedDoc = await PDFDocument.load(saved, { throwOnInvalidObject: false });
    const content = decodePage0Contents(savedDoc);
    expect(content).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(content!);

    // BT...ET の数を数える。BB が 2 つあり、各 BB は (text + trailing space) で
    // 2 つの drawText 呼び出しを行う (横書きは 1 つの GS フレーム内で 2 つの Tj)。
    const btCount = (latin.match(/\bBT\b/g) || []).length;
    const etCount = (latin.match(/\bET\b/g) || []).length;
    // 各 drawText が独自 BT...ET を発行するので、2 BB × 2 draw = 4 BT...ET
    expect(btCount).toBeGreaterThanOrEqual(4);
    expect(etCount).toBe(btCount);

    // renderMode 3 (invisible) が維持されていることを確認
    // #357: 単発マッチではなく「各 BT...ET セグメントで Tj より前に 3 Tr が存在する」を検証
    const renderMode3Check = assertAllTextSegmentsHaveRenderMode3(latin);
    expect(
      renderMode3Check.pass,
      `#357: renderMode 3 check failed for ${renderMode3Check.failingSegmentCount}/${renderMode3Check.totalTextSegments} segments`,
    ).toBe(true);
    // セグメント抽出自体の退行で vacuous pass しないためのガード
    expect(renderMode3Check.totalTextSegments).toBeGreaterThan(0);

    // Tj operands を全抽出して、単独 space 用 Tj が 2 つ (= BB 数) 存在することを確認
    const tjOps = extractTjOperands(latin);
    expect(tjOps.length).toBeGreaterThanOrEqual(4);

    const spaceTjCount = findStandaloneSpaceTjs(tjOps);
    // 2 つの BB それぞれの末尾に space 用 Tj が出るはず
    expect(
      spaceTjCount,
      `Expected at least 2 standalone single-glyph Tj (trailing spaces), got ${spaceTjCount}`,
    ).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('vertical: 各 BB の末尾に invisible スペース (renderMode 3) が描画される', async () => {
    const primary = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const empty = await makeEmptyPdf();

    const saved = await buildPdfDocument(empty, makeAdjacentVerticalBlocksDoc(), primary);
    const savedDoc = await PDFDocument.load(saved, { throwOnInvalidObject: false });
    const content = decodePage0Contents(savedDoc);
    expect(content).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(content!);

    // 縦書きは run ごとに独立 GS frame を push する。
    // 'あいう' / 'えお' は全 primary font なので run 数は各 1。
    // 各 BB は 1 (text) + 1 (space) = 2 つの GS frame = 2 BT...ET。
    // 2 BB × 2 BT = 4 BT...ET
    const btCount = (latin.match(/\bBT\b/g) || []).length;
    const etCount = (latin.match(/\bET\b/g) || []).length;
    expect(btCount).toBeGreaterThanOrEqual(4);
    expect(etCount).toBe(btCount);

    // renderMode 3 invisible が維持されている
    // #357: 単発マッチではなく「各 BT...ET セグメントで Tj より前に 3 Tr が存在する」を検証
    const renderMode3CheckVert = assertAllTextSegmentsHaveRenderMode3(latin);
    expect(
      renderMode3CheckVert.pass,
      `#357: renderMode 3 check failed for ${renderMode3CheckVert.failingSegmentCount}/${renderMode3CheckVert.totalTextSegments} segments (vertical)`,
    ).toBe(true);
    // セグメント抽出自体の退行で vacuous pass しないためのガード
    expect(renderMode3CheckVert.totalTextSegments).toBeGreaterThan(0);

    // Tj operands 抽出
    const tjOps = extractTjOperands(latin);
    expect(tjOps.length).toBeGreaterThanOrEqual(4);

    // 各 BB の末尾 space Tj が出ている (>= 2 個)
    const spaceTjCount = findStandaloneSpaceTjs(tjOps);
    expect(
      spaceTjCount,
      `Expected at least 2 standalone single-glyph Tj (trailing spaces), got ${spaceTjCount}`,
    ).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('horizontal: pdfjs extract で BB 間に word-break が入る (Acrobat-compatible)', async () => {
    // pdfjs (Acrobat と同じ heuristic を実装) を使って、保存した PDF から
    // text を抽出し、隣接 BB が無条件連結されないことを直接検証する。
    //
    // ※注: pdfjs と Acrobat は完全に同一 heuristic ではないが、
    //       「BT...ET 内の Tj 末尾 0x20」を見て word-break を入れる挙動は共通。
    //       本テストでは pdfjs で BB 末尾 space が抽出結果に反映されることを確認。
    const primary = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
    const empty = await makeEmptyPdf();
    const saved = await buildPdfDocument(empty, makeAdjacentHorizontalBlocksDoc(), primary);

    // pdfjs polyfill (jsdom 環境用)
    if (typeof (globalThis as any).ReadableStream === 'undefined') {
      const streams = await import('node:stream/web');
      (globalThis as any).ReadableStream = streams.ReadableStream;
      (globalThis as any).WritableStream = streams.WritableStream;
      (globalThis as any).TransformStream = streams.TransformStream;
    }
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(saved),
      disableWorker: true,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const textContent = await page.getTextContent();
    try { await pdf.cleanup(); } catch { /* ignore */ }
    try { await pdf.destroy(); } catch { /* ignore */ }

    // textContent.items は順序付きの text item 配列
    const items = textContent.items as Array<{ str?: string; hasEOL?: boolean }>;
    // 全 str を結合 (空白も含む)
    const allText = items.map((i) => i.str ?? '').join('');

    // 修正前: 'あいう' + 'えお' が連結されて 'あいうえお' になる
    // 修正後: 末尾スペースで 'あいう ' + 'えお' になり、'あいうえお' という連続部分は存在しない
    // (※ 修正後の str を join しても 'あいう えお' 等になり、'あいうえお' という連続パターンは消える)
    expect(allText).toContain('あいう');
    expect(allText).toContain('えお');
    // 連続マッチが無いことを検証 (= 末尾 space または間に区切りが入っている)
    expect(allText).not.toContain('あいうえお');
  }, 60_000);
});
