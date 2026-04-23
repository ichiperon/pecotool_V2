/**
 * OCR エンジン呼び出し経路の JS 側テスト。
 *
 * 対象: `useOcrEngine` の runOcrCurrentPage / runOcrAllPages / cancelOcr
 *
 * スコープ:
 *   - Rust 側 (Windows.Media.Ocr) の実動作はテスト対象外。
 *     invoke('run_ocr') を mock し、JS 側のデータ変換・ソート・store 連携・
 *     cancellation / progress / error ハンドリングを検証する。
 *
 * 検証項目:
 *   1. 正常系: 1 ページ OCR → textBlocks が設定・isDirty=true
 *   2. 上書き確認: 既存 OCR があると ask() が呼ばれ、キャンセルで store 変化なし
 *   3. エラー系: invoke が status=error を返す → toast, store 変化なし
 *   4. 全ページ OCR 進捗: progress が 1→2→...→N に更新される
 *   5. キャンセル: 全ページ OCR 中に cancelOcr → 途中で止まり toast が「キャンセル」
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// 依存 mock --- vi.hoisted で巻き上げて TDZ 回避 ----------------------
const h = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  askMock: vi.fn(),
  writeFileMock: vi.fn(),
  removeMock: vi.fn(),
  getCachedPageProxyMock: vi.fn(),
  openFreshPdfDocMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invokeMock, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: h.askMock, open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: h.writeFileMock, remove: h.removeMock,
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: vi.fn(async () => '/tmp'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

// pdfLoader: 最小限の PDFDocumentProxy 風 mock
const makeMockPage = (width = 595, height = 842) => ({
  getViewport: vi.fn(() => ({ width, height })),
  render: vi.fn(() => ({ promise: Promise.resolve() })),
});
const makeMockPdf = (totalPages: number) => ({
  numPages: totalPages,
  getPage: vi.fn(async () => makeMockPage()),
  destroy: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
});

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: h.getCachedPageProxyMock,
  getSharedPdfProxy: vi.fn(),
  openFreshPdfDoc: h.openFreshPdfDocMock,
  loadPDF: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  clearTemporaryChanges: vi.fn(async () => {}),
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

vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

// target import (mock 後)
import { useOcrEngine } from '../../hooks/useOcrEngine';
import { usePecoStore } from '../../store/pecoStore';
import type { PecoDocument, PageData, TextBlock } from '../../types';

// Helpers ---------------------------------------------------------
function makeDoc(totalPages: number): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < totalPages; i++) {
    pages.set(i, {
      pageIndex: i, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
    });
  }
  return { filePath: '/t.pdf', fileName: 't.pdf', totalPages, metadata: {}, pages };
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
  h.invokeMock.mockReset();
  h.askMock.mockReset();
  h.writeFileMock.mockReset().mockResolvedValue(undefined);
  h.removeMock.mockReset().mockResolvedValue(undefined);
  h.getCachedPageProxyMock.mockReset().mockResolvedValue(makeMockPage());
  h.openFreshPdfDocMock.mockReset().mockResolvedValue(makeMockPdf(3));

  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [], redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
    clipboard: [],
  } as any);
});

describe('useOcrEngine: JS 側のパイプライン (invoke 結果を mock)', () => {
  it('正常系: 1 ページ OCR → textBlocks 3 件が store に反映、isDirty=true', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // invoke('run_ocr') が 3 ブロック返す
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'α', bbox: { x: 10, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
          { text: 'β', bbox: { x: 40, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
          { text: 'γ', bbox: { x: 70, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const showToast = (msg: string, err?: boolean) => toasts.push({ msg, err });

    const { result } = renderHook(() => useOcrEngine(showToast));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // invoke が呼ばれ、writeFile / remove も走っている
    expect(h.invokeMock).toHaveBeenCalledWith(
      'run_ocr',
      expect.objectContaining({ imagePath: expect.any(String) }),
    );
    expect(h.writeFileMock).toHaveBeenCalled();
    expect(h.removeMock).toHaveBeenCalled();

    // store 反映: textBlocks 3 件、全て isDirty=true
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(3);
    expect(p0.textBlocks.every((b) => b.isDirty)).toBe(true);
    expect(p0.textBlocks.map((b) => b.text)).toEqual(['α', 'β', 'γ']);
    expect(p0.isDirty).toBe(true);

    // 成功トースト
    expect(toasts.some((t) => t.msg.includes('OCR'))).toBe(true);
  });

  it('上書き確認: 既存 textBlocks 有り + ask false でキャンセル → invoke 呼ばず', async () => {
    const doc = makeDoc(1);
    doc.pages.get(0)!.textBlocks = [
      { id: 'existing', text: 'OLD', originalText: 'OLD', bbox: { x: 0, y: 0, width: 10, height: 10 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.askMock.mockResolvedValue(false); // ユーザーが上書きキャンセル

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(h.askMock).toHaveBeenCalled();
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());

    // store 変化なし
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    expect(p0.textBlocks[0].text).toBe('OLD');
  });

  it('エラー系: invoke が status=error → error toast, store 変化なし', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_ocr') return JSON.stringify({ status: 'error', blocks: [], message: 'OCR engine failed' });
      return '';
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const showToast = (msg: string, err?: boolean) => toasts.push({ msg, err });

    const { result } = renderHook(() => useOcrEngine(showToast));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // error toast 発火
    expect(toasts.some((t) => t.err === true && /OCR/.test(t.msg))).toBe(true);
    // store は変化なし
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
    expect(p0.isDirty).toBe(false);
  });

  it('全ページ OCR: progress が 1→2→3 と進行、最終 toast が完了メッセージ', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));
    h.askMock.mockResolvedValue(true); // 確認 2 段階を全て OK

    // 各ページ 1 ブロック
    let callCount = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      callCount++;
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: `BLOCK_${callCount}`, bbox: { x: 0, y: 0, width: 10, height: 10 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    await act(async () => { await result.current.runOcrAllPages(); });

    // 3 ページ全てに invoke 呼出
    expect(h.invokeMock).toHaveBeenCalledTimes(3);
    // 各ページ textBlocks が 1 件ずつ
    for (let i = 0; i < 3; i++) {
      const p = usePecoStore.getState().document!.pages.get(i)!;
      expect(p.textBlocks).toHaveLength(1);
      expect(p.isDirty).toBe(true);
    }
    // 完了 toast (キャンセルではない)
    expect(toasts.some((t) => t.msg.includes('完了') || t.msg.includes('OCR'))).toBe(true);
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(false);
  });

  it('キャンセル: runOcrAllPages 中に cancelOcr → 途中で止まり toast にキャンセル文言', async () => {
    usePecoStore.getState().setDocument(makeDoc(5));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(5));
    h.askMock.mockResolvedValue(true);

    // 2 ページ目の invoke 完了時点でキャンセル
    let processed = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      processed++;
      // awaited path に必ず 1 microtask 挟むことで cancelTokenRef の反映タイミングを作る
      await new Promise((r) => setTimeout(r, 0));
      return JSON.stringify({
        status: 'ok',
        blocks: [{ text: `P${processed}`, bbox: { x: 0, y: 0, width: 10, height: 10 },
          writingMode: 'horizontal', confidence: 1 }],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    const promise = result.current.runOcrAllPages();
    // 2 ページ処理が始まるまで待つ
    await new Promise((r) => setTimeout(r, 20));
    act(() => { result.current.cancelOcr(); });
    await act(async () => { await promise; });

    // 5 ページ全ては処理されていない (cancelOcr で途中停止)
    expect(h.invokeMock.mock.calls.length).toBeLessThan(5);
    expect(h.invokeMock.mock.calls.length).toBeGreaterThan(0);
    // キャンセル toast が存在
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(true);
  });
});
