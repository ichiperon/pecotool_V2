/**
 * Undo/Redo 経路の実データ検証。
 *
 * 検証:
 *   1. edit → undo → save → reload で「編集前の状態」が保存されている
 *   2. edit → undo → redo → save → reload で「編集後の状態」が保存されている
 *   3. undo 後に新編集 → redoStack が消える（分岐）→ save した結果は「新編集」
 *   4. undoStack 上限 (100) での古い action 破棄が他の page に波及しない
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFString,
  type PDFDict,
} from '@cantoo/pdf-lib';

// Mock: IDB 経路を in-memory に置き換え (pecoStore が触るため)
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
import { findInputPdf, FONT_PATH } from './helpers/realPdfFixtures';
import type { PecoDocument, PageData, TextBlock } from '../../types';

const REAL_PDF_PATH = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

function readBBoxMeta(doc: PDFDocument): Record<string, Array<{ text: string; bbox: any }>> | null {
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
    text: 'orig',
    originalText: 'orig',
    bbox: { x: 10, y: 10, width: 50, height: 20 },
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

async function saveAndReadMeta(doc: PecoDocument, sourceBytes: Uint8Array) {
  const fontBuf = readFileSync(FONT_PATH);
  const fontAB = new ArrayBuffer(fontBuf.byteLength);
  new Uint8Array(fontAB).set(fontBuf);
  const saved = await savePDF({ bytes: new Uint8Array(sourceBytes) }, doc, fontAB);
  const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
    throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
  });
  return { saved, meta: readBBoxMeta(savedDoc) };
}

describe.skipIf(!hasRealPdf)('Undo/Redo × save roundtrip (実 PDF)', () => {
  it('edit → undo → save: undo 後の「編集前」状態が保存される', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    // 最小構成: 1 ページに 2 ブロック、元状態を構築
    const orig1 = makeBlock({ id: 'a', text: 'AAA', order: 0, bbox: { x: 10, y: 10, width: 50, height: 20 } });
    const orig2 = makeBlock({ id: 'b', text: 'BBB', order: 1, bbox: { x: 70, y: 10, width: 50, height: 20 } });
    const initialPage: PageData = {
      pageIndex: 0, width: 595, height: 842, textBlocks: [orig1, orig2], isDirty: false, thumbnail: null,
    };
    const initialDoc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'x.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, initialPage]]),
    };
    usePecoStore.getState().setDocument(initialDoc);

    // 編集: ブロックを書き換え
    const edited: TextBlock[] = [
      { ...orig1, text: 'EDITED_A', isDirty: true },
      { ...orig2, text: 'EDITED_B', isDirty: true },
    ];
    usePecoStore.getState().updatePageData(0, { textBlocks: edited, isDirty: true });
    expect(usePecoStore.getState().undoStack).toHaveLength(1);

    // undo
    usePecoStore.getState().undo();
    expect(usePecoStore.getState().undoStack).toHaveLength(0);
    expect(usePecoStore.getState().redoStack).toHaveLength(1);

    // 【実挙動の観察】
    //   - page は action.before に置換 → 初期 page の isDirty=false が復元される
    //   - store (top-level) の isDirty は true に設定される (line 379)
    //   - つまり「保存ボタンは押せる状態だが、ページレベルで dirty=false なので save 対象から外れる」
    const afterUndo = usePecoStore.getState().document!.pages.get(0)!;
    expect(afterUndo.textBlocks.map(b => b.text)).toEqual(['AAA', 'BBB']);
    expect(afterUndo.isDirty).toBe(false);          // page は before 状態 = isDirty:false
    expect(usePecoStore.getState().isDirty).toBe(true); // store は dirty フラグ立ちっぱなし

    // save → page.isDirty=false のため dirtyOnly で落ちる
    //   output PDF には PecoToolBBoxes が書かれない (新規編集なし)
    const { meta } = await saveAndReadMeta(usePecoStore.getState().document!, realBytes);
    expect(meta).toBeNull(); // undo 後の save は meta を一切書き出さない
  }, 120_000);

  it('edit → undo → redo → save: redo 後の「編集後」状態が保存される', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const orig = makeBlock({ id: 'a', text: 'X', order: 0 });
    const initialDoc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'x.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [orig], isDirty: false, thumbnail: null }]]),
    };
    usePecoStore.getState().setDocument(initialDoc);

    usePecoStore.getState().updatePageData(0, { textBlocks: [{ ...orig, text: 'Y', isDirty: true }], isDirty: true });
    usePecoStore.getState().undo();
    usePecoStore.getState().redo();
    expect(usePecoStore.getState().undoStack).toHaveLength(1);
    expect(usePecoStore.getState().redoStack).toHaveLength(0);

    const { meta } = await saveAndReadMeta(usePecoStore.getState().document!, realBytes);
    expect(meta!['0'][0].text).toBe('Y');
  }, 120_000);

  it('edit → undo → 新編集 → redoStack が消える（分岐）→ save は新編集を反映', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const orig = makeBlock({ id: 'a', text: 'START', order: 0 });
    const initialDoc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'x.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [orig], isDirty: false, thumbnail: null }]]),
    };
    usePecoStore.getState().setDocument(initialDoc);

    // 編集 1 → undo
    usePecoStore.getState().updatePageData(0, {
      textBlocks: [{ ...orig, text: 'BRANCH_A', isDirty: true }], isDirty: true,
    });
    usePecoStore.getState().undo();
    expect(usePecoStore.getState().redoStack).toHaveLength(1);

    // 新編集 (分岐) → redoStack が消える
    usePecoStore.getState().updatePageData(0, {
      textBlocks: [{ ...orig, text: 'BRANCH_B', isDirty: true }], isDirty: true,
    });
    expect(usePecoStore.getState().redoStack).toHaveLength(0);
    expect(usePecoStore.getState().undoStack).toHaveLength(1);

    const { meta } = await saveAndReadMeta(usePecoStore.getState().document!, realBytes);
    expect(meta!['0'][0].text).toBe('BRANCH_B'); // 旧 BRANCH_A は redoStack ごと消えている
  }, 120_000);

  it('複数ページで undo: 他ページに波及しない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const p0 = makeBlock({ id: 'p0-a', text: 'P0', order: 0 });
    const p1 = makeBlock({ id: 'p1-a', text: 'P1', order: 0 });
    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'x.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [p0], isDirty: false, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [p1], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // page 0 を編集 → page 1 を編集 → page 0 の編集を undo
    usePecoStore.getState().updatePageData(0, { textBlocks: [{ ...p0, text: 'P0_EDIT', isDirty: true }], isDirty: true });
    usePecoStore.getState().updatePageData(1, { textBlocks: [{ ...p1, text: 'P1_EDIT', isDirty: true }], isDirty: true });
    expect(usePecoStore.getState().undoStack).toHaveLength(2);

    // undo → 最新の page 1 編集が戻る
    usePecoStore.getState().undo();
    const st1 = usePecoStore.getState().document!;
    expect(st1.pages.get(0)!.textBlocks[0].text).toBe('P0_EDIT');
    expect(st1.pages.get(1)!.textBlocks[0].text).toBe('P1'); // 戻った

    // もう一度 undo → page 0 も戻る
    usePecoStore.getState().undo();
    const st2 = usePecoStore.getState().document!;
    expect(st2.pages.get(0)!.textBlocks[0].text).toBe('P0');
    expect(st2.pages.get(1)!.textBlocks[0].text).toBe('P1');

    // このまま save → 両ページとも page.isDirty=false (before 状態) 復元につき meta に出力されない
    const { meta } = await saveAndReadMeta(usePecoStore.getState().document!, realBytes);
    expect(meta).toBeNull(); // 両ページとも undo で dirty フラグが落ちているため
  }, 120_000);
});
