/**
 * Integration test: issue #413 (PCT-182)
 * 監査ログ (_writeAuditLog) が通常保存 / 別名保存で実際に entries を記録することを縛る。
 *
 * バグの内容: setLastSavedActionIndex による更新後の lastSavedActionIndex を
 * diff 計算に使うと、undoStack.slice(lastSavedActionIndex) が常に空になり
 * entries=0 で write_audit_log が呼ばれない (#201 機能の完全不全)。
 *
 * このテストは write_audit_log invoke 呼び出しの有無・内容を直接検証することで、
 * 「通常の編集→保存で監査ログ entries が空にならない」ことを実測する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── 依存 mock (diffPreviewSaveIntegration.test.ts と同じ流儀) ──────────────

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
  remapTemporaryPageEntries: vi.fn().mockResolvedValue(undefined),
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
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { invoke } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import { save } from '@tauri-apps/plugin-dialog';
import type { PecoDocument, PageData } from '../../types';

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
  const doc: PecoDocument = {
    filePath,
    fileName: filePath.split('/').pop()!,
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'blk-1', text: 'EDITED', originalText: 'ORIGINAL', bbox: { x: 0, y: 0, width: 100, height: 20 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: true }],
      isDirty: true, thumbnail: null,
    } as PageData]]),
  } as unknown as PecoDocument;
  usePecoStore.setState({ document: doc, isDirty: true, undoStack: [], redoStack: [] });
  __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  return doc;
}

// 保存前に undoStack へテキスト編集アクションを1件積む (lastSavedActionIndex=0 から未保存の変更)
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
  __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
}

describe('AuditLog + useFileOperations integration (#413 / PCT-182)', () => {
  it('AL-01: 通常保存 (handleSave) で write_audit_log が entries 非空で呼ばれる', async () => {
    const filePath = '/audit-log/normal-save.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    expect(savePDF).toHaveBeenCalled();

    // バグ再現時 (修正前): preSaveActionIndex を渡さず更新後の
    // lastSavedActionIndex を使うと undoStack.slice() が空になり
    // write_audit_log は一度も呼ばれない。
    const auditCalls = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'write_audit_log',
    );
    expect(auditCalls.length).toBe(1);

    const body = JSON.parse((auditCalls[0][1] as { body: string }).body);
    expect(body.filePath).toBe(filePath);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries[0]).toMatchObject({
      pageIndex: 0,
      blockId: 'blk-1',
      before: 'ORIGINAL',
      after: 'EDITED',
      changeType: 'modified',
    });
  });

  it('AL-02: 別名保存 (executeSaveAs) でも write_audit_log が entries 非空で呼ばれる', async () => {
    const filePath = '/audit-log/save-as-source.pdf';
    const targetPath = '/audit-log/save-as-target.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(targetPath);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    expect(savePDF).toHaveBeenCalled();

    const auditCalls = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'write_audit_log',
    );
    expect(auditCalls.length).toBe(1);

    const body = JSON.parse((auditCalls[0][1] as { body: string }).body);
    expect(body.filePath).toBe(targetPath);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('AL-03: 変更なし保存 (undoStack 空) では write_audit_log が呼ばれない (entries=0 は書き出さない仕様)', async () => {
    const filePath = '/audit-log/no-changes.pdf';
    setupDirtyDoc(filePath);
    // undoStack は空のまま = 差分なし

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(savePDF).toHaveBeenCalled();
    const auditCalls = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'write_audit_log',
    );
    expect(auditCalls.length).toBe(0);
  });

  it('AL-04: 連続2回保存すると、2回目の監査ログは1回目以降の差分のみを含む (preSaveActionIndex が保存ごとに更新される)', async () => {
    const filePath = '/audit-log/sequential-saves.pdf';
    setupDirtyDoc(filePath);
    pushTextEditAction(filePath, 'blk-1', 'ORIGINAL', 'EDITED');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    // 1回目の保存
    await act(async () => {
      await result.current.handleSave();
    });
    expect(usePecoStore.getState().lastSavedActionIndex).toBe(1);

    // 1回目保存後にさらに1件編集を積む
    const page = usePecoStore.getState().document!.pages.get(0)!;
    const before2: PageData = { ...page, textBlocks: [{ ...page.textBlocks[0], text: 'EDITED' }] };
    const after2: PageData = { ...page, textBlocks: [{ ...page.textBlocks[0], id: 'blk-2', text: 'SECOND-EDIT' }] };
    usePecoStore.setState({
      undoStack: [...usePecoStore.getState().undoStack, { type: 'update_page', pageIndex: 0, before: before2, after: after2 }],
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // 2回目の保存
    await act(async () => {
      await result.current.handleSave();
    });

    const auditCalls = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'write_audit_log',
    );
    // 1回目・2回目それぞれで1件ずつ、計2回呼ばれる (どちらも entries 非空)
    expect(auditCalls.length).toBe(2);
    const secondBody = JSON.parse((auditCalls[1][1] as { body: string }).body);
    // 2回目の diff は 1回目保存以降のアクションのみを含む (blk-1 の再掲載ではなく blk-2 の追加分)
    expect(secondBody.entries.some((e: { blockId: string }) => e.blockId === 'blk-2')).toBe(true);
  });
});
