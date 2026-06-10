/**
 * Integration test: DiffPreviewModal + useFileOperations._executeSave
 * onRequestDiffPreview コールバック経由の保存フロー通しテスト
 * (test gap fill wave 7)
 *
 * カバレッジ観点:
 *   - ユーザーが diff preview で「保存する」→ _executeSave が走る (happy path)
 *   - ユーザーが diff preview で「キャンセル」→ _executeSave が走らない
 *   - entries が 0 件のとき diff preview はスキップして直接保存
 *   - onRequestDiffPreview 未設定時は preview なしで直接保存 (後方互換)
 *   - onRequestDiffPreview が reject した場合は保存失敗扱い
 *   - diff preview 表示中に onRequestDiffPreview から false → 保存 cancel / isDirty 変化なし
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ── 依存 mock ────────────────────────────────────────────────────────────

// refactor(#251): useFileOperations が OcrCard.tsx 経由で @dnd-kit/core / lucide-react を
// 引き込むようになったため、テスト環境ではモックが必要
vi.mock('../../components/OcrCard', () => ({
  commitActiveOcrCardEdit: vi.fn().mockReturnValue(false),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ mtime: new Date('2024-01-01'), size: 3 }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  convertFileSrc: (p: string) => p,
}));
vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn().mockResolvedValue({
    filePath: '',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map(),
  }),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChangesForPages: vi.fn().mockResolvedValue(undefined),
  clearCachedPages: vi.fn().mockResolvedValue(undefined),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn().mockResolvedValue({}),
  loadPage: vi.fn().mockResolvedValue({ textBlocks: [], imageBlocks: [], isDirty: false }),
  loadPecoToolBBoxMeta: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../utils/pdfSaver', () => ({
  savePDF: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));
vi.mock('../../hooks/useFontLoader', () => ({
  loadFallbackFontsLazy: vi.fn().mockResolvedValue([]),
  loadFontLazy: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  loadBundledIpAmjFontLazy: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  getPrimaryFontKind: vi.fn().mockReturnValue('bundled'),
  disableSystemFontForSession: vi.fn(),
}));

import { useFileOperations, __originalBytesCacheForTest } from '../../hooks/useFileOperations';
import { requestDiffPreview, type DiffPreviewResolverRef } from '../../utils/diffPreviewRequest';
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { invoke } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import type { PecoDocument, PageData, TextBlock } from '../../types';
import type { SaveDiffSummary } from '../../utils/saveDiffSummary';

// ── helpers ──────────────────────────────────────────────────────────────

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  __originalBytesCacheForTest.clear();
  vi.clearAllMocks();

  (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => Promise.resolve(undefined),
  );
  (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array([4, 5, 6]));
  (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array([1, 2, 3]));
  (stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    mtime: new Date('2024-01-01'),
    size: 3,
  });
});

function setupDirtyDoc(filePath: string): PecoDocument {
  const block: TextBlock = {
    id: 'blk-1',
    text: 'EDITED',
    originalText: 'ORIGINAL',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const dirtyPage: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
  };
  const doc: PecoDocument = {
    filePath,
    fileName: filePath.split('/').pop()!,
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, dirtyPage]]),
  } as unknown as PecoDocument;
  usePecoStore.setState({ document: doc, isDirty: true, undoStack: [], redoStack: [] });
  __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  return doc;
}

// undoStack に変更を積むヘルパー
function pushTextEditAction(filePath: string, blockId: string, before: string, after: string) {
  const pageData: PageData = {
    pageIndex: 0, width: 595, height: 842,
    textBlocks: [{ id: blockId, text: before, originalText: before, bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: false }],
    isDirty: false, thumbnail: null,
  };
  const afterPage: PageData = {
    ...pageData,
    textBlocks: [{ ...pageData.textBlocks[0], text: after, isDirty: true }],
    isDirty: true,
  };
  usePecoStore.setState({
    undoStack: [{ type: 'update_page', pageIndex: 0, before: pageData, after: afterPage }],
    lastSavedActionIndex: 0,
  });
  // キャッシュを確保
  __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DiffPreview + useFileOperations integration (wave 7)', () => {
  // ── D-01: diff preview 「保存する」→ 保存完走 ─────────────────────────
  it('D-01: onRequestDiffPreview が true を返すと _executeSave が実行されて保存成功', async () => {
    const filePath = '/diff-preview/confirm.pdf';
    setupDirtyDoc(filePath);
    // diff entries が出るよう undoStack に変更を積む
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    const onRequestDiffPreview = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    // 保存成功
    expect(ok).toBe(true);
    // onRequestDiffPreview が呼ばれている
    expect(onRequestDiffPreview).toHaveBeenCalledTimes(1);
    // savePDF が実際に呼ばれている
    expect(savePDF).toHaveBeenCalled();
    // 成功トースト
    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    expect(successCalls.length).toBeGreaterThan(0);
  });

  // ── D-02: diff preview 「キャンセル」→ 保存スキップ ────────────────────
  it('D-02: onRequestDiffPreview が false を返すと保存がキャンセルされ isDirty が維持される', async () => {
    const filePath = '/diff-preview/cancel.pdf';
    setupDirtyDoc(filePath);
    // diff entries が出るよう undoStack に変更を積む
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    const onRequestDiffPreview = vi.fn().mockResolvedValue(false);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    // 保存キャンセル
    expect(ok).toBe(false);
    // savePDF は呼ばれない
    expect(savePDF).not.toHaveBeenCalled();
    // store は dirty のまま
    expect(usePecoStore.getState().isDirty).toBe(true);
    // トーストは出ない（キャンセルはサイレント）
    expect(showToast).not.toHaveBeenCalledWith(expect.stringMatching(/保存しました/), expect.anything());
  });

  // ── D-03: entries=0 のとき diff preview スキップして保存 ────────────────
  it('D-03: undoStack が空で diff entries が 0 件 → preview スキップして直接保存', async () => {
    // clean page (isDirty=false) だが store isDirty=true
    const cleanPage: PageData = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
    };
    const doc: PecoDocument = {
      filePath: '/diff-preview/no-entries.pdf',
      fileName: 'no-entries.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, cleanPage]]),
    } as unknown as PecoDocument;
    // undoStack 空 → computeSaveDiff が entries=0 を返す
    usePecoStore.setState({ document: doc, isDirty: false, undoStack: [], redoStack: [] });
    __originalBytesCacheForTest.set('/diff-preview/no-entries.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const onRequestDiffPreview = vi.fn().mockResolvedValue(true);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // diff entries が 0 件なので onRequestDiffPreview は呼ばれない
    expect(onRequestDiffPreview).not.toHaveBeenCalled();
    // 保存自体は実行される
    expect(savePDF).toHaveBeenCalled();
  });

  // ── D-04: onRequestDiffPreview 未設定 → 後方互換 (直接保存) ──────────────
  it('D-04: onRequestDiffPreview 未設定時はプレビューなしで直接保存 (後方互換)', async () => {
    setupDirtyDoc('/diff-preview/compat.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    expect(savePDF).toHaveBeenCalled();
  });

  // ── D-05: onRequestDiffPreview が受け取る summary の構造を検証 ────────────
  it('D-05: onRequestDiffPreview に渡される SaveDiffSummary は entries / changedPages を持つ', async () => {
    const filePath = '/diff-preview/summary-check.pdf';
    setupDirtyDoc(filePath);

    // undoStack に update_page アクションを積んで diff が出るようにする
    const page = usePecoStore.getState().document!.pages.get(0)!;
    const beforePage: PageData = {
      ...page,
      textBlocks: [{ ...page.textBlocks[0], text: 'ORIGINAL' }],
    };
    const afterPage: PageData = { ...page };
    usePecoStore.setState({
      undoStack: [
        {
          type: 'update_page',
          pageIndex: 0,
          before: beforePage,
          after: afterPage,
        },
      ],
      lastSavedActionIndex: 0,
    });

    let capturedSummary: SaveDiffSummary | null = null;
    const onRequestDiffPreview = vi.fn().mockImplementation(async (s: SaveDiffSummary) => {
      capturedSummary = s;
      return true;
    });

    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // summary が渡されていることを確認
    expect(capturedSummary).not.toBeNull();
    if (capturedSummary) {
      expect(Array.isArray((capturedSummary as SaveDiffSummary).entries)).toBe(true);
      expect(Array.isArray((capturedSummary as SaveDiffSummary).changedPages)).toBe(true);
      expect(typeof (capturedSummary as SaveDiffSummary).timestamp).toBe('number');
    }
  });

  // ── D-06: onRequestDiffPreview が reject → handleSave は catch してトースト表示し false を返す
  // #270 で onRequestDiffPreview の reject を try/catch で捕捉する修正が入った。
  // reject は handleSave 内で吸収され、showToast が呼ばれ、savePDF は呼ばれず false が返る。
  it('D-06: onRequestDiffPreview が reject すると handleSave が reject する (実装現行動作)', async () => {
    const filePath = '/diff-preview/reject.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'b', 'OLD', 'NEW');

    const onRequestDiffPreview = vi.fn().mockRejectedValue(new Error('preview dialog crashed'));
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    // #270 以降: onRequestDiffPreview reject は catch されて throw しない
    let threw = false;
    await act(async () => {
      try {
        await result.current.handleSave();
      } catch {
        threw = true;
      }
    });

    // savePDF は呼ばれない
    expect(savePDF).not.toHaveBeenCalled();
    // #270 以降: catch して toast を出すため throw しない
    expect(threw).toBe(false);
    // エラートーストが呼ばれる
    expect(showToast).toHaveBeenCalled();
  });

  // ── D-07: 複数ページ変更の diff preview 通し ─────────────────────────────
  it('D-07: 複数ページの変更を持つ diff が preview に渡され確認後に保存される', async () => {
    const filePath = '/diff-preview/multi-page.pdf';
    const page0: PageData = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'b0', text: 'P0', originalText: 'P0-OLD', bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: true }],
      isDirty: true, thumbnail: null,
    };
    const page1: PageData = {
      pageIndex: 1, width: 595, height: 842,
      textBlocks: [{ id: 'b1', text: 'P1', originalText: 'P1-OLD', bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: true }],
      isDirty: true, thumbnail: null,
    };
    const doc: PecoDocument = {
      filePath,
      fileName: 'multi-page.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([[0, page0], [1, page1]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      isDirty: true,
      undoStack: [
        {
          type: 'update_pages',
          entries: [
            {
              pageIndex: 0,
              before: { ...page0, textBlocks: [{ ...page0.textBlocks[0], text: 'P0-OLD' }] },
              after: page0,
            },
            {
              pageIndex: 1,
              before: { ...page1, textBlocks: [{ ...page1.textBlocks[0], text: 'P1-OLD' }] },
              after: page1,
            },
          ],
        },
      ],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    let capturedSummary: SaveDiffSummary | null = null;
    const onRequestDiffPreview = vi.fn().mockImplementation(async (s: SaveDiffSummary) => {
      capturedSummary = s;
      return true;
    });
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    expect(capturedSummary).not.toBeNull();
    if (capturedSummary) {
      const s = capturedSummary as SaveDiffSummary;
      // 2 ページ, 2 エントリ
      expect(s.entries.length).toBe(2);
      expect(s.changedPages).toContain(0);
      expect(s.changedPages).toContain(1);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-075 (HUNT-C4): 保存 diff プレビュー / 別名保存ダイアログの await 後に
// isSavingRef を再チェックする + resolver 上書きによるゾンビ Promise の解消。
// プレビューモーダルは Esc/Tab しか捕捉せず、表示中も Ctrl+S / Ctrl+Shift+S が
// window リスナーへ届くため、await 中に別の保存が並走開始しうる。
// ────────────────────────────────────────────────────────────────────────

describe('PCT-075: プレビュー/ダイアログ await 後の isSavingRef 再チェック', () => {
  it('プレビュー await 中に別の保存が開始されたら confirmed=true でも _executeSave に進まない', async () => {
    const filePath = '/pct075/preview-race.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    let resolvePreview!: (confirmed: boolean) => void;
    const onRequestDiffPreview = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => { resolvePreview = resolve; }),
    );
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    const savePromise = result.current.handleSave();
    await waitFor(() => expect(onRequestDiffPreview).toHaveBeenCalledTimes(1));

    // プレビュー表示中に別経路 (Ctrl+Shift+S の別名保存等) で保存が開始された状況を再現
    result.current.isSavingRef.current = true;
    resolvePreview(true);

    // 修正前: confirmed=true で isSavingRef を握り直して _executeSave 二本目が走る。
    // 修正後: 再チェックで中断して false。
    await expect(savePromise).resolves.toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/別の保存処理が進行中/),
    );

    result.current.isSavingRef.current = false;
  });

  it('別名保存ダイアログ await 中に別の保存が開始されたら executeSaveAs は中断する', async () => {
    const filePath = '/pct075/saveas-race.pdf';
    setupDirtyDoc(filePath);

    const { save } = await import('@tauri-apps/plugin-dialog');
    let resolveDialog!: (path: string) => void;
    (save as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveDialog = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const saveAsPromise = result.current.executeSaveAs();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // ダイアログ操作中に別の保存処理が開始された状況を再現
    result.current.isSavingRef.current = true;
    resolveDialog('/pct075/other-name.pdf');

    await saveAsPromise;

    // 修正前: isSavingRef を握り直して二本目の _executeSave が走る。修正後: 中断。
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/別の保存処理が進行中/),
    );

    result.current.isSavingRef.current = false;
  });
});

describe('PCT-075: requestDiffPreview の resolver 二重設定ガード (ゾンビ Promise 解消)', () => {
  it('resolver 二重設定時は旧 Promise が false で解決される', async () => {
    const resolverRef: DiffPreviewResolverRef = { current: null };
    const shown: SaveDiffSummary[] = [];
    const summaryA = { entries: [], changedPages: [], timestamp: 1 } as unknown as SaveDiffSummary;
    const summaryB = { entries: [], changedPages: [], timestamp: 2 } as unknown as SaveDiffSummary;

    const first = requestDiffPreview(resolverRef, (s) => shown.push(s), summaryA);
    const second = requestDiffPreview(resolverRef, (s) => shown.push(s), summaryB);

    // 修正前: 1 本目の resolver が上書きで失われ、first は永久 pending (ゾンビ)。
    // 修正後: 差し替え時に false で解決される。
    await expect(first).resolves.toBe(false);

    // 2 本目はユーザー操作 (確定) で通常通り解決する
    resolverRef.current?.(true);
    await expect(second).resolves.toBe(true);
    expect(shown).toEqual([summaryA, summaryB]);
  });

  it('プレビュー表示中の再保存要求では 1 本目がキャンセル扱いになり 2 本目だけ保存される', async () => {
    const filePath = '/pct075/double-save.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    // App.tsx と同じ配線: onRequestDiffPreview → requestDiffPreview(resolverRef, ...)
    const resolverRef: DiffPreviewResolverRef = { current: null };
    const onRequestDiffPreview = (summary: SaveDiffSummary) =>
      requestDiffPreview(resolverRef, () => {}, summary);

    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    // 1 本目の保存要求 → プレビュー待ちで停止
    const first = result.current.handleSave();
    await waitFor(() => expect(resolverRef.current).not.toBeNull());
    const firstResolver = resolverRef.current;

    // プレビュー表示中に 2 本目の保存要求 (モーダル表示中の再 Ctrl+S)
    const second = result.current.handleSave();

    // 1 本目は resolver 差し替え時に false 解決され、保存せず静かに終了する
    await expect(first).resolves.toBe(false);

    // 2 本目のプレビューをユーザーが確定 → 2 本目だけが保存される
    await waitFor(() => {
      expect(resolverRef.current).not.toBeNull();
      expect(resolverRef.current).not.toBe(firstResolver);
    });
    resolverRef.current!(true);
    await expect(second).resolves.toBe(true);
    expect(savePDF).toHaveBeenCalledTimes(1);
  });
});

describe('PCT-075: App.tsx の resolver ガード配線 (静的検証)', () => {
  it('App.tsx は onRequestDiffPreview を requestDiffPreview (resolver ガード付き) 経由で配線している', () => {
    const appSource = readFileSync(resolvePath(process.cwd(), 'src/App.tsx'), 'utf8');
    // 旧実装 (resolver 無条件上書き) へ戻すとこの配線が消えて fail する
    expect(appSource).toContain(
      'requestDiffPreview(diffPreviewResolveRef, setDiffPreviewSummary, summary)',
    );
  });
});
