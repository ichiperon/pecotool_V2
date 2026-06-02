/**
 * Test gap fill wave 4:
 * useFileOperations _executeSave / handleSave の finally リセット動作
 *
 * 検証観点:
 *   1. buildPdfDocument (= savePDF) が throw した場合、isSavingRef が finally で false に戻る
 *   2. writeFile (= invoke replace_pdf_file) が EACCES で reject した場合の
 *      handler 経路 + isSavingRef リセット
 *   3. handleSave が isSaving=true 中に呼ばれた場合、二重保存が起動しない (isSavingRef ガード)
 *   4. setIsSaving コールバックが finally で false を受け取る
 *   5. setSaveStep コールバックが finally で null を受け取る
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── 依存 mock (useFileOperations.test.ts と同じ構成) ─────────────────────

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
  clearCachedPages: vi.fn().mockResolvedValue(undefined),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn().mockResolvedValue({}),
  loadPage: vi.fn().mockResolvedValue({
    textBlocks: [],
    imageBlocks: [],
    isDirty: false,
  }),
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

import {
  useFileOperations,
  __originalBytesCacheForTest,
} from '../../hooks/useFileOperations';
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { invoke } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import type { PecoDocument, PageData } from '../../types';

// ── Setup helpers ─────────────────────────────────────────────────────────

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  __originalBytesCacheForTest.clear();
  vi.clearAllMocks();

  (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => Promise.resolve(undefined),
  );
  (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Uint8Array([4, 5, 6]),
  );
  (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Uint8Array([1, 2, 3]),
  );
  (stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    mtime: new Date('2024-01-01'),
    size: 3,
  });
});

function setupDirtyDoc(filePath: string): void {
  const dirtyPage: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [{ id: 'blk', text: 'T', isDirty: true } as PageData['textBlocks'][number]],
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
  usePecoStore.setState({
    document: doc,
    isDirty: true,
    undoStack: [],
    redoStack: [],
  });
  __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('useFileOperations _executeSave finally リセット (wave 4)', () => {
  // ── T-1: savePDF throw → isSavingRef が false に戻る ──────────────────

  it('T-1: savePDF が throw すると isSavingRef は finally で false にリセットされる', async () => {
    setupDirtyDoc('/finally/throw-savepdf.pdf');

    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('[withStep] タイムアウト: savePDF timeout'),
    );

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving),
    );

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    // 保存は失敗 (false)
    expect(saveResult).toBe(false);
    // isSavingRef は false に戻っている (再入 guard が解除されている)
    // handleSave の finally で isSavingRef.current = false が実行される
    expect(result.current.isSavingRef.current).toBe(false);
    // setIsSaving(false) が呼ばれている
    expect(setIsSaving).toHaveBeenLastCalledWith(false);
    // エラートーストが出ている
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存に失敗/),
      true,
    );
  });

  // ── T-2: replace_pdf_file (EACCES) reject → isSavingRef が false ────────

  it('T-2: replace_pdf_file が EACCES で reject すると isSavingRef が false にリセットされ action 付きトーストが出る', async () => {
    setupDirtyDoc('/finally/eacces.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(
          new Error('Access is denied. (os error 5)'),
        );
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const setSaveStep = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving, undefined, undefined, undefined, setSaveStep),
    );

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    // 保存は失敗
    expect(saveResult).toBe(false);
    // isSavingRef は false に戻っている
    expect(result.current.isSavingRef.current).toBe(false);
    // setIsSaving(false) が呼ばれている (finally)
    expect(setIsSaving).toHaveBeenLastCalledWith(false);
    // setSaveStep(null) が呼ばれている (finally)
    expect(setSaveStep).toHaveBeenLastCalledWith(null);
    // EACCES 系の action 付きトーストが出ている
    const errorCalls = showToast.mock.calls.filter(
      (args: unknown[]) => args[1] === true,
    );
    expect(errorCalls.length).toBeGreaterThan(0);
    const lastError = errorCalls[errorCalls.length - 1] as unknown[];
    expect(lastError[0]).toMatch(/別プロセスがロック中|保存先のファイル/);
    expect(lastError[2]).toBeDefined();
    expect((lastError[2] as { label?: string }).label).toBe('別名で保存');
  });

  // ── T-3: isSaving=true 中の 2 重呼び出しは no-op ───────────────────────

  it('T-3: isSavingRef=true 中に handleSave を再呼び出しすると「保存処理が進行中」toast が出て no-op', async () => {
    setupDirtyDoc('/finally/double-save.pdf');

    // savePDF を hang させて isSavingRef=true の状態を維持する
    let resolveSavePdf!: (bytes: Uint8Array) => void;
    const hangSave = new Promise<Uint8Array>(
      (resolve) => { resolveSavePdf = resolve; },
    );
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(hangSave);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    // 1 回目の handleSave を開始 (hang)
    const firstSave = result.current.handleSave();
    // savePDF が呼ばれるまで待機 → isSavingRef=true
    await vi.waitFor(() => {
      expect(savePDF).toHaveBeenCalled();
    });

    expect(result.current.isSavingRef.current).toBe(true);

    // isSaving=true 中に 2 回目を呼ぶ
    let secondResult: boolean | undefined;
    await act(async () => {
      secondResult = await result.current.handleSave();
    });

    // 2 回目は即時 false で弾かれる
    expect(secondResult).toBe(false);
    // savePDF は 1 回しか呼ばれていない (2 回目は isSavingRef guard で止まる)
    expect(savePDF).toHaveBeenCalledTimes(1);
    // 「保存処理が進行中」のトーストが出ている
    const progressToasts = showToast.mock.calls.filter(
      ([msg]: [string]) => msg.includes('保存処理が進行中'),
    );
    expect(progressToasts.length).toBeGreaterThan(0);

    // hang を解放して 1 回目を完了させる
    resolveSavePdf(new Uint8Array([7, 8, 9]));
    await firstSave;

    // 完了後は isSavingRef が false に戻る
    expect(result.current.isSavingRef.current).toBe(false);
  });

  // ── T-4: setIsSaving コールバックが finally で false を受け取る ──────────

  it('T-4: 正常保存の finally でも setIsSaving(false) が呼ばれる', async () => {
    setupDirtyDoc('/finally/setissaving.pdf');

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // finally が必ず呼ばれることを確認
    // setIsSaving(true) → setIsSaving(false) の順で呼ばれる
    const calls = setIsSaving.mock.calls.map(([v]: [boolean]) => v);
    expect(calls).toContain(true);
    expect(calls).toContain(false);
    expect(calls[calls.length - 1]).toBe(false);
  });

  // ── T-5: setSaveStep が finally で null を受け取る ────────────────────

  it('T-5: 正常保存の finally で setSaveStep(null) が呼ばれる', async () => {
    setupDirtyDoc('/finally/savestep.pdf');

    const showToast = vi.fn();
    const setSaveStep = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        setSaveStep,
      ),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // setSaveStep は 'changes' → 'pdf-gen' → 'safe-replace' → null の順で呼ばれる
    const stepCalls = setSaveStep.mock.calls.map(([v]: [string | null]) => v);
    expect(stepCalls).toContain('changes');
    expect(stepCalls).toContain(null);
    expect(stepCalls[stepCalls.length - 1]).toBe(null);
  });

  // ── T-6: getAllTemporaryPageData throw でも isSavingRef がリセットされる ─

  it('T-6: _executeSave 内部の getAllTemporaryPageData が reject しても isSavingRef は false に戻る', async () => {
    setupDirtyDoc('/finally/idb-throw.pdf');

    const { getAllTemporaryPageData } = await import('../../utils/pdfLoader');
    (getAllTemporaryPageData as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('[withStep] readIdbDirty タイムアウト'),
    );

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving),
    );

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    // 保存は失敗
    expect(saveResult).toBe(false);
    // finally で isSavingRef が false に戻っている
    expect(result.current.isSavingRef.current).toBe(false);
    expect(setIsSaving).toHaveBeenLastCalledWith(false);
  });

  // ── T-7: onRequestSaveDialog 指定時の EACCES → finally でリセット ──────

  it('T-7: onRequestSaveDialog 指定時に EACCES が起きても finally で isSavingRef が false に戻る', async () => {
    setupDirtyDoc('/finally/dialog-eacces.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error('sharing violation (os error 32)'));
      }
      return Promise.resolve(undefined);
    });

    const onRequestSaveDialog = vi.fn();
    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        setIsSaving,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestSaveDialog,
      ),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // finally で isSavingRef が false に戻っている
    expect(result.current.isSavingRef.current).toBe(false);
    expect(setIsSaving).toHaveBeenLastCalledWith(false);

    // action.onClick で onRequestSaveDialog が起動できる状態
    const errorCalls = showToast.mock.calls.filter(
      (args: unknown[]) => args[1] === true,
    );
    expect(errorCalls.length).toBeGreaterThan(0);
    const lastError = errorCalls[errorCalls.length - 1] as unknown[];
    const action = lastError[2] as { onClick?: () => void } | undefined;
    expect(action?.onClick).toBeDefined();

    // onClick を呼ぶと onRequestSaveDialog が起動される
    action!.onClick!();
    expect(onRequestSaveDialog).toHaveBeenCalledTimes(1);
  });

  // ── T-8: document=null なら isSavingRef に触れず早期 return する ─────

  it('T-8: document=null のとき handleSave は isSavingRef を true にする前に弾き、isSavingRef は false のまま', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving),
    );

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    // document=null → isSavingRef.current = true になる前に早期 return するため、
    // isSavingRef.current は初期値 false のまま
    expect(result.current.isSavingRef.current).toBe(false);
    // isSaving は true にも false にも設定されない (finally に到達しない)
    expect(setIsSaving).not.toHaveBeenCalled();
    // savePDF は呼ばれない
    expect(savePDF).not.toHaveBeenCalled();
    // 「PDFが開かれていません」トーストが出る
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/PDF.*開かれていません/),
      true,
    );
  });
});
