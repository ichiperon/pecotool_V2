/**
 * Copy/Paste 経路の実データ検証。
 *
 * 検証:
 *   1. copySelected → pasteClipboard で新ブロックが +10/+10 オフセットで追加される
 *   2. paste 後の save/reload で新ブロックの text と bbox が正しく保存・復元
 *   3. paste 後の selectedIds は新 ID セットに置き換わる
 *   4. 別ページに移動しても clipboard は保持される (ただし paste 先は current page)
 *   5. setDocument で clipboard がリセットされる
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFString,
  type PDFDict,
} from '@cantoo/pdf-lib';

const fakeIdb = new Map<string, unknown>();
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(
    async (entries: Array<{ filePath: string; pageIndex: number; data: any }>) => {
      for (const { filePath, pageIndex, data } of entries) {
        const key = `${filePath}:${pageIndex}`;
        const { thumbnail: _t, ...clean } = data;
        fakeIdb.set(key, clean);
      }
    },
  ),
  getTemporaryPageData: vi.fn(async () => null),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  clearTemporaryChanges: vi.fn(async () => {}),
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(),
}));
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

function readBBoxMeta(doc: PDFDocument): Record<string, Array<{ text: string; bbox: any; order: number }>> | null {
  const infoDict = (doc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  if (!infoDict) return null;
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try { return JSON.parse(safeDecodePdfText(v)); } catch { return null; }
  }
  return null;
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: overrides.id ?? `b-${Math.random().toString(16).slice(2)}`,
    text: 'T',
    originalText: 'T',
    bbox: { x: 50, y: 50, width: 60, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

beforeAll(() => {
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
  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
    clipboard: [],
  } as any);
});

describe.skipIf(!hasRealPdf)('Copy/Paste × save roundtrip (実 PDF)', () => {
  it('copy → paste で +10/+10 オフセットの新ブロックが追加され、save/reload で保持', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const b0 = makeBlock({ id: 'src-a', text: 'ALPHA', order: 0, bbox: { x: 50, y: 50, width: 60, height: 20 } });
    const b1 = makeBlock({ id: 'src-b', text: 'BETA', order: 1, bbox: { x: 200, y: 200, width: 80, height: 20 } });
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH, fileName: 'x.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [b0, b1], isDirty: false, thumbnail: null }]]),
    };
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0, selectedIds: new Set(['src-a', 'src-b']) } as any);

    usePecoStore.getState().copySelected();
    expect(usePecoStore.getState().clipboard).toHaveLength(2);

    usePecoStore.getState().pasteClipboard();
    const pasted = usePecoStore.getState().document!.pages.get(0)!.textBlocks;
    expect(pasted).toHaveLength(4);

    // 新ブロック (末尾 2 件) の bbox がオフセットされている
    const newA = pasted[2];
    const newB = pasted[3];
    expect(newA.bbox.x).toBe(60); // 50 + 10
    expect(newA.bbox.y).toBe(60);
    expect(newA.text).toBe('ALPHA');
    expect(newA.id).not.toBe('src-a'); // 新 UUID 発行
    expect(newB.bbox.x).toBe(210);
    expect(newB.bbox.y).toBe(210);
    expect(newB.text).toBe('BETA');

    // selectedIds が新 ID 群に置き換わっている
    const sel = usePecoStore.getState().selectedIds;
    expect(sel.has(newA.id)).toBe(true);
    expect(sel.has(newB.id)).toBe(true);
    expect(sel.has('src-a')).toBe(false);

    // save & reload で 4 ブロック全部が復元される
    const fontBuf = readFileSync(FONT_PATH);
    const fontAB = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontAB).set(fontBuf);
    const saved = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      usePecoStore.getState().document!,
      fontAB,
    );
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc);
    expect(meta).not.toBeNull();
    const entries = meta!['0'];
    expect(entries).toHaveLength(4);
    expect(entries.map(e => e.text)).toEqual(['ALPHA', 'BETA', 'ALPHA', 'BETA']);
    expect(entries[2].bbox.x).toBe(60);
    expect(entries[3].bbox.x).toBe(210);
  }, 120_000);

  it('paste 先は currentPageIndex の現ページ限定 (ページ跨ぎ不可、clipboard は保持)', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const b0 = makeBlock({ id: 'a', text: 'COPIED', order: 0 });
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH, fileName: 'x.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [b0], isDirty: false, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0, selectedIds: new Set(['a']) } as any);
    usePecoStore.getState().copySelected();

    // page 1 に移動
    usePecoStore.setState({ currentPageIndex: 1 } as any);
    expect(usePecoStore.getState().clipboard).toHaveLength(1); // clipboard は保持

    usePecoStore.getState().pasteClipboard();
    // page 0 は 変化なし、 page 1 に新規 1 件
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(1);
    const page1 = usePecoStore.getState().document!.pages.get(1)!.textBlocks;
    expect(page1).toHaveLength(1);
    expect(page1[0].text).toBe('COPIED');
    expect(page1[0].bbox.x).toBe(b0.bbox.x + 10);

    // save → reload で両ページの状態が保存されている
    const fontBuf = readFileSync(FONT_PATH);
    const fontAB = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontAB).set(fontBuf);
    const saved = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      usePecoStore.getState().document!,
      fontAB,
    );
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc);
    expect(meta).not.toBeNull();
    // page 0 は dirty=false なので meta に載らない (dirty only フィルタ)
    // → テストの doc では page 0 の isDirty は false のまま。
    //   page 1 だけが dirty=true で保存対象。
    expect(meta!['1']).toHaveLength(1);
    expect(meta!['1'][0].text).toBe('COPIED');
  }, 120_000);

  it('setDocument で clipboard がリセットされる', async () => {
    const b0 = makeBlock({ id: 'a', text: 'T1' });
    const doc1: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [b0], isDirty: false, thumbnail: null }]]),
    };
    usePecoStore.getState().setDocument(doc1);
    usePecoStore.setState({ currentPageIndex: 0, selectedIds: new Set(['a']) } as any);
    usePecoStore.getState().copySelected();
    expect(usePecoStore.getState().clipboard).toHaveLength(1);

    // 別 document を set → clipboard が空になる
    const doc2: PecoDocument = { ...doc1, filePath: '/b.pdf' };
    usePecoStore.getState().setDocument(doc2);
    expect(usePecoStore.getState().clipboard).toHaveLength(0);
  });
});
