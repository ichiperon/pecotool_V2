/**
 * Regression test (PCT-165 / issue #396):
 * saveAllPagesWithOffset が保存後（全ページ isDirty=false）に描画ゼロ → 位置補正が
 * 保存PDFに未反映になる no-op バグを固定する。
 *
 * 症状:
 *   OCR → 保存（Ctrl+S=resetDirty）→ オフセット較正調整 → 全ページ適用、の順で
 *   dirtyPages = filter(isDirty) が空 → 描画ループがゼロ周 → translate(...+dx, ...-dy)
 *   が一度も実行されず、成功トーストは出るがオフセットが焼き込まれない。
 *
 * 修正:
 *   SaveDialogOptions.applyOffsetToAllPages=true のとき buildPdfDocumentCore は isDirty に
 *   依存せず、textBlocks を持つ全ページを再描画対象に含める。
 *
 * 検証戦略（成功トーストではなく PDF 内容＝content stream の translate cm で確認）:
 *   1. pdf-lib で最小 1 ページ PDF を生成（実テストPDF非依存）。
 *   2. 全ページ isDirty=false の documentState を作る（＝保存後状態）。
 *   3. flag OFF + offset → 描画ゼロ（translate 不在）を確認（バグの前提＝no-op）。
 *   4. flag ON  + offset={0,0} → bbox.x の translate（再描画される baseline）。
 *   5. flag ON  + offset={dx,dy} → translate が (+dx, -dy) シフトすることを確認。
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';
import type { SaveDialogOptions } from '../../hooks/useFileOperations';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// ---------------------------------------------------------------------------
// Helpers（pdfTextLayerOffset.test.ts と同一流儀）
// ---------------------------------------------------------------------------

function arrayBufferFromFile(fileName: string): ArrayBuffer {
  const buf = readFileSync(resolve(process.cwd(), 'public/fonts', fileName));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function makeMinimalPdf(pageW = 595, pageH = 842): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([pageW, pageH]);
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function decodePage0ContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const rawContents =
    page.node.get(PDFName.of('Contents')) ??
    (page.node as unknown as { Contents?(): unknown }).Contents?.();
  if (!rawContents) return '';
  const resolved = doc.context.lookup(rawContents as Parameters<typeof doc.context.lookup>[0]);
  const streams =
    resolved instanceof PDFArray
      ? resolved.asArray()
      : [rawContents as Parameters<typeof doc.context.lookup>[0]];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const s = doc.context.lookup(streamRef as Parameters<typeof doc.context.lookup>[0]);
    if (!(s instanceof PDFRawStream)) continue;
    const filter = s.dict.lookup(PDFName.of('Filter'));
    const raw = s.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try {
        chunks.push(inflate(raw));
      } catch {
        /* skip unreadable streams */
      }
    } else if (!filter) {
      chunks.push(raw);
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder('latin1').decode(out);
}

function extractCmOperands(
  text: string,
): Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> {
  const re =
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      a: parseFloat(m[1]),
      b: parseFloat(m[2]),
      c: parseFloat(m[3]),
      d: parseFloat(m[4]),
      e: parseFloat(m[5]),
      f: parseFloat(m[6]),
    });
  }
  return out;
}

/** 純平行移動 cm（a=1,b=0,c=0,d=1）だけ抽出（横書き経路の translate(x, y)）。 */
function extractTranslateCms(text: string): Array<{ e: number; f: number }> {
  return extractCmOperands(text)
    .filter(
      (m) =>
        Math.abs(m.a - 1) < 0.001 &&
        Math.abs(m.b) < 0.001 &&
        Math.abs(m.c) < 0.001 &&
        Math.abs(m.d - 1) < 0.001,
    )
    .map(({ e, f }) => ({ e, f }));
}

/**
 * 全ページ isDirty=false の documentState を作る（＝保存後状態を再現）。
 * 横書きブロックを bbox (x=100, y=50, w=200, h=24) に置く。
 */
function makePostSaveDocWithHorizontalBlock(pageW: number, pageH: number): PecoDocument {
  const block: TextBlock = {
    id: 'hblock-0',
    text: 'テスト文字',
    originalText: 'テスト文字',
    bbox: { x: 100, y: 50, width: 200, height: 24 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false, // 保存後: block も clean
  };
  const page: PageData = {
    pageIndex: 0,
    width: pageW,
    height: pageH,
    textBlocks: [block],
    isDirty: false, // 保存後: 全ページ isDirty=false（本バグの前提条件）
    thumbnail: null,
  };
  return {
    filePath: 'test-offset-all.pdf',
    fileName: 'test-offset-all.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PCT-165 / #396: saveAllPagesWithOffset は全ページ isDirty=false でも no-op にならない', () => {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const OFFSET = { dx: 11.34, dy: 5.67 };

  it('バグの前提: flag OFF + 全ページ isDirty=false ではオフセットが焼き込まれない（描画ゼロ）', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const originalBytes = await makeMinimalPdf(PAGE_W, PAGE_H);
    const doc = makePostSaveDocWithHorizontalBlock(PAGE_W, PAGE_H);

    // applyOffsetToAllPages を渡さない従来経路。dirtyPages 空 → 描画ループゼロ周。
    const options: SaveDialogOptions = { compression: 'none', textLayerOffsetPt: OFFSET };
    const saved = await buildPdfDocument(originalBytes, doc, fontBytes, [], undefined, undefined, options);

    const text = await decodePage0ContentText(saved);
    const translates = extractTranslateCms(text);
    // テキストブロックが再描画されないため translate は一切現れない。
    expect(translates.length).toBe(0);
  }, 60_000);

  it('修正: flag ON + 全ページ isDirty=false でも translate が (+dx, -dy) シフトして焼き込まれる', async () => {
    const fontBytes = arrayBufferFromFile('IPAmjMincho.ttf');
    const originalBytes = await makeMinimalPdf(PAGE_W, PAGE_H);
    const doc = makePostSaveDocWithHorizontalBlock(PAGE_W, PAGE_H);

    // baseline: flag ON + offset ゼロ → 再描画されるが未シフト（bbox.x の translate）。
    const baselineOptions: SaveDialogOptions = {
      compression: 'none',
      textLayerOffsetPt: { dx: 0, dy: 0 },
      applyOffsetToAllPages: true,
    };
    const savedBaseline = await buildPdfDocument(
      new Uint8Array(originalBytes),
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      baselineOptions,
    );

    // shifted: flag ON + offset {dx,dy}。
    const shiftedOptions: SaveDialogOptions = {
      compression: 'none',
      textLayerOffsetPt: OFFSET,
      applyOffsetToAllPages: true,
    };
    const savedShifted = await buildPdfDocument(
      new Uint8Array(originalBytes),
      doc,
      fontBytes,
      [],
      undefined,
      undefined,
      shiftedOptions,
    );

    const baselineTranslates = extractTranslateCms(await decodePage0ContentText(savedBaseline));
    const shiftedTranslates = extractTranslateCms(await decodePage0ContentText(savedShifted));

    // fix の核心: 非 dirty ページでも再描画されるため translate が現れる。
    expect(baselineTranslates.length).toBeGreaterThanOrEqual(1);
    expect(shiftedTranslates.length).toBeGreaterThanOrEqual(1);

    // baseline は bbox.x=100 近傍（未シフト）。
    expect(baselineTranslates[0].e).toBeCloseTo(100, 0);

    // シフト量 = offset。x += dx, y -= dy（viewport +y 下向き）。
    const deltaX = shiftedTranslates[0].e - baselineTranslates[0].e;
    const deltaY = shiftedTranslates[0].f - baselineTranslates[0].f;
    expect(deltaX).toBeCloseTo(OFFSET.dx, 1);
    expect(deltaY).toBeCloseTo(-OFFSET.dy, 1);
  }, 60_000);
});
