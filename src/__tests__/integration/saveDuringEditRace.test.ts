/**
 * C1: 保存中に別ページ編集 → resetDirty race の回帰テスト (issue #115 / #119)。
 *
 * 背景:
 *   useFileOperations.handleSave は以下の順序で動く:
 *     1. dirtyOnlyPages スナップショット (dirty なページだけコピー)
 *     2. savePDF (長い、数秒〜)
 *     3. writeFileChunked (長い、数秒〜)
 *     4. resetDirty(savedPageSnapshots) — save に載ったページだけ clean にする
 *
 *   ステップ 2〜3 の間 (数秒〜数十秒) にユーザーがページを編集すると、
 *   その編集は save スナップショットに含まれないが store 側で isDirty=true になる。
 *
 *   resetDirty は保存スナップショットに含まれたページの「PageData オブジェクト参照」
 *   の Map を受け取り、保存後も live ページが同一参照のままのページだけ isDirty を
 *   下ろす。保存中に編集されたページ (別ページでも同一ページでも) は updatePageData
 *   が新しいオブジェクトに差し替えるため参照が一致せず、その新編集の dirty フラグは
 *   維持される → 次回 save に正しく載る。
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
  clearTemporaryChangesForPages: vi.fn(),
  remapTemporaryPageEntries: vi.fn(),
  deleteTemporaryPageKeys: vi.fn(),
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
  clearTemporaryChangesForPages: vi.fn(async () => {}),
  deleteTemporaryPageKeys: vi.fn(async () => {}),
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
  clearTemporaryChangesForPages: mocks.clearTemporaryChangesForPages,
  remapTemporaryPageEntries: mocks.remapTemporaryPageEntries,
  deleteTemporaryPageKeys: mocks.deleteTemporaryPageKeys,
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
import type { PageData, PecoDocument, TextBlock } from '../../types';

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

/**
 * save スナップショット相当の Map<pageIndex, PageData> を作る。
 * useFileOperations._executeSave が savedPageSnapshots を組み立てるのと同じく、
 * **その時点の live ページオブジェクト参照** をそのまま値に入れる。
 */
function snapshotDirtyPages(): Map<number, PageData> {
  return new Map(
    [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
  );
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
  mocks.clearTemporaryChangesForPages.mockResolvedValue(undefined);
  mocks.remapTemporaryPageEntries.mockResolvedValue(undefined);
  mocks.deleteTemporaryPageKeys.mockResolvedValue(undefined);
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

describe('C1: save-during-edit race (resetDirty が新編集を巻き込まない / issue #115 / #119)', () => {
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

    // --- save スナップショット相当 (useFileOperations の savedPageSnapshots と同等) ---
    const snapshotDirty = snapshotDirtyPages();
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
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    const p1 = usePecoStore.getState().document!.pages.get(1)!;
    // 保存に載った page 0 は dirty が下りる (live 参照がスナップショットと同一)
    expect(p0.isDirty).toBe(false);
    // page 1 のデータは保持され、isDirty も **維持される** (race 修正の核心)
    expect(p1.textBlocks[0].text).toBe('P1_EDITED_DURING_SAVE');
    expect(p1.isDirty).toBe(true);
    // 未保存ページが残っているのでドキュメントレベル isDirty も true のまま
    expect(usePecoStore.getState().isDirty).toBe(true);

    // 次回の save スナップショットに page 1 が載る = 新編集が確実に保存される
    const nextSnapshot = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(nextSnapshot).toEqual([1]);
  });

  /**
   * issue #119: 保存中に「保存対象と同じページ」を再編集したケース。
   *
   * savedPageSnapshots はクリア対象を「ページ index」ではなく「PageData の
   * オブジェクト参照」で判定する。保存中に同じ page 0 を再編集すると、
   * updatePageData が page 0 を新しいオブジェクトに差し替えるため、保存後の
   * live 参照はスナップショット時の参照と一致しない。
   * → resetDirty は page 0 の isDirty を下ろさず、2 回目の編集が dirty のまま残る。
   * → 次回 save の dirty フィルタに page 0 が正しく載る。
   */
  it('save 中に同じページを再編集 → スナップショット後の dirty フラグは残る', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'EDIT_1' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // --- save スナップショット相当: dirty な page 0 を保存対象として確定 ---
    const snapshotDirty = snapshotDirtyPages();
    expect([...snapshotDirty.keys()]).toEqual([0]);

    // --- save 実行中 (savePDF + writeFile に数秒) に、同じ page 0 をユーザーが再編集 ---
    usePecoStore.getState().updatePageData(0, {
      textBlocks: [makeBlock({ id: 'p0-a', text: 'EDIT_2_DURING_SAVE' })],
      isDirty: true,
    });
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text)
      .toBe('EDIT_2_DURING_SAVE');
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(true);

    // --- save 完了直後の resetDirty(snapshotDirty) ---
    //   page 0 は再編集で参照が変わっているため、isDirty は下りない。
    usePecoStore.getState().resetDirty(snapshotDirty);

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    // テキストは 2 回目の編集値、dirty も **維持される** (issue #119 の核心)。
    expect(p0.textBlocks[0].text).toBe('EDIT_2_DURING_SAVE');
    expect(p0.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);

    // 次回 save の dirty スナップショットに page 0 が載る = 2 回目の編集が保存される。
    const nextSnapshot = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(nextSnapshot).toEqual([0]);
  });

  it('保存に載った全ページが clean になり、残 dirty が無ければ document.isDirty=false', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'x', text: 'A' })], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'y', text: 'B' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // 両ページが保存に載り、保存中の編集なし → 両方 clean になる
    usePecoStore.getState().resetDirty(snapshotDirtyPages());

    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(false);
    // 残 dirty なし → document.isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });

  it('スナップショットに含まれないページの dirty は触らない', () => {
    // page 0 dirty, page 1 dirty。スナップショットには page 0 だけ入れる。
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    const pages = usePecoStore.getState().document!.pages;
    const partialSnapshot = new Map<number, PageData>([[0, pages.get(0)!]]);
    usePecoStore.getState().resetDirty(partialSnapshot);

    // page 0 はクリア、page 1 はスナップショット外なので維持
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  it('【後方互換】resetDirty() を引数なしで呼ぶと従来通り全ページを wipe する', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // 引数なし → 全クリア (既存呼び出し元は無改修で動く)
    usePecoStore.getState().resetDirty();

    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(false);
    expect(usePecoStore.getState().isDirty).toBe(false);
  });

  it('【参考】通常の save (save 中に編集なし) では保存ページの dirty が落ちる', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'x', text: 'T' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // save 中に編集なし → 保存に載った page 0 の dirty が落ちる
    usePecoStore.getState().resetDirty(snapshotDirtyPages());
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.isDirty).toBe(false);
    // store 全体の isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });
});

// ── PCT-050: IDB クリア前の waitForPendingIdbSaves 再呼び出し ──
// (PCT-070 でクリア対象が clearTemporaryChanges → clearTemporaryChangesForPages に変更)

describe('PCT-050: _executeSave は IDB remap 直前に waitForPendingIdbSaves を再呼び出しする', () => {
  it('remapTemporaryPageEntries が enqueue される前に waitForPendingIdbSaves が 2 回呼ばれる (スナップショット前 + remap 前)', async () => {
    // pecoStore の waitForPendingIdbSaves をスパイして呼び出し順序を検証する。
    const pecoStoreModule = await import('../../store/pecoStore');
    const waitSpy = vi.spyOn(pecoStoreModule, 'waitForPendingIdbSaves').mockResolvedValue(undefined);
    // アサーション失敗時も spy を確実に戻す (漏れると後続テストの待機が無効化される)
    try {
      const doc: PecoDocument = {
        filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
        pages: new Map([
          [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0', text: 'T' })], isDirty: true, thumbnail: null }],
        ]),
      };
      usePecoStore.setState({
        document: doc,
        originalBytes: new Uint8Array([1, 2, 3]),
        currentPageIndex: 0,
        isDirty: true,
      } as any);

      const showToast = vi.fn();
      const { result } = renderHook(() => useFileOperations(showToast));

      const saved = await result.current.handleSave();
      expect(saved).toBe(true);

      // waitForPendingIdbSaves は _executeSave 内で 2 回呼ばれる:
      //   1. waitIdbSaves ステップ (getAllTemporaryPageData の前)
      //   2. waitIdbSavesBeforeClear ステップ (PCT-050: IDB remap の直前)
      const callCount = waitSpy.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(2);

      // PCT-104 remap: remapTemporaryPageEntries は waitForPendingIdbSaves の後に enqueue される
      const waitOrder = waitSpy.mock.invocationCallOrder;
      const remapOrder = (mocks.remapTemporaryPageEntries as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      // remap が呼ばれた時点では少なくとも 2 回の wait が完了している
      expect(waitOrder[waitOrder.length - 1]).toBeLessThan(remapOrder[0]);
    } finally {
      waitSpy.mockRestore();
    }
  });
});

// ── PCT-068: 保存マージはメモリ優先 (HUNT-C1) ──────────────────────

describe('PCT-068: 保存マージはメモリ在ページを IDB エントリで上書きしない', () => {
  /**
   * HUNT-C1 のシナリオ:
   *   LRU 退避 → ページ再訪で復元 (loadPage は IDB エントリを消さない) → 再編集 → Ctrl+S。
   *   旧実装のマージ ({ ...existing, ...idbData }) は古い IDB エントリが
   *   メモリ上の新編集を上書きし、編集前の内容が PDF に書かれていた。
   */
  it('復元後の再編集が IDB の古いエントリに巻き戻されない (メモリ優先)', async () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'NEW_EDIT_AFTER_RESTORE' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
    } as any);
    // IDB には復元元の古いエントリが残っている (loadPage は削除しない)
    // PCT-104 (A-lite 段階2): getAllTemporaryPageData は Map<pageId, ...> を返す
    mocks.getAllTemporaryPageData.mockResolvedValue(new Map([
      ['src:0', { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'STALE_FROM_IDB' })], isDirty: true, thumbnail: null }],
    ]));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    const saved = await result.current.handleSave();
    expect(saved).toBe(true);

    // 保存に乗る textBlocks はメモリ側 (新編集)
    const savedDoc = mocks.savePDF.mock.calls[0][1] as PecoDocument;
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('NEW_EDIT_AFTER_RESTORE');
  });

  it('メモリに無い LRU 退避ページは従来通り IDB から回収される', async () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0_CLEAN' })], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
    } as any);
    // page 1 はメモリに無い (LRU 退避済み)
    // PCT-104 (A-lite 段階2): getAllTemporaryPageData は Map<pageId, ...> を返す
    mocks.getAllTemporaryPageData.mockResolvedValue(new Map([
      ['src:1', { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1-a', text: 'EVICTED_PAGE1' })], isDirty: true, thumbnail: null }],
    ]));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    const saved = await result.current.handleSave();
    expect(saved).toBe(true);

    const savedDoc = mocks.savePDF.mock.calls[0][1] as PecoDocument;
    expect([...savedDoc.pages.keys()]).toEqual([1]);
    expect(savedDoc.pages.get(1)!.textBlocks[0].text).toBe('EVICTED_PAGE1');
  });
});

// ── PCT-069: undo が IDB キー rename を巻き戻す (HUNT-C2) ─────────────

describe('PCT-069: ページ移動 → undo → 保存で旧 index に他ページ内容が混入しない', () => {
  /**
   * PCT-104 (A-lite 段階3): pageId ベースのステートフルな fake IDB を mocks に装着する。
   * rename は pageId 不変により完全に不要。
   */
  function installStatefulIdbMocks(fakeIdb: Map<string, Record<string, unknown>>) {
    mocks.saveTemporaryPageDataBatch.mockImplementation(
      async (entries: Array<{ filePath: string; pageId: string; data: Record<string, unknown> }>) => {
        for (const { filePath, pageId, data } of entries) {
          const { thumbnail: _t, ...clean } = data;
          fakeIdb.set(`${filePath}:${pageId}`, clean);
        }
      });
    mocks.getAllTemporaryPageData.mockImplementation(async (filePath: string) => {
      // PCT-104: 新キー形式 (filePath:src:N) のエントリを pageId (src:N) にマップして返す
      const out = new Map<string, unknown>();
      const prefix = `${filePath}:`;
      for (const [k, v] of fakeIdb) {
        if (!k.startsWith(prefix)) continue;
        const suffix = k.slice(prefix.length);
        if (suffix.startsWith('src:')) {
          out.set(suffix, v);
        } else {
          const n = parseInt(suffix, 10);
          if (Number.isFinite(n)) out.set(`src:${n}`, v);
        }
      }
      return out;
    });
    mocks.deleteTemporaryPageKeys.mockImplementation(async (filePath: string, pageIds: string[]) => {
      for (const pageId of pageIds) {
        fakeIdb.delete(`${filePath}:${pageId}`);
      }
    });
    mocks.clearTemporaryChangesForPages.mockImplementation(async (filePath: string, pageIds: string[]) => {
      for (const pageId of pageIds) {
        fakeIdb.delete(`${filePath}:${pageId}`);
      }
    });
  }

  it('編集 (write-through) → ページ移動 → undo → 保存マージが各ページ正しい内容になる', async () => {
    const { waitForPendingIdbSaves } = await import('../../store/pecoStore');
    const fakeIdb = new Map<string, Record<string, unknown>>();
    installStatefulIdbMocks(fakeIdb);

    // page 0 は LRU 退避済み (メモリに無い・IDB のみ)。page 1, 2 はメモリ在。
    const p1 = { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1-a', text: 'P1_CLEAN' })], isDirty: false, thumbnail: null };
    const p2 = { pageIndex: 2, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p2-a', text: 'P2_ORIG' })], isDirty: false, thumbnail: null };
    const doc: PecoDocument = {
      filePath: '/c2.pdf', fileName: 'c2.pdf', totalPages: 3, metadata: {},
      pages: new Map([[1, p1], [2, p2]]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 1,
      isDirty: true,
      undoStack: [],
      redoStack: [],
    } as any);
    // PCT-104 (A-lite 段階2): pageId 形式 (src:N) でデータを設定
    fakeIdb.set('/c2.pdf:src:0', {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [makeBlock({ id: 'p0-a', text: 'P0_EVICTED' })], isDirty: true,
    });

    // 編集 → undo → redo で IDB write-through を発生させる
    // 段階2: saveTemporaryPageDataBatch は pageId キー (src:2) で書き込む
    usePecoStore.getState().updatePageData(2, {
      textBlocks: [makeBlock({ id: 'p2-a', text: 'P2_EDITED' })], isDirty: true,
    });
    usePecoStore.getState().undo();
    usePecoStore.getState().redo();
    await waitForPendingIdbSaves();
    // pageId キーで確認: pageOrder=[0,1,2] での displayIndex 2 → src:2
    expect((fakeIdb.get('/c2.pdf:src:2') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P2_EDITED');

    // ページ移動 (display 2 → 0)。
    // 段階3: pageId が不変なため rename は不要。src:2 は移動後も安定したまま。
    await usePecoStore.getState().movePage(2, 0);
    await waitForPendingIdbSaves();
    // pageId (src:2) は移動後も不変 → src:2 = P2_EDITED が維持される
    expect((fakeIdb.get('/c2.pdf:src:2') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P2_EDITED');

    // undo → scheduleStructuralUndoRedoIdbSync で contentEntries を beforePages (beforeOrder) で書き込む
    usePecoStore.getState().undo();
    await waitForPendingIdbSaves();
    // src:0 は P0_EVICTED のまま (undo 後に beforePages から上書きされる)
    expect((fakeIdb.get('/c2.pdf:src:0') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P0_EVICTED');
    // src:2 は P2_EDITED のまま (pageId が安定しているため混入なし)
    expect((fakeIdb.get('/c2.pdf:src:2') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P2_EDITED');

    // 保存 → page 0 に他ページ (P2) の内容が混入しないこと
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    const saved = await result.current.handleSave();
    expect(saved).toBe(true);

    const savedDoc = mocks.savePDF.mock.calls[0][1] as PecoDocument;
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('P0_EVICTED');
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).not.toBe('P2_EDITED');
    expect(savedDoc.pages.get(2)!.textBlocks[0].text).toBe('P2_EDITED');
  });
});

// ── PCT-070: 保存後の IDB クリアは保存スナップショットのページに限定 ──

describe('PCT-070: 保存完了後のクリアは保存で回収したページのみ', () => {
  it('PCT-104 remap: 保存完了後に remapTemporaryPageEntries が呼ばれ、全削除 clearTemporaryChanges は呼ばれない', async () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0', text: 'DIRTY' })], isDirty: true, thumbnail: null, pageId: 'src:0' }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1', text: 'CLEAN' })], isDirty: false, thumbnail: null, pageId: 'src:1' }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
    } as any);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    const saved = await result.current.handleSave();
    expect(saved).toBe(true);

    // PCT-104 (remap): 保存後は clearTemporaryChangesForPages ではなく remapTemporaryPageEntries で旧キーを再構築
    expect(mocks.remapTemporaryPageEntries).toHaveBeenCalledWith(
      '/a.pdf',
      [0, 1],         // savePageOrder (保存時スナップショット)
      expect.any(Array), // normalizedPageOrder (normalize 後の pageOrder)
      ['src:0'],      // dirtyPageIds (dirty なページの pageId)
    );
    expect(mocks.clearTemporaryChanges).not.toHaveBeenCalled();
  });
});

// ── PCT-108: 遅延 IDB 書き込み中に並べ替えが走っても action 時点の pageId に着地する ──

describe('PCT-108: schedulePendingIdbWrite/scheduleStructuralUndoRedoIdbSync が遅延中の pageOrder 変化に影響されない', () => {
  /**
   * 背景 (P1 / 軸#2・#4):
   *   schedulePendingIdbWrite と scheduleStructuralUndoRedoIdbSync は、保存処理の
   *   長い await を跨いで .then() 内で遅延実行される。修正前はこの .then() 内で
   *   usePecoStore.getState().pageOrder を遅延参照していたため、保存中にユーザーが
   *   「ページ並べ替えを含む undo」を打つとライブ pageOrder が乖離し、書き込み先 pageId が
   *   action 時点の体系とずれて remap の掃除対象から外れる (キー競合)。
   *
   *   本テストは saveTemporaryPageDataBatch を gate で堰き止め、書き込みが in-flight の
   *   間に movePage で pageOrder を変化させる。修正により、各書き込みは action 実行時点で
   *   キャプチャした pageOrder に基づく pageId に着地する (ライブ値を読まない)。
   */
  function installGatedStatefulIdbMocks(
    fakeIdb: Map<string, Record<string, unknown>>,
    gate: { promise: Promise<void> } | null,
  ) {
    mocks.saveTemporaryPageDataBatch.mockImplementation(
      async (entries: Array<{ filePath: string; pageId: string; data: Record<string, unknown> }>) => {
        if (gate) await gate.promise;
        for (const { filePath, pageId, data } of entries) {
          const { thumbnail: _t, ...clean } = data;
          fakeIdb.set(`${filePath}:${pageId}`, clean);
        }
      });
    mocks.deleteTemporaryPageKeys.mockImplementation(async (filePath: string, pageIds: string[]) => {
      for (const pageId of pageIds) fakeIdb.delete(`${filePath}:${pageId}`);
    });
    mocks.getAllTemporaryPageData.mockResolvedValue(new Map());
  }

  it('update_pages の undo 書き込み中に movePage が走っても、書き込みは action 時点の pageId (src:2) に着地する', async () => {
    const { waitForPendingIdbSaves } = await import('../../store/pecoStore');
    const fakeIdb = new Map<string, Record<string, unknown>>();
    const gate = deferred<void>();
    installGatedStatefulIdbMocks(fakeIdb, gate);

    // pageOrder = [0,1,2] (identity)。displayIndex 2 → src:2。
    const p0 = { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'P0' })], isDirty: false, thumbnail: null };
    const p1 = { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1-a', text: 'P1' })], isDirty: false, thumbnail: null };
    const p2 = { pageIndex: 2, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p2-a', text: 'P2_AFTER' })], isDirty: true, thumbnail: null };
    const doc: PecoDocument = {
      filePath: '/c108.pdf', fileName: 'c108.pdf', totalPages: 3, metadata: {},
      pages: new Map([[0, p0], [1, p1], [2, p2]]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1, 2],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 2,
      isDirty: true,
      // update_pages action: undo すると page 2 を before に戻し IDB へ書き込む
      undoStack: [{
        type: 'update_pages' as const,
        entries: [{
          pageIndex: 2,
          before: { ...p2, textBlocks: [makeBlock({ id: 'p2-a', text: 'P2_BEFORE' })] },
          after: p2,
        }],
      }],
      redoStack: [],
    } as any);

    // undo を発火 → schedulePendingIdbWrite([... pageIndex:2 ...], pageOrderAtAction=[0,1,2])。
    // saveTemporaryPageDataBatch は gate で堰き止められ、書き込みは in-flight のまま。
    usePecoStore.getState().undo();

    // 書き込みが in-flight の間に並べ替えを実行 → ライブ pageOrder が [1,2,0] に変化。
    // ライブ参照だった場合、displayIndex 2 は src:0 に解決され誤ったキーへ着地する。
    // onIdbWork を渡して movePage 内の waitForPendingIdbSaves() による待機をスキップする
    // (gate で堰き止めた in-flight 書き込みを待つとデッドロックするため)。
    await usePecoStore.getState().movePage(0, 2, () => {});
    expect(usePecoStore.getState().pageOrder).toEqual([1, 2, 0]);

    // gate を解放して in-flight 書き込みを完了させる。
    gate.resolve();
    await waitForPendingIdbSaves();

    // 修正後: action 時点の pageOrder=[0,1,2] でキャプチャ済みのため src:2 に着地する。
    expect(fakeIdb.has('/c108.pdf:src:2')).toBe(true);
    expect((fakeIdb.get('/c108.pdf:src:2') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P2_BEFORE');
    // ライブ参照だった場合に着地していたであろう src:0 は汚染されていない。
    expect(fakeIdb.has('/c108.pdf:src:0')).toBe(false);
  });

  it('delete_pages の undo 構造同期中に並べ替えが走っても contentEntries は beforeOrder の pageId に着地する', async () => {
    const { waitForPendingIdbSaves } = await import('../../store/pecoStore');
    const fakeIdb = new Map<string, Record<string, unknown>>();
    const gate = deferred<void>();
    installGatedStatefulIdbMocks(fakeIdb, gate);

    // 現状 pageOrder=[0,2] (page 1 が削除済み)。undo で beforeOrder=[0,1,2] に復元される。
    const beforePages = new Map<number, PageData>([
      [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0', text: 'P0_RESTORED' })], isDirty: true, thumbnail: null }],
      [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p1', text: 'P1_RESTORED' })], isDirty: true, thumbnail: null }],
      [2, { pageIndex: 2, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p2', text: 'P2_RESTORED' })], isDirty: true, thumbnail: null }],
    ]);
    const doc: PecoDocument = {
      filePath: '/c108b.pdf', fileName: 'c108b.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0', text: 'P0' })], isDirty: false, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p2', text: 'P2' })], isDirty: false, thumbnail: null }],
      ]),
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 2],
      originalBytes: new Uint8Array([1, 2, 3]),
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [{
        type: 'delete_pages' as const,
        beforePages,
        beforeOrder: [0, 1, 2],
        beforeTotalPages: 3,
        beforeCurrentPageIndex: 0,
        afterPages: doc.pages,
        afterOrder: [0, 2],
        afterTotalPages: 2,
        afterCurrentPageIndex: 0,
        deletedPageIndices: [1],
      }],
      redoStack: [],
    } as any);

    // undo を発火 → set() で pageOrder=[0,1,2] に確定し、構造同期が
    // contentPageOrder=[0,1,2] をキャプチャして in-flight に入る (gate で堰き止め)。
    usePecoStore.getState().undo();
    expect(usePecoStore.getState().pageOrder).toEqual([0, 1, 2]);

    // in-flight 中に並べ替え → ライブ pageOrder を [2,0,1] に変化させる。
    // (onIdbWork で in-flight 待機をスキップし、デッドロックを避ける)
    await usePecoStore.getState().movePage(2, 0, () => {});
    expect(usePecoStore.getState().pageOrder).toEqual([2, 0, 1]);

    gate.resolve();
    await waitForPendingIdbSaves();

    // beforeOrder=[0,1,2] のキャプチャ値で書かれるため、displayIndex 0/1/2 → src:0/1/2 に正しく着地。
    expect((fakeIdb.get('/c108b.pdf:src:0') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P0_RESTORED');
    expect((fakeIdb.get('/c108b.pdf:src:1') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P1_RESTORED');
    expect((fakeIdb.get('/c108b.pdf:src:2') as { textBlocks: TextBlock[] }).textBlocks[0].text).toBe('P2_RESTORED');
  });
});
