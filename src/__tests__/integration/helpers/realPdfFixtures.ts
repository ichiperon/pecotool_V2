import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflate } from 'pako';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFHexString,
  PDFString,
  type PDFObject,
  type PDFRef,
  type PDFDict,
} from '@cantoo/pdf-lib';
import type { PageData, PecoDocument, TextBlock, WritingMode } from '../../../types';
import { safeDecodePdfText } from '../../../utils/pdfLibSafeDecode';

export const TEST_DIR = resolve(__dirname, '../../../../test');
export const FONT_PATH = resolve(__dirname, '../../../../public/fonts/IPAexGothic.ttf');

const OUTPUT_SUFFIXES = [
  '_micro_shifted', '_split', '_move', '_split_all',
  '_move2_shifted', '_move2_restored', '_edited',
  '_empty_page', '_vertical_split', '_surrogate',
  '_t1_move', '_t2_edited', '_t3_both',
  '_t4_split_all_x1', '_t5_split_all_x2',
  '_a4_1_reverse', '_a4_2_orderBroken',
  '_a5_1_vertical', '_a5_2_mixed',
  '_a6_1_emptyAll',
  '_a1_1_deleteAll', '_a1_2_halfRemove', '_a1_3_firstLastRemove', '_a1_4_emptyBBAdd',
  '_a2_1_altResize', '_a2_2_degenerate', '_a2_3_offpage',
  '_a3_1_add10', '_a3_2_add1000', '_a3_3_dupCoord',
  '_c3_1_synthetic', '_c3_1_synthetic_input',
  '_c3_3_truncated', '_c3_3_truncated_input',
	  '_e2_3a_offbyone', '_e2_3b_bbox_only', '_e2_3c_large_meta',
	  '_b1_pdfjs_external_1cycle',
	  '_b1_1_noEdit10cycle', '_b1_2_shift10cycle',
  '_c1_1_raceSim', '_c1_2_doubleSave_1', '_c1_2_doubleSave_2',
];

export function findInputPdf(): string | null {
  if (!existsSync(TEST_DIR)) return null;
  const entries = readdirSync(TEST_DIR);
  const pdfs = entries
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .filter((name) => !OUTPUT_SUFFIXES.some((suffix) => name.includes(suffix + '.pdf')));
  if (pdfs.length === 0) return null;
  const full = pdfs.map((n) => resolve(TEST_DIR, n));
  full.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return full[0];
}

export function outputPath(realPdfPath: string, suffix: string): string {
  if (!realPdfPath) return resolve(TEST_DIR, `_placeholder${suffix}.pdf`);
  const base = realPdfPath.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf';
  const stem = base.replace(/\.pdf$/i, '');
  return resolve(TEST_DIR, `${stem}${suffix}.pdf`);
}

export function loadFontArrayBuffer(): ArrayBuffer {
  const fontBuf = readFileSync(FONT_PATH);
  const buf = new ArrayBuffer(fontBuf.byteLength);
  new Uint8Array(buf).set(fontBuf);
  return buf;
}

const FALLBACK_FONT_PATHS = [
  resolve(__dirname, '../../../../public/fonts/NotoSans-Regular.ttf'),
  resolve(__dirname, '../../../../public/fonts/NotoSansSymbols-Regular.ttf'),
  resolve(__dirname, '../../../../public/fonts/NotoSansSymbols2-Regular.ttf'),
];

/**
 * 保存済み PDF を「ツールの実ロード経路」と等価な形で PecoDocument に復元する。
 * PecoToolBBoxes meta があればそれを採用 (lossless)、無ければ pdfjs テキスト抽出に
 * フォールバック。B1-1/B1-2 の多サイクル検証で使う。
 */
export async function loadPecoDocumentMetaFirst(
  realBytes: Uint8Array,
  realPdfPath: string,
): Promise<{ doc: PecoDocument; source: 'meta' | 'pdfjs'; totalBlocks: number; totalPages: number }> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsCopy = new Uint8Array(realBytes.byteLength);
  pdfjsCopy.set(realBytes);
  const pdfjsDoc = await pdfjsLib
    .getDocument({ data: pdfjsCopy, disableWorker: true, disableFontFace: true })
    .promise;
  const totalPages: number = pdfjsDoc.numPages;

  const { loadPecoToolBBoxMeta } = await import('../../../utils/pdfMetadataLoader');
  const meta = await loadPecoToolBBoxMeta(pdfjsDoc);

  if (meta) {
    const pages = new Map<number, PageData>();
    let totalBlocks = 0;
    for (let i = 0; i < totalPages; i++) {
      const page = await pdfjsDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1.0 });
      const entries = meta[String(i)] ?? [];
      const sorted = [...entries].sort((a, b) => a.order - b.order);
      const blocks: TextBlock[] = sorted.map((m, idx) => ({
        id: `reload-p${i}-${idx}`,
        text: m.text,
        originalText: m.text,
        bbox: m.bbox,
        writingMode: m.writingMode as WritingMode,
        order: idx,
        isNew: false,
        isDirty: true,
      }));
      totalBlocks += blocks.length;
      pages.set(i, {
        pageIndex: i,
        width: viewport.width,
        height: viewport.height,
        textBlocks: blocks,
        isDirty: true,
        thumbnail: null,
      });
    }
    try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
    return {
      doc: {
        filePath: realPdfPath,
        fileName: realPdfPath.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf',
        totalPages,
        metadata: {},
        pages,
      },
      source: 'meta',
      totalBlocks,
      totalPages,
    };
  }

  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
  const fallback = await buildPecoDocumentFromRealPdf(realBytes, realPdfPath);
  return { doc: fallback.doc, source: 'pdfjs', totalBlocks: fallback.totalBlocks, totalPages: fallback.totalPages };
}

export function loadFallbackFontArrayBuffers(): ArrayBuffer[] {
  return FALLBACK_FONT_PATHS.filter((p) => existsSync(p)).map((p) => {
    const buf = readFileSync(p);
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
  });
}

export async function ensurePdfjsEnv(): Promise<void> {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () =>
        `${Math.random().toString(16).slice(2)}-${Date.now()}-${Math.random().toString(16).slice(2)}` as `${string}-${string}-${string}-${string}-${string}`,
    } as unknown as Crypto;
  }
  if (typeof (globalThis as any).ReadableStream === 'undefined') {
    const streams = await import('node:stream/web');
    (globalThis as any).ReadableStream = streams.ReadableStream;
    (globalThis as any).WritableStream = streams.WritableStream;
    (globalThis as any).TransformStream = streams.TransformStream;
  }
}

export async function buildPecoDocumentFromRealPdf(
  realBytes: Uint8Array,
  realPdfPath: string,
  shift: { dx: number; dy: number } = { dx: 0, dy: 0 },
): Promise<{ doc: PecoDocument; totalBlocks: number; totalPages: number }> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs は渡された ArrayBuffer を detach する可能性があるため、必ず独立コピーを渡す
  const pdfjsCopy = new Uint8Array(realBytes.byteLength);
  pdfjsCopy.set(realBytes);
  const loadingTask = pdfjsLib.getDocument({
    data: pdfjsCopy,
    disableWorker: true,
    disableFontFace: true,
  });
  const pdfjsDoc = await loadingTask.promise;
  const totalPages: number = pdfjsDoc.numPages;

  const pages = new Map<number, PageData>();
  let totalBlocks = 0;
  for (let i = 0; i < totalPages; i++) {
    const page = await pdfjsDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const textItems = (textContent.items as Array<any>).filter(
      (item) => typeof item.str === 'string' && item.str.trim() !== '',
    );

    const blocks: TextBlock[] = textItems.map((item, idx) => {
      const tx: number[] = item.transform;
      const mag = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || 1;
      const ux = tx[0] / mag, uy = tx[1] / mag;
      const px = -uy, py = ux;
      const thickness =
        item.height > 0
          ? item.height
          : Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || mag || 12;
      const runLength = item.width || mag * item.str.length * 0.6;
      const ascent = thickness * 1.16;
      const corners: [number, number][] = [
        [tx[4], tx[5]],
        [tx[4] + ux * runLength, tx[5] + uy * runLength],
        [tx[4] + px * ascent, tx[5] + py * ascent],
        [tx[4] + ux * runLength + px * ascent, tx[5] + uy * runLength + py * ascent],
      ];
      const vc = corners.map(([cx, cy]) => viewport.convertToViewportPoint(cx, cy));
      const vxs = vc.map((c: number[]) => c[0]);
      const vys = vc.map((c: number[]) => c[1]);
      const bbox = {
        x: Math.min(...vxs) + shift.dx,
        y: Math.min(...vys) + shift.dy,
        width: Math.max(...vxs) - Math.min(...vxs),
        height: Math.max(...vys) - Math.min(...vys),
      };
      const [vDirX, vDirY] = viewport.convertToViewportPoint(tx[4] + ux, tx[5] + uy);
      const isVertical =
        Math.abs(vDirY - vc[0][1]) > Math.abs(vDirX - vc[0][0]);
      return {
        id: `p${i}-b${idx}`,
        text: item.str,
        originalText: item.str,
        bbox,
        writingMode: (isVertical ? 'vertical' : 'horizontal') as WritingMode,
        order: idx,
        isNew: false,
        isDirty: true,
      };
    });

    totalBlocks += blocks.length;
    pages.set(i, {
      pageIndex: i,
      width: viewport.width,
      height: viewport.height,
      textBlocks: blocks,
      isDirty: true,
      thumbnail: null,
    });
  }
  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }

  return {
    doc: {
      filePath: realPdfPath,
      fileName: realPdfPath.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf',
      totalPages,
      metadata: {},
      pages,
    },
    totalBlocks,
    totalPages,
  };
}

export function decodePageContents(doc: PDFDocument, pageIndex: number): Uint8Array | null {
  const page = doc.getPage(pageIndex);
  const contentsRef = (page.node as unknown as { Contents(): PDFObject | PDFRef | undefined }).Contents();
  if (!contentsRef) return null;
  const resolved = doc.context.lookup(contentsRef);
  const streams: PDFObject[] =
    resolved instanceof PDFArray ? resolved.asArray() : [contentsRef];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const stream = doc.context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    const raw = stream.getContents();
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

export interface BBoxMetaEntry {
  bbox: { x: number; y: number; width: number; height: number };
  text: string;
  order: number;
  writingMode: string;
}

export function readBBoxMeta(doc: PDFDocument): Record<string, BBoxMetaEntry[]> | null {
  const infoDict = (doc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  if (!infoDict) return null;
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (v === undefined || v === null) return null;
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try {
      return JSON.parse(safeDecodePdfText(v)) as Record<string, BBoxMetaEntry[]>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * byte diff count for pages with non-zero blocks (i.e. pages that were edited).
 * Returns { totalPages, unchangedPages, unchangedPagesWithBlocks }
 * unchangedPagesWithBlocks > 0 means some edited pages were not written (bug).
 */
export function diffPageContents(
  originalDoc: PDFDocument,
  savedDoc: PDFDocument,
  blockCountPerPage: Map<number, number>,
): { unchangedPages: number[]; unchangedPagesWithBlocks: number[] } {
  const totalPages = originalDoc.getPages().length;
  const unchangedPages: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    const a = decodePageContents(originalDoc, i);
    const b = decodePageContents(savedDoc, i);
    if (!a || !b) continue;
    if (a.length !== b.length) continue;
    let same = true;
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== b[j]) { same = false; break; }
    }
    if (same) unchangedPages.push(i);
  }
  const unchangedPagesWithBlocks = unchangedPages.filter(
    (p) => (blockCountPerPage.get(p) ?? 0) > 0,
  );
  return { unchangedPages, unchangedPagesWithBlocks };
}

export function loadPdfBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * pdfjs.getDocument / PDFDocument.load など下流が ArrayBuffer を detach する
 * 可能性があるため、保存/検証ごとにフレッシュなコピーを作って渡す。
 */
export function freshCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * ツール側のロード経路相当 (pdfjs + loadPecoToolBBoxMeta) で保存済み PDF を開き直し、
 * ページごとの BB メタ (order でソート済み) を返す。
 * reload 後のツール表示が「期待通り」かを検証するために使う。
 */
export async function reloadBBoxMetaViaPdfjs(savedBytes: Uint8Array): Promise<{
  meta: Record<string, BBoxMetaEntry[]> | null;
  totalPages: number;
}> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(savedBytes),
    disableWorker: true,
    disableFontFace: true,
  });
  const pdfjsDoc = await loadingTask.promise;
  const totalPages: number = pdfjsDoc.numPages;
  const { loadPecoToolBBoxMeta } = await import('../../../utils/pdfMetadataLoader');
  const parsed = await loadPecoToolBBoxMeta(pdfjsDoc);
  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
  if (!parsed) return { meta: null, totalPages };
  const sorted: Record<string, BBoxMetaEntry[]> = {};
  for (const [k, arr] of Object.entries(parsed)) {
    sorted[k] = [...arr].sort((a, b) => a.order - b.order);
  }
  return { meta: sorted, totalPages };
}
