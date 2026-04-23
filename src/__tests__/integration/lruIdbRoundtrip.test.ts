/**
 * A3: LRU + IDB 退避経路の検証。
 *
 * 背景: pecoStore.updatePageData は MAX_CACHED_PAGES (=50) を超えると古いページを
 *       メモリから IDB に退避する。保存時 useFileOperations._executeSave は
 *       getAllTemporaryPageData() で IDB から退避ページを回収し、メモリと merge
 *       してから savePDF に渡す。
 *
 *       実データ (128 ページ PDF) を開いて全ページを編集しても、LRU によって
 *       最新アクセス 50 ページのみがメモリに残る。残り 78 ページは IDB にある。
 *       この状態で保存して「全 128 ページの編集が bboxMeta に載っているか」を検証する。
 *
 * 実装方針:
 *   - fake-indexeddb は未導入のため、pdfTemporaryStorage を in-memory Map で mock する。
 *     mock は real の saveTemporaryPageDataBatch/getAllTemporaryPageData/clearTemporaryChanges
 *     の動作を忠実に再現する (thumbnail 除去、filePath プレフィックス、cursor 走査、BOM なし)。
 *   - pecoStore は実物を使用 (LRU 判定ロジックを本物で走らせる)。
 *   - savePDF / buildPdfDocument は実 pdf-lib で動かす。
 *   - useFileOperations._executeSave は hook なので直接は呼べない → 中身のコア (IDB 回収
 *     + merge + filter + savePDF) をテスト内で同等に再現する。
 *
 * 期待:
 *   - 128 ページ全てを pecoStore.updatePageData で編集 (LRU eviction が発動)
 *   - メモリには 50 ページ、IDB には 78 ページが乗る
 *   - save 経路で IDB + メモリを merge → 128 ページすべて savePDF に渡る
 *   - 保存 PDF の bboxMeta に 128 ページ全ての編集結果がある
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFString,
  type PDFDict,
} from '@cantoo/pdf-lib';

// ── mock: in-memory IDB の振る舞いを再現 ────────────────────────
const fakeIdb = new Map<string, unknown>();

vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(async (filePath: string, pageIndex: number, data: any) => {
    const key = `${filePath}:${pageIndex}`;
    const { thumbnail: _t, ...clean } = data;
    fakeIdb.set(key, clean);
  }),
  saveTemporaryPageDataBatch: vi.fn(
    async (entries: Array<{ filePath: string; pageIndex: number; data: any }>) => {
      for (const { filePath, pageIndex, data } of entries) {
        const key = `${filePath}:${pageIndex}`;
        const { thumbnail: _t, ...clean } = data;
        fakeIdb.set(key, clean);
      }
    },
  ),
  getTemporaryPageData: vi.fn(async (filePath: string, pageIndex: number) => {
    const key = `${filePath}:${pageIndex}`;
    return fakeIdb.get(key) ?? null;
  }),
  getAllTemporaryPageData: vi.fn(async (filePath: string) => {
    const result = new Map<number, unknown>();
    const prefix = `${filePath}:`;
    for (const [key, value] of fakeIdb.entries()) {
      if (key.startsWith(prefix)) {
        const idx = parseInt(key.slice(prefix.length), 10);
        result.set(idx, value);
      }
    }
    return result;
  }),
  clearTemporaryChanges: vi.fn(async (filePath: string) => {
    const prefix = `${filePath}:`;
    for (const key of Array.from(fakeIdb.keys())) {
      if (key.startsWith(prefix)) fakeIdb.delete(key);
    }
  }),
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(),
}));

// Tauri 系は依存で触られるため空 mock
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: vi.fn().mockResolvedValue({ mtime: Date.now() }) }));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { safeDecodePdfText } from '../../utils/pdfLibSafeDecode';
import type { PecoDocument, PageData, TextBlock } from '../../types';

const TEST_DIR = resolve(__dirname, '../../../test');
const FONT_PATH = resolve(__dirname, '../../../public/fonts/IPAexGothic.ttf');

function findInputPdf(): string | null {
  if (!existsSync(TEST_DIR)) return null;
  const pdfs = readdirSync(TEST_DIR)
    .filter((n) => n.toLowerCase().endsWith('.pdf'))
    .filter((n) => !['_move', '_split', '_edited', '_empty_page', '_vertical_split', '_surrogate', '_micro_shifted'].some((sfx) => n.includes(sfx)));
  if (pdfs.length === 0) return null;
  return resolve(TEST_DIR, pdfs[0]);
}

const REAL_PDF_PATH = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

function readBBoxMeta(doc: PDFDocument): Record<string, unknown> | null {
  const infoDict = (doc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  if (!infoDict) return null;
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try { return JSON.parse(safeDecodePdfText(v)); } catch { return null; }
  }
  return null;
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
  fakeIdb.clear();
  // store リセット
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
  } as any);
});

describe.skipIf(!hasRealPdf)('A3: LRU + IDB 経由の save', () => {
  it('128 ページの PDF を全ページ編集 → LRU で IDB 退避 → save → 全 128 ページが bboxMeta に乗る', async () => {
    // --- 元 PDF + pdfjs で全ページ viewport 取得 ---
    const realBytes = readFileSync(REAL_PDF_PATH);
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(realBytes),
      disableWorker: true,
      disableFontFace: true,
    });
    const pdfjsDoc = await loadingTask.promise;
    const totalPages: number = pdfjsDoc.numPages;
    console.log(`[A3] pdf pages=${totalPages}`);

    // ページ寸法を記録 (後で pecoStore に load するため)
    const pageDim: Array<{ width: number; height: number }> = [];
    for (let i = 0; i < totalPages; i++) {
      const page = await pdfjsDoc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1.0 });
      pageDim.push({ width: vp.width, height: vp.height });
    }
    try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc.destroy(); } catch { /* ignore */ }

    // --- 空 PageData 128 件で PecoDocument をストアに載せる ---
    const initialPages = new Map<number, PageData>();
    for (let i = 0; i < totalPages; i++) {
      initialPages.set(i, {
        pageIndex: i,
        width: pageDim[i].width,
        height: pageDim[i].height,
        textBlocks: [],
        isDirty: false,
        thumbnail: null,
      });
    }
    const initialDoc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: REAL_PDF_PATH.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf',
      totalPages,
      metadata: {},
      pages: initialPages,
    };
    usePecoStore.getState().setDocument(initialDoc);

    // --- pecoStore.updatePageData で 128 ページぶんを順に編集 (LRU eviction 発動) ---
    //   各ページに unique text block を 1 つ置いて、ページ番号を text に埋め込む
    const store = usePecoStore.getState();
    for (let i = 0; i < totalPages; i++) {
      const block: TextBlock = {
        id: `p${i}-b0`,
        text: `PAGE_${i}_MARKER`,
        originalText: `PAGE_${i}_MARKER`,
        bbox: { x: 100, y: 100 + i * 0.5, width: 200, height: 20 },
        writingMode: 'horizontal',
        order: 0,
        isNew: false,
        isDirty: true,
      };
      // pushUndo=false で undo スタック汚染を避ける
      store.updatePageData(i, { textBlocks: [block], isDirty: true }, false);
    }

    // --- 確認: メモリ内ページ数は MAX_CACHED_PAGES = 50 に収まっているはず ---
    const afterEditState = usePecoStore.getState();
    const memoryPageCount = afterEditState.document!.pages.size;
    console.log(`[A3] memory pages after 128 edits: ${memoryPageCount}`);
    expect(memoryPageCount).toBeLessThanOrEqual(50);

    // --- IDB に退避されたぶんの件数 = 128 - memoryPageCount ---
    console.log(`[A3] fakeIdb entries: ${fakeIdb.size}`);
    expect(fakeIdb.size).toBeGreaterThanOrEqual(totalPages - 50);

    // --- save 経路の再現 (useFileOperations._executeSave の中身と等価) ---
    //   IDB 側を全回収 → メモリと merge → dirty フィルタ → savePDF
    const { getAllTemporaryPageData } = await import('../../utils/pdfTemporaryStorage');
    const tempPages = await getAllTemporaryPageData(REAL_PDF_PATH);
    console.log(`[A3] getAllTemporaryPageData returned: ${tempPages.size} pages`);

    const merged = new Map<number, PageData>(afterEditState.document!.pages);
    for (const [idx, data] of tempPages.entries()) {
      const existing = merged.get(idx);
      merged.set(
        idx,
        existing
          ? ({ ...existing, ...(data as Partial<PageData>) } as PageData)
          : (data as PageData),
      );
    }
    const dirtyOnly = new Map<number, PageData>(
      [...merged.entries()].filter(([, p]) => p.isDirty),
    );
    console.log(`[A3] merged total=${merged.size}, dirtyOnly=${dirtyOnly.size}`);
    expect(dirtyOnly.size).toBe(totalPages); // 128 ページ全てが dirty

    const docForSave: PecoDocument = { ...initialDoc, pages: dirtyOnly };

    // --- フォント ---
    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    // --- save ---
    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      docForSave,
      fontArrayBuffer,
    );
    console.log(
      `[A3] savePDF: ${Date.now() - tSave}ms, output ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );

    // --- 検証: bboxMeta に全 128 ページぶんの PAGE_{i}_MARKER が載っているか ---
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc) as Record<string, Array<{ text: string }>> | null;
    expect(meta).not.toBeNull();
    expect(Object.keys(meta!).length).toBe(totalPages);

    const missing: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      const entries = meta![String(i)];
      if (!entries || entries.length !== 1 || entries[0].text !== `PAGE_${i}_MARKER`) {
        missing.push(i);
      }
    }
    console.log(`[A3] pages with missing/mismatched marker: ${missing.length}`);
    if (missing.length > 0) {
      console.log(`[A3] missing pages example: ${missing.slice(0, 10).join(', ')}`);
    }
    expect(missing).toEqual([]);
  }, 900_000);
});
