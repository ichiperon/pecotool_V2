/**
 * C1: 保存中に別ページ編集 → resetDirty race の再現テスト。
 *
 * 背景:
 *   useFileOperations.handleSave は以下の順序で動く:
 *     1. dirtyOnlyPages スナップショット (dirty なページだけコピー)
 *     2. savePDF (長い、数秒〜)
 *     3. writeFileChunked (長い、数秒〜)
 *     4. resetDirty(savedPageSnapshots) — save に載ったページだけ clean にする
 *
 *   ステップ 2〜3 の間 (数秒〜数十秒) にユーザーが別ページを編集すると、
 *   そのページは save スナップショットに含まれないが store 側で isDirty=true になる。
 *   ステップ 4 で「スナップショット外の新編集」の isDirty が残らないと、
 *   次の save で dirty フィルタに載らず、永久に保存されない可能性がある。
 *
 * 本テストは useFileOperations と pecoStore の両方でこの race を再現し、
 * save スナップショット後の新編集が dirty のまま残ることを確認する。
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  open: vi.fn(),
  saveDialog: vi.fn(),
  readFile: vi.fn(),
  invoke: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(),
  getAllTemporaryPageData: vi.fn(),
  clearTemporaryChanges: vi.fn(),
  clearCachedPages: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  loadPage: vi.fn(),
  loadPecoToolBBoxMeta: vi.fn(),
  savePDF: vi.fn(),
  loadFontLazy: vi.fn(),
  loadFallbackFontsLazy: vi.fn(),
  loadBundledIpAmjFontLazy: vi.fn(),
  disableSystemFontForSession: vi.fn(),
  getPrimaryFontKind: vi.fn(),
}));

vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(async () => {}),
  getTemporaryPageData: vi.fn(async () => null),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  clearTemporaryChanges: vi.fn(async () => {}),
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: mocks.ask,
  open: mocks.open,
  save: mocks.saveDialog,
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: mocks.readFile,
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn(),
  saveTemporaryPageDataBatch: mocks.saveTemporaryPageDataBatch,
  getAllTemporaryPageData: mocks.getAllTemporaryPageData,
  clearTemporaryChanges: mocks.clearTemporaryChanges,
  clearCachedPages: mocks.clearCachedPages,
  getSharedPdfProxy: mocks.getSharedPdfProxy,
  loadPage: mocks.loadPage,
  loadPecoToolBBoxMeta: mocks.loadPecoToolBBoxMeta,
  destroySharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
}));
vi.mock('../../utils/pdfSaver', () => ({
  savePDF: mocks.savePDF,
}));
vi.mock('../../hooks/useFontLoader', () => ({
  loadFontLazy: mocks.loadFontLazy,
  loadFallbackFontsLazy: mocks.loadFallbackFontsLazy,
  loadBundledIpAmjFontLazy: mocks.loadBundledIpAmjFontLazy,
  disableSystemFontForSession: mocks.disableSystemFontForSession,
  getPrimaryFontKind: mocks.getPrimaryFontKind,
}));
vi.mock('../../utils/perfLogger', () => ({ perf: { mark: vi.fn() } }));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import { usePecoStore } from '../../store/pecoStore';
import { useFileOperations } from '../../hooks/useFileOperations';
import type { PecoDocument, TextBlock } from '../../types';

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: overrides.id ?? `b-${Math.random().toString(16).slice(2)}`,
    text: 'T',
    originalText: 'T',
    bbox: { x: 0, y: 0, width: 50, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  vi.clearAllMocks();
  mocks.ask.mockResolvedValue(true);
  mocks.open.mockResolvedValue('/a.pdf');
  mocks.saveDialog.mockResolvedValue('/a-copy.pdf');
  mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.invoke.mockResolvedValue(undefined);
  mocks.saveTemporaryPageDataBatch.mockResolvedValue(undefined);
  mocks.getAllTemporaryPageData.mockResolvedValue(new Map());
  mocks.clearTemporaryChanges.mockResolvedValue(undefined);
  mocks.clearCachedPages.mockResolvedValue(undefined);
  mocks.getSharedPdfProxy.mockResolvedValue(null);
  mocks.loadPage.mockResolvedValue(null);
  mocks.loadPecoToolBBoxMeta.mockResolvedValue(null);
  mocks.savePDF.mockResolvedValue(new Uint8Array([4, 5, 6]));
  mocks.loadFontLazy.mockResolvedValue(new ArrayBuffer(8));
  mocks.loadFallbackFontsLazy.mockResolvedValue([]);
  mocks.loadBundledIpAmjFontLazy.mockResolvedValue(new ArrayBuffer(8));
  mocks.getPrimaryFontKind.mockReturnValue('bundled');
  usePecoStore.setState({
    document: null,
    originalBytes: null,
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

describe('C1: save-during-edit race (resetDirty が新編集を巻き込まない)', () => {
  it('handleSave 中に別ページ編集 → 1回目スナップショット外の dirty は残る', async () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0' })], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1-a', text: 'P1' })], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
    } as any);
    const pendingSave = deferred<Uint8Array>();
    mocks.savePDF.mockImplementationOnce(() => pendingSave.promise);
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const savePromise = result.current.handleSave();
    await waitFor(() => expect(mocks.savePDF).toHaveBeenCalledTimes(1));

    const savedDoc = mocks.savePDF.mock.calls[0][1] as PecoDocument;
    expect([...savedDoc.pages.keys()]).toEqual([0]);

    usePecoStore.getState().updatePageData(1, {
      textBlocks: [makeBlock({ id: 'p1-a', text: 'P1_EDITED_DURING_SAVE' })],
      isDirty: true,
    });
    pendingSave.resolve(new Uint8Array([4, 5, 6]));

    await savePromise;

    const pages = usePecoStore.getState().document!.pages;
    expect(pages.get(0)!.isDirty).toBe(false);
    expect(pages.get(1)!.textBlocks[0].text).toBe('P1_EDITED_DURING_SAVE');
    expect(pages.get(1)!.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
    expect(mocks.clearCachedPages).toHaveBeenCalledWith('/a.pdf');
  });

  it('handleSave 中に同じページを再編集 → save スナップショットは旧値、live page は新編集 dirty のまま残る', async () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0_SAVE_START' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
    } as any);

    const pendingSave = deferred<Uint8Array>();
    mocks.savePDF.mockImplementationOnce(() => pendingSave.promise);
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const savePromise = result.current.handleSave();
    await waitFor(() => expect(mocks.savePDF).toHaveBeenCalledTimes(1));

    const savedDoc = mocks.savePDF.mock.calls[0][1] as PecoDocument;
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('P0_SAVE_START');
    expect(savedDoc.pages.get(0)!.isDirty).toBe(true);

    usePecoStore.getState().updatePageData(0, {
      textBlocks: [makeBlock({ id: 'p0-a', text: 'P0_EDITED_DURING_SAVE' })],
      isDirty: true,
    });
    pendingSave.resolve(new Uint8Array([4, 5, 6]));

    await savePromise;

    const livePage = usePecoStore.getState().document!.pages.get(0)!;
    expect(livePage.textBlocks[0].text).toBe('P0_EDITED_DURING_SAVE');
    expect(livePage.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  it('save 中に別ページ編集 → スナップショット外の dirty フラグは残る', () => {
    // 初期: page 0 は dirty、page 1 は clean
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0' })], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1-a', text: 'P1' })], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // --- save スナップショット相当 (useFileOperations の dirtyOnlyPages と同等) ---
    const snapshotDirty = new Map(
      [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
    );
    expect([...snapshotDirty.keys()]).toEqual([0]); // save に載るのは page 0 のみ

    // --- ここから save 実行中 (savePDF + writeFile で数秒掛かる想定) ---
    //   ユーザーが「保存押したあと」別ページ (page 1) を編集
    usePecoStore.getState().updatePageData(1, {
      textBlocks: [makeBlock({ id: 'p1-a', text: 'P1_EDITED_DURING_SAVE' })],
      isDirty: true,
    });
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);

    // --- save 完了直後の resetDirty(snapshotDirty) ---
    usePecoStore.getState().resetDirty(snapshotDirty);

    // --- 検証 ---
    const p1 = usePecoStore.getState().document!.pages.get(1)!;
    // データ自体は保持されている (text は新編集の値)
    expect(p1.textBlocks[0].text).toBe('P1_EDITED_DURING_SAVE');
    // スナップショット外の新編集なので dirty のまま残る
    expect(p1.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);

    // 次回の save スナップショットに載る
    const nextSnapshot = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(nextSnapshot).toEqual([1]);
  });

  it('save 中に同じページを再編集 → スナップショット後の dirty フラグは残る', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    const snapshotDirty = new Map(
      [...usePecoStore.getState().document!.pages.entries()]
        .filter(([, p]) => p.isDirty)
    );

    usePecoStore.getState().updatePageData(0, {
      textBlocks: [makeBlock({ id: 'p0-a', text: 'P0_EDITED_DURING_SAVE' })],
      isDirty: true,
    });

    usePecoStore.getState().resetDirty(snapshotDirty);

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks[0].text).toBe('P0_EDITED_DURING_SAVE');
    expect(p0.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  it('【参考】通常の save (save 中に編集なし) では dirty フラグを wipe して正解', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'x', text: 'T' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // save 中に編集なし
    const snapshotDirty = new Map(
      [...usePecoStore.getState().document!.pages.entries()]
        .filter(([, p]) => p.isDirty)
    );
    usePecoStore.getState().resetDirty(snapshotDirty);
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.isDirty).toBe(false);
    // store 全体の isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });
});
