/**
 * C1: 保存中に別ページ編集 → resetDirty race の回帰テスト (issue #115)。
 *
 * 背景:
 *   useFileOperations.handleSave は以下の順序で動く:
 *     1. dirtyOnlyPages スナップショット (dirty なページだけコピー)
 *     2. savePDF (長い、数秒〜)
 *     3. writeFileChunked (長い、数秒〜)
 *     4. resetDirty(savedPageIndices) — **保存に載ったページの isDirty だけ false に**
 *
 *   ステップ 2〜3 の間 (数秒〜数十秒) にユーザーが別ページを編集すると、
 *   そのページは save スナップショットに含まれないが store 側で isDirty=true になる。
 *
 *   【修正前 (バグ)】 ステップ 4 の resetDirty が引数なしで全ページの isDirty を
 *   一律クリアし、「スナップショット外の新編集」の isDirty も巻き込んで消していた。
 *   → 次の save の dirty フィルタに載らず、編集が永久に保存されない。
 *
 *   【修正後 (issue #115)】 resetDirty は保存スナップショットに含まれたページ index
 *   の Set を受け取り、それらのページだけ isDirty を下ろす。保存中に編集された
 *   別ページの isDirty は維持され、次回 save に正しく載る。
 *
 * 本テストは pecoStore 単体でこの race を再現し、scoped resetDirty が新編集を
 * 巻き込まないこと、後方互換 (引数なし = 全クリア) も維持されることを確認する。
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

describe('C1: save-during-edit race (scoped resetDirty で新編集を巻き込まない / issue #115)', () => {
  it('save 中に別ページ編集 → resetDirty(savedPageIndices) は新編集の dirty を維持する', () => {
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
    // _executeSave は dirtyOnlyPages の key 集合を savedPageIndices として返す。
    const snapshotDirty = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(snapshotDirty).toEqual([0]); // save に載るのは page 0 のみ
    const savedPageIndices = new Set(snapshotDirty);

    // --- ここから save 実行中 (savePDF + writeFile で数秒掛かる想定) ---
    //   ユーザーが「保存押したあと」別ページ (page 1) を編集
    usePecoStore.getState().updatePageData(1, {
      textBlocks: [makeBlock({ id: 'p1-a', text: 'P1_EDITED_DURING_SAVE' })],
      isDirty: true,
    });
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);

    // --- save 完了直後の resetDirty(savedPageIndices) ---
    //   修正後: 保存に載った page 0 だけ dirty を下ろす。
    usePecoStore.getState().resetDirty(savedPageIndices);

    // --- 検証 ---
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    const p1 = usePecoStore.getState().document!.pages.get(1)!;
    // 保存に載った page 0 は dirty が下りる
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

  it('保存に載った全ページが scoped クリアされ、残 dirty が無ければ document.isDirty=false', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'x', text: 'A' })], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock({ id: 'y', text: 'B' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // 両ページが保存に載った → 両方 scoped クリア
    usePecoStore.getState().resetDirty(new Set([0, 1]));

    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(false);
    // 残 dirty なし → document.isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });

  it('savedPageIndices に配列を渡しても Set と同じく scoped クリアされる', () => {
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // 配列でも受け付ける (内部で Set 正規化)
    usePecoStore.getState().resetDirty([0]);

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

    // save 中に編集なし、保存に載ったのは page 0 のみ
    usePecoStore.getState().resetDirty(new Set([0]));
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.isDirty).toBe(false);
    // store 全体の isDirty も false
    expect(usePecoStore.getState().isDirty).toBe(false);
  });

  it('保存対象外のページ index を渡しても、対象外ページの dirty は触らない', () => {
    // page 0 dirty, page 1 dirty。savedPageIndices に存在しない index (99) を混ぜる。
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 2, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [makeBlock()], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    usePecoStore.getState().resetDirty(new Set([0, 99]));

    // page 0 はクリア、page 1 は対象外なので維持、存在しない 99 は無害
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  /**
   * 【KNOWN LIMITATION】保存中に「保存対象と同じページ」を再編集したケース。
   *
   * これまでの race テストは保存中に **別ページ** を編集しており、scoped resetDirty
   * (savedPageIndices) はその別ページの dirty を巻き込まない、という核心を検証していた。
   *
   * しかし scoped resetDirty は「ページ index」でクリア対象を決めており、
   * 「そのページがスナップショット後にさらに編集されたか」までは判定しない。
   * したがって保存中に **保存対象と同じページ (page 0)** を再編集すると:
   *   1. resetDirty({0}) は page 0 を保存済みと見なして isDirty を一律 false にする
   *   2. → スナップショットに載っていない「2 回目の編集」の dirty フラグまで消える
   *   3. → 次回 save の dirty フィルタに page 0 が載らず、2 回目の編集が保存されない
   *
   * これは現状の既知の限界 (page 単位のスナップショット粒度) であり、
   * 将来 resetDirty をスナップショット時の textBlocks 参照と比較する等で修正したら、
   * 下の expect を「2 回目の編集 dirty が維持される」方向へ反転させること。
   */
  it('【KNOWN LIMITATION】保存中に保存対象と同じ page 0 を再編集すると 2回目の編集 dirty が失われる', () => {
    // 初期: page 0 のみ存在し dirty。
    const doc: PecoDocument = {
      filePath: '/a.pdf', fileName: 'a.pdf', totalPages: 1, metadata: {},
      pages: new Map([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [makeBlock({ id: 'p0-a', text: 'EDIT_1' })], isDirty: true, thumbnail: null }],
      ]),
    };
    usePecoStore.getState().setDocument(doc);

    // --- save スナップショット相当: dirty な page 0 を保存対象として確定 ---
    const snapshotDirty = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(snapshotDirty).toEqual([0]);
    const savedPageIndices = new Set(snapshotDirty);

    // --- save 実行中 (savePDF + writeFile に数秒) に、同じ page 0 をユーザーが再編集 ---
    usePecoStore.getState().updatePageData(0, {
      textBlocks: [makeBlock({ id: 'p0-a', text: 'EDIT_2_DURING_SAVE' })],
      isDirty: true,
    });
    // 再編集後、page 0 のテキストは 2 回目の編集値、isDirty は true。
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text)
      .toBe('EDIT_2_DURING_SAVE');
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(true);

    // --- save 完了直後の resetDirty(savedPageIndices) ---
    //   scoped resetDirty は page 0 を「保存済み」と見なし isDirty を一律クリアする。
    usePecoStore.getState().resetDirty(savedPageIndices);

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    // テキスト自体は 2 回目の編集値が store に残る (updatePageData は textBlocks を書き換えるため)。
    expect(p0.textBlocks[0].text).toBe('EDIT_2_DURING_SAVE');

    // 【現状の挙動 = KNOWN LIMITATION】
    //   page index ベースの scoped クリアにより、2 回目の編集の dirty フラグまで消える。
    //   将来スナップショット粒度を上げて修正したら、この 2 つの expect を
    //   `toBe(true)` に反転させること。
    expect(p0.isDirty).toBe(false);
    expect(usePecoStore.getState().isDirty).toBe(false);

    // その帰結: 次回 save の dirty スナップショットに page 0 が載らず、
    //   2 回目の編集 (EDIT_2_DURING_SAVE) は保存対象から漏れる。
    const nextSnapshot = [...usePecoStore.getState().document!.pages.entries()]
      .filter(([, p]) => p.isDirty)
      .map(([idx]) => idx);
    expect(nextSnapshot).toEqual([]); // ← 修正後は [0] になるべき
  });
});
