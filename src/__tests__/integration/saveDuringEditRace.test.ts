/**
 * C1: 保存中に別ページ編集 → resetDirty race の再現テスト。
 *
 * 背景:
 *   useFileOperations.handleSave は以下の順序で動く:
 *     1. dirtyOnlyPages スナップショット (dirty なページだけコピー)
 *     2. savePDF (長い、数秒〜)
 *     3. writeFileChunked (長い、数秒〜)
 *     4. resetDirty() — **全ページの isDirty を一律 false に**
 *
 *   ステップ 2〜3 の間 (数秒〜数十秒) にユーザーが別ページを編集すると、
 *   そのページは save スナップショットに含まれないが store 側で isDirty=true になる。
 *   ステップ 4 の resetDirty が「スナップショット外の新編集」の isDirty も一律クリア
 *   してしまい、次の save で dirty フィルタに載らず、永久に保存されない可能性がある。
 *
 * 本テストは pecoStore 単体でこの race を再現し、
 * 現状の resetDirty が不加減に blanket clear することを確認する (= バグの証跡)。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../utils/pdfTemporaryStorage', () => ({
  saveTemporaryPageData: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(async () => {}),
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

import { usePecoStore } from '../../store/pecoStore';
import type { PecoDocument, PageData, TextBlock } from '../../types';

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

beforeAll(() => {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now()}`,
    } as unknown as Crypto;
  }
});

beforeEach(() => {
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

describe('C1: save-during-edit race (resetDirty が新編集を巻き込む)', () => {
  it('【バグ証跡】save 中に別ページ編集 → resetDirty が新編集の dirty フラグも wipe する', () => {
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
    const snapshotDirty = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(snapshotDirty).toEqual([0]); // save に載るのは page 0 のみ

    // --- ここから save 実行中 (savePDF + writeFile で数秒掛かる想定) ---
    //   ユーザーが「保存押したあと」別ページ (page 1) を編集
    usePecoStore.getState().updatePageData(1, {
      textBlocks: [makeBlock({ id: 'p1-a', text: 'P1_EDITED_DURING_SAVE' })],
      isDirty: true,
    });
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);

    // --- save 完了直後の resetDirty() ---
    usePecoStore.getState().resetDirty();

    // --- 検証 ---
    const p1 = usePecoStore.getState().document!.pages.get(1)!;
    // データ自体は保持されている (text は新編集の値)
    expect(p1.textBlocks[0].text).toBe('P1_EDITED_DURING_SAVE');
    // ただし isDirty フラグは **race により巻き込まれて false に** → バグの現れ
    expect(p1.isDirty).toBe(false);

    // 次回の save スナップショットから漏れる = ユーザーの新編集が永久に保存されない
    const nextSnapshot = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(nextSnapshot).toEqual([]);
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
    usePecoStore.getState().resetDirty();
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.isDirty).toBe(false);
    // store 全体の isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });
});
