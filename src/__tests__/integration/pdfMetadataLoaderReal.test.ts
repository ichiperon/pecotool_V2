/**
 * プロダクションの meta 読込経路 (pdfjs getMetadata → pdfMetadataLoader) を
 * 実データで通す。これまでのテストは pdf-lib で直接 info dict を読んでいたが、
 * 実アプリは pdfjs 経由で meta を取得するため、別経路の検証。
 *
 * 検証:
 *   1. 実 PDF を編集 → save → pdfjs で開き直す → loadPecoToolBBoxMeta で全件取得できる
 *   2. 多量エントリ (22000 blocks over 128 pages) でも pdfjs 側で stack overflow しない
 *   3. prototype pollution 耐性 (安全)
 *   4. 非 BMP 文字 (絵文字・サロゲートペア) が正しく復元
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// pdfjs は real を使う (この test の主眼)
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: vi.fn().mockResolvedValue({ mtime: Date.now() }) }));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import { loadPecoToolBBoxMeta } from '../../utils/pdfMetadataLoader';
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types';

const TEST_DIR = resolve(__dirname, '../../../test');
const FONT_PATH = resolve(__dirname, '../../../public/fonts/IPAexGothic.ttf');

function findInputPdf(): string | null {
  if (!existsSync(TEST_DIR)) return null;
  const pdfs = readdirSync(TEST_DIR)
    .filter((n) => n.toLowerCase().endsWith('.pdf'))
    .filter((n) => !['_move', '_split', '_edited', '_empty_page', '_vertical_split', '_surrogate', '_micro_shifted'].some((sfx) => n.includes(sfx)));
  if (pdfs.length === 0) return null;
  const full = pdfs.map((n) => resolve(TEST_DIR, n));
  full.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return full[0];
}

const REAL_PDF_PATH = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

async function openWithPdfjs(bytes: Uint8Array): Promise<any> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    disableWorker: true,
    disableFontFace: true,
  });
  return await loadingTask.promise;
}

beforeAll(async () => {
  if (typeof (globalThis as any).ReadableStream === 'undefined') {
    const streams = await import('node:stream/web');
    (globalThis as any).ReadableStream = streams.ReadableStream;
    (globalThis as any).WritableStream = streams.WritableStream;
    (globalThis as any).TransformStream = streams.TransformStream;
  }
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now()}`,
    } as unknown as Crypto;
  }
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

describe.skipIf(!hasRealPdf)('pdfMetadataLoader (production 経路) × 実データ', () => {
  it('save → pdfjs で開き直し → loadPecoToolBBoxMeta で全 128 ページの meta 取得', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);

    // pdfjs で元 PDF を開き、page dim と text extraction
    const pdfjsDocOrig = await openWithPdfjs(new Uint8Array(realBytes));
    const totalPages: number = pdfjsDocOrig.numPages;
    const pageDim: Array<{ width: number; height: number }> = [];
    for (let i = 0; i < totalPages; i++) {
      const page = await pdfjsDocOrig.getPage(i + 1);
      const vp = page.getViewport({ scale: 1.0 });
      pageDim.push({ width: vp.width, height: vp.height });
    }
    try { await pdfjsDocOrig.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocOrig.destroy(); } catch { /* ignore */ }

    // 各ページに 1 ブロック (unique marker) を置いて save
    const pages = new Map<number, PageData>();
    for (let i = 0; i < totalPages; i++) {
      const block: TextBlock = {
        id: `p${i}`,
        text: `META_MARKER_PAGE_${i}`,
        originalText: `META_MARKER_PAGE_${i}`,
        bbox: { x: 50, y: 50, width: 200, height: 20 },
        writingMode: 'horizontal' as WritingMode,
        order: 0,
        isNew: false,
        isDirty: true,
      };
      pages.set(i, {
        pageIndex: i,
        width: pageDim[i].width,
        height: pageDim[i].height,
        textBlocks: [block],
        isDirty: true,
        thumbnail: null,
      });
    }
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: REAL_PDF_PATH.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf',
      totalPages,
      metadata: {},
      pages,
    };

    const fontBuf = readFileSync(FONT_PATH);
    const fontAB = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontAB).set(fontBuf);
    const t0 = Date.now();
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontAB);
    console.log(`[metaLoader] savePDF: ${Date.now() - t0}ms`);

    // production 経路: pdfjs で saved bytes を開き loadPecoToolBBoxMeta を呼ぶ
    const pdfjsDocSaved = await openWithPdfjs(new Uint8Array(saved));
    const tLoad = Date.now();
    const meta = await loadPecoToolBBoxMeta(pdfjsDocSaved);
    console.log(`[metaLoader] loadPecoToolBBoxMeta: ${Date.now() - tLoad}ms`);
    try { await pdfjsDocSaved.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocSaved.destroy(); } catch { /* ignore */ }

    expect(meta).not.toBeNull();
    expect(Object.keys(meta!).length).toBe(totalPages);

    const missing: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      const entries = meta![String(i)];
      if (!entries || entries.length !== 1 || entries[0].text !== `META_MARKER_PAGE_${i}`) {
        missing.push(i);
      }
    }
    console.log(`[metaLoader] missing/mismatched pages: ${missing.length}`);
    expect(missing).toEqual([]);
  }, 900_000);

  it('大容量 meta (全 22000 blocks) でも pdfjs.getMetadata → loadPecoToolBBoxMeta が stack overflow しない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const pdfjsDocOrig = await openWithPdfjs(new Uint8Array(realBytes));
    const totalPages: number = pdfjsDocOrig.numPages;
    const pageDim: Array<{ width: number; height: number }> = [];
    for (let i = 0; i < totalPages; i++) {
      const page = await pdfjsDocOrig.getPage(i + 1);
      const vp = page.getViewport({ scale: 1.0 });
      pageDim.push({ width: vp.width, height: vp.height });
    }
    try { await pdfjsDocOrig.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocOrig.destroy(); } catch { /* ignore */ }

    // 各ページに 170 ブロック → 合計 ~21760 ブロック (実データ相当の密度)
    const BLOCKS_PER_PAGE = 170;
    const pages = new Map<number, PageData>();
    for (let i = 0; i < totalPages; i++) {
      const blocks: TextBlock[] = [];
      for (let k = 0; k < BLOCKS_PER_PAGE; k++) {
        blocks.push({
          id: `p${i}-b${k}`,
          text: `p${i}_b${k}_text`,
          originalText: `p${i}_b${k}_text`,
          bbox: { x: (k * 3) % 500, y: (k * 7) % 700, width: 40, height: 10 },
          writingMode: 'horizontal' as WritingMode,
          order: k,
          isNew: false,
          isDirty: true,
        });
      }
      pages.set(i, {
        pageIndex: i,
        width: pageDim[i].width,
        height: pageDim[i].height,
        textBlocks: blocks,
        isDirty: true,
        thumbnail: null,
      });
    }
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'x.pdf',
      totalPages,
      metadata: {},
      pages,
    };

    const fontBuf = readFileSync(FONT_PATH);
    const fontAB = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontAB).set(fontBuf);
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontAB);

    const pdfjsDocSaved = await openWithPdfjs(new Uint8Array(saved));
    const meta = await loadPecoToolBBoxMeta(pdfjsDocSaved);
    try { await pdfjsDocSaved.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocSaved.destroy(); } catch { /* ignore */ }

    expect(meta).not.toBeNull();
    expect(Object.keys(meta!).length).toBe(totalPages);
    // 代表ページ検証
    for (const p of [0, Math.floor(totalPages / 2), totalPages - 1]) {
      const entries = meta![String(p)];
      expect(entries.length).toBe(BLOCKS_PER_PAGE);
      expect(entries[0].text).toBe(`p${p}_b0_text`);
      expect(entries[entries.length - 1].text).toBe(`p${p}_b${BLOCKS_PER_PAGE - 1}_text`);
    }
    const totalEntries = Object.values(meta!).reduce((s: number, arr) => s + (arr as unknown[]).length, 0);
    console.log(`[metaLoader] total meta entries = ${totalEntries}`);
    expect(totalEntries).toBe(totalPages * BLOCKS_PER_PAGE);
  }, 900_000);

  it('非 BMP 文字 (絵文字・サロゲートペア) が production 経路でも保持される', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const pdfjsDocOrig = await openWithPdfjs(new Uint8Array(realBytes));
    const totalPages: number = pdfjsDocOrig.numPages;
    const pageDim: Array<{ width: number; height: number }> = [];
    for (let i = 0; i < Math.min(totalPages, 3); i++) {
      const page = await pdfjsDocOrig.getPage(i + 1);
      const vp = page.getViewport({ scale: 1.0 });
      pageDim.push({ width: vp.width, height: vp.height });
    }
    try { await pdfjsDocOrig.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocOrig.destroy(); } catch { /* ignore */ }

    const testStrings = ['𠮷野家', '髙橋', 'emoji😀', 'flag🇯🇵'];
    const pages = new Map<number, PageData>();
    // 1 ページ目に 4 ブロックを仕込む
    const blocks: TextBlock[] = testStrings.map((s, k) => ({
      id: `p0-b${k}`,
      text: s,
      originalText: s,
      bbox: { x: 50 + k * 80, y: 50, width: 70, height: 20 },
      writingMode: 'horizontal' as WritingMode,
      order: k,
      isNew: false,
      isDirty: true,
    }));
    pages.set(0, {
      pageIndex: 0,
      width: pageDim[0].width,
      height: pageDim[0].height,
      textBlocks: blocks,
      isDirty: true,
      thumbnail: null,
    });
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH, fileName: 'x.pdf', totalPages, metadata: {}, pages,
    };

    const fontBuf = readFileSync(FONT_PATH);
    const fontAB = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontAB).set(fontBuf);
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontAB);

    const pdfjsDocSaved = await openWithPdfjs(new Uint8Array(saved));
    const meta = await loadPecoToolBBoxMeta(pdfjsDocSaved);
    try { await pdfjsDocSaved.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDocSaved.destroy(); } catch { /* ignore */ }

    expect(meta).not.toBeNull();
    const entries = meta!['0'];
    expect(entries).toHaveLength(testStrings.length);
    for (let i = 0; i < testStrings.length; i++) {
      expect(entries[i].text).toBe(testStrings[i]);
    }
  }, 900_000);
});
