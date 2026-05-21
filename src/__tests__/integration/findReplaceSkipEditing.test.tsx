/**
 * Find & Replace の「編集中ブロック skip」と 編集→保存ラウンドトリップの統合テスト。
 *
 * 既存テストのギャップを埋める:
 *  - C-OC-20 は OcrCard に data-block-id 属性が "存在する" ことだけを見る。
 *  - U-FR-07 は skipBlockIds を手で組み立てて replaceText に渡すだけで、
 *    「focus 中の contentEditable → App.tsx の closest('[data-block-id]') →
 *    skipBlockIds 構築 → replaceText が実際に skip する」という一連の経路は
 *    どこでも通っていない (issue #117 の本来の回帰経路)。
 *
 * 本ファイルは実 OcrCard を描画し、App.tsx の handleReplaceConfirm と同じ
 * skip 検出スニペットを使って end-to-end で:
 *   1. focus 中ブロックが skipBlockIds に入る (data-block-id 経由で解決される)
 *   2. そのブロックが replaceText の置換対象から除外される
 * を検証する。
 *
 * さらに 編集→保存 ("save-diff") ラウンドトリップを Ctrl+S(blur) 経路と
 * アンマウント経路の双方で検証し、保存スナップショットが古いテキストではなく
 * 編集後テキストを反映することを確認する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  loadPage: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
}));
vi.mock('lucide-react', () => ({
  GripVertical: () => null,
}));

import { OcrCard } from '../../components/OcrCard';
import { usePecoStore } from '../../store/pecoStore';
import type { TextBlock, PageData, PecoDocument } from '../../types';

// ── ヘルパー ──────────────────────────────────────────────────

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'block-1',
    text: 'foo',
    originalText: 'foo',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function makePage(blocks: TextBlock[], overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
    ...overrides,
  };
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: '/test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  };
}

/**
 * App.tsx handleReplaceConfirm の「編集中ブロック検出」スニペットの忠実なコピー。
 * focus 中の .ocr-card-content から closest('[data-block-id]') で対象 id を引き、
 * skipBlockIds を組み立てて編集要素を blur() する。
 * (App.tsx と同じロジックなので、ここを通せば issue #117 経路を end-to-end で検証できる)
 */
function buildSkipBlockIdsLikeApp(): Set<string> {
  const active = window.document.activeElement as HTMLElement | null;
  const editingEl =
    active && active.classList?.contains('ocr-card-content') ? active : null;
  const skipBlockIds = new Set<string>();
  if (editingEl) {
    const blockId = editingEl
      .closest('[data-block-id]')
      ?.getAttribute('data-block-id');
    if (blockId) skipBlockIds.add(blockId);
    editingEl.blur();
  }
  return skipBlockIds;
}

afterEach(() => cleanup());

beforeEach(() => {
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    lastSelectedId: null,
    undoStack: [],
    redoStack: [],
    isDirty: false,
  } as any);
});

// ── Gap 4: Find & Replace end-to-end で編集中ブロックを skip ─────────────
describe('I-FR-SKIP: Find & Replace は focus 中の編集ブロックを end-to-end で skip する (issue #117)', () => {
  it('I-FR-SKIP-01: focus 中の OcrCard が data-block-id 経由で skipBlockIds に入り、置換対象外になる', async () => {
    // page 0 に同じ text 'foo' を持つ 2 ブロック。b-edit を編集中にする。
    const editing = makeBlock({ id: 'b-edit', text: 'foo', order: 0 });
    const other = makeBlock({ id: 'b-other', text: 'foo', order: 1 });
    const page = makePage([editing, other])
    const doc = makeDoc(new Map([[0, page]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    // 実 OcrCard を 2 枚描画 (App と同じく contentEditable を持つ)。
    const { container } = render(
      <div>
        <OcrCard block={editing} pageIndex={0} />
        <OcrCard block={other} pageIndex={0} />
      </div>
    );

    // ユーザーが b-edit のカードを編集中: contentEditable に実際に focus する。
    const editingContent = container.querySelector(
      '[data-block-id="b-edit"] .ocr-card-content'
    ) as HTMLElement;
    editingContent.focus();
    expect(window.document.activeElement).toBe(editingContent);

    // App.tsx と同じ経路で skipBlockIds を組み立てる。
    const skipBlockIds = buildSkipBlockIdsLikeApp();
    // data-block-id 属性 (issue #117) が無いとここが空集合になり誤置換が起きる。
    expect(skipBlockIds.has('b-edit')).toBe(true);
    expect(skipBlockIds.size).toBe(1);

    // 実 store の replaceText を skipBlockIds 付きで実行する (current scope)。
    const result = await usePecoStore.getState().replaceText({
      scope: 'current',
      pattern: 'foo',
      replacement: 'BAR',
      caseSensitive: false,
      useRegex: false,
      skipBlockIds,
    });

    // 編集中ブロックは skip、もう一方だけ置換される。
    expect(result.hits).toBe(1);
    expect(result.skippedBlocks).toBe(1);
    const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks;
    const after = (id: string) => blocks.find(b => b.id === id)!.text;
    expect(after('b-edit')).toBe('foo'); // 編集中なので置換されない
    expect(after('b-other')).toBe('BAR'); // 通常どおり置換される
  });

  it('I-FR-SKIP-02: どのカードも編集中でない (focus なし) なら skipBlockIds は空、全件置換される', async () => {
    const b0 = makeBlock({ id: 'b0', text: 'foo', order: 0 });
    const b1 = makeBlock({ id: 'b1', text: 'foo', order: 1 });
    const doc = makeDoc(new Map([[0, makePage([b0, b1])]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    render(
      <div>
        <OcrCard block={b0} pageIndex={0} />
        <OcrCard block={b1} pageIndex={0} />
      </div>
    );

    // どこにも focus しない → activeElement は body 等。
    const skipBlockIds = buildSkipBlockIdsLikeApp();
    expect(skipBlockIds.size).toBe(0);

    const result = await usePecoStore.getState().replaceText({
      scope: 'current',
      pattern: 'foo',
      replacement: 'BAR',
      caseSensitive: false,
      useRegex: false,
      skipBlockIds,
    });

    expect(result.hits).toBe(2);
    expect(result.skippedBlocks).toBe(0);
    const blocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks;
    expect(blocks.every(b => b.text === 'BAR')).toBe(true);
  });

  it('I-FR-SKIP-03: 編集中ブロックが本来ヒット対象だった場合 skippedBlocks に件数が立つ', async () => {
    // 編集中ブロックの text もパターンにヒットする → skip しつつ警告用に件数カウント。
    const editing = makeBlock({ id: 'b-edit', text: 'foo foo', order: 0 });
    const other = makeBlock({ id: 'b-other', text: 'baz', order: 1 });
    const doc = makeDoc(new Map([[0, makePage([editing, other])]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    const { container } = render(
      <div>
        <OcrCard block={editing} pageIndex={0} />
        <OcrCard block={other} pageIndex={0} />
      </div>
    );
    const editingContent = container.querySelector(
      '[data-block-id="b-edit"] .ocr-card-content'
    ) as HTMLElement;
    editingContent.focus();

    const skipBlockIds = buildSkipBlockIdsLikeApp();
    expect(skipBlockIds.has('b-edit')).toBe(true);

    const result = await usePecoStore.getState().replaceText({
      scope: 'current',
      pattern: 'foo',
      replacement: 'X',
      caseSensitive: false,
      useRegex: false,
      skipBlockIds,
    });

    // 編集中ブロックはヒット候補だったが skip。other は 'foo' を含まないので 0 件。
    expect(result.hits).toBe(0);
    expect(result.skippedBlocks).toBe(1);
    expect(
      usePecoStore.getState().document!.pages.get(0)!.textBlocks
        .find(b => b.id === 'b-edit')!.text
    ).toBe('foo foo'); // 置換されず温存
  });
});

// ── Gap 5: 編集 → 保存 ラウンドトリップ (save-diff) ─────────────────────
describe('I-SAVE-DIFF: 編集 → 保存スナップショットは編集後テキストを反映する', () => {
  /**
   * useFileOperations._executeSave の dirtyOnlyPages スナップショットと同等。
   *  [...pages.entries()].filter(([, p]) => p.isDirty)
   * 保存に渡るのはこの dirty フィルタ後のページなので、ここに編集後テキストが
   * 載っていれば「保存される PDF が編集を反映する」ことが保証される。
   */
  function snapshotDirtyPages(): Map<number, PageData> {
    const doc = usePecoStore.getState().document!;
    return new Map(
      [...doc.pages.entries()].filter(([, p]) => p.isDirty)
    );
  }

  /**
   * useFileOperations.blurActiveEditableElement の忠実なコピー。
   * Ctrl+S 保存の最初に呼ばれ、focus 中の編集要素を blur して
   * OcrCard の blur-commit (同期 updatePageData) を store に確定させる。
   */
  function blurActiveEditableElement(): void {
    const active = window.document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const tag = active.tagName;
    const isContentEditable =
      active.isContentEditable ||
      active.getAttribute('contenteditable') === 'true' ||
      active.getAttribute('contenteditable') === '';
    if (isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA') {
      active.blur();
    }
  }

  it('I-SAVE-DIFF-01: Ctrl+S 経路 — focus 中の編集が blur-commit され、保存スナップショットに反映される', () => {
    const block = makeBlock({ id: 'block-1', text: '保存前テキスト' });
    const doc = makeDoc(new Map([[0, makePage([block])]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    const { container } = render(<OcrCard block={block} pageIndex={0} />);
    const content = container.querySelector('.ocr-card-content') as HTMLElement;

    // ユーザーが編集中: focus + 入力。まだ blur していないので store は古いまま。
    content.focus();
    content.textContent = '保存後テキスト';
    fireEvent.input(content);
    expect(
      usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text
    ).toBe('保存前テキスト'); // blur 前 = store 未反映

    // Ctrl+S 保存開始: blurActiveEditableElement() がスナップショット前に走る。
    act(() => {
      blurActiveEditableElement();
    });

    // blur-commit により store が編集後テキスト + isDirty=true になっている。
    const committed = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0];
    expect(committed.text).toBe('保存後テキスト');
    expect(committed.isDirty).toBe(true);

    // 保存スナップショット (dirtyOnlyPages 相当) に編集後テキストが載る。
    const snapshot = snapshotDirtyPages();
    expect(snapshot.has(0)).toBe(true);
    expect(snapshot.get(0)!.textBlocks[0].text).toBe('保存後テキスト');
  });

  it('I-SAVE-DIFF-02: アンマウント経路 — blur せずカードが消えても編集が保存スナップショットに反映される', () => {
    const block = makeBlock({ id: 'block-1', text: '保存前テキスト' });
    const doc = makeDoc(new Map([[0, makePage([block])]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    const { container, unmount } = render(<OcrCard block={block} pageIndex={0} />);
    const content = container.querySelector('.ocr-card-content') as HTMLElement;

    // 編集中 (focus 保持) のままカードがアンマウントされる (画面外スクロール相当)。
    content.focus();
    content.textContent = '保存後テキスト'
    fireEvent.input(content);
    act(() => {
      unmount();
    });

    // アンマウント cleanup が編集を store にコミットしている。
    const committed = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0];
    expect(committed.text).toBe('保存後テキスト');
    expect(committed.isDirty).toBe(true);

    // 保存スナップショットにも編集後テキストが反映される (古いテキストではない)。
    const snapshot = snapshotDirtyPages();
    expect(snapshot.get(0)!.textBlocks[0].text).toBe('保存後テキスト');
  });

  it('I-SAVE-DIFF-03: 編集なしで保存しても dirty でないページはスナップショットに載らない', () => {
    // 編集していないページは isDirty=false のままで保存対象外。
    const block = makeBlock({ id: 'block-1', text: '無編集' });
    const doc = makeDoc(new Map([[0, makePage([block], { isDirty: false })]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    const { container } = render(<OcrCard block={block} pageIndex={0} />);
    const content = container.querySelector('.ocr-card-content') as HTMLElement;

    // focus → blur するが textContent は変更しない (= 編集なし)。
    content.focus();
    act(() => {
      blurActiveEditableElement();
    });

    // 変化が無いので commit されず isDirty=false のまま。
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(snapshotDirtyPages().size).toBe(0);
  });

  it('I-SAVE-DIFF-04: blur-commit 後にもう一度編集 → 2回目の編集も保存スナップショットに反映される', () => {
    // 1 回目 blur → save → 2 回目編集 → 再 save、で最新編集が常に載ることを確認。
    const block = makeBlock({ id: 'block-1', text: 'v0' });
    const doc = makeDoc(new Map([[0, makePage([block])]]));
    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

    const { container } = render(<OcrCard block={block} pageIndex={0} />);
    const content = container.querySelector('.ocr-card-content') as HTMLElement;

    // 1 回目編集 → Ctrl+S 相当 blur。
    content.focus();
    content.textContent = 'v1';
    fireEvent.input(content);
    act(() => {
      blurActiveEditableElement();
    });
    expect(snapshotDirtyPages().get(0)!.textBlocks[0].text).toBe('v1');

    // 2 回目編集 → 再び Ctrl+S 相当 blur。
    content.focus();
    content.textContent = 'v2';
    fireEvent.input(content);
    act(() => {
      blurActiveEditableElement();
    });

    // 最新編集 v2 が保存スナップショットに反映される (v1 のまま固まらない)。
    expect(
      usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text
    ).toBe('v2');
    expect(snapshotDirtyPages().get(0)!.textBlocks[0].text).toBe('v2');
  });
});
