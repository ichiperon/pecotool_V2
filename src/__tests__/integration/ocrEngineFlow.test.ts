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
  getTemporaryPageDataMock: vi.fn(),
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
//
// #50 検証用に getViewport は rotation (0/90/180/270) を考慮した
// convertToPdfPoint を返す。pdfjs と同じ式で実装。
//   rot=0   : [x_pdf, height - y_screen]
//   rot=90  : [y_screen, x_screen]          (回転後の画面は元 PDF の縦長を横にしたもの)
//   rot=180 : [width - x_screen, y_screen]
//   rot=270 : [height - y_screen, width - x_screen]
// width/height は PDF user space 寸法 (rotation=0 のときの幅・高さ)。
type ViewportMock = {
  width: number;
  height: number;
  scale: number;
  rotation: number;
  convertToPdfPoint: (x: number, y: number) => [number, number];
};
const makeViewport = (
  pdfWidth: number,
  pdfHeight: number,
  rotation: number,
  scale: number,
): ViewportMock => {
  // 回転後のスクリーン寸法
  const rot = ((rotation % 360) + 360) % 360;
  const screenW = (rot === 90 || rot === 270 ? pdfHeight : pdfWidth) * scale;
  const screenH = (rot === 90 || rot === 270 ? pdfWidth : pdfHeight) * scale;
  const convertToPdfPoint = (x: number, y: number): [number, number] => {
    // unscale to viewport-space (scale=1.0)
    const xu = x / scale;
    const yu = y / scale;
    switch (rot) {
      case 0:
        // PDF y is up, viewport y is down; pdf_y = pdfHeight - yu
        return [xu, pdfHeight - yu];
      case 90:
        // viewport (x,y) -> pdf (pdfWidth, ?)  Mapping derived from pdfjs:
        // pdf_x = yu, pdf_y = xu
        return [yu, xu];
      case 180:
        return [pdfWidth - xu, yu];
      case 270:
        return [pdfHeight - yu, pdfWidth - xu];
      default:
        return [xu, pdfHeight - yu];
    }
  };
  return {
    width: screenW,
    height: screenH,
    scale,
    rotation: rot,
    convertToPdfPoint,
  };
};
const makeMockPage = (width = 595, height = 842, rotation = 0) => ({
  getViewport: vi.fn(({ scale = 1.0 }: { scale?: number } = {}) =>
    makeViewport(width, height, rotation, scale),
  ),
  render: vi.fn(() => ({ promise: Promise.resolve() })),
  cleanup: vi.fn(),
});
const makeMockPdf = (totalPages: number, pageOpts: { width?: number; height?: number; rotation?: number } = {}) => ({
  numPages: totalPages,
  getPage: vi.fn(async () =>
    makeMockPage(pageOpts.width ?? 595, pageOpts.height ?? 842, pageOpts.rotation ?? 0),
  ),
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
  getTemporaryPageData: h.getTemporaryPageDataMock,
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
  h.getTemporaryPageDataMock.mockReset().mockResolvedValue(null);

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

    // invoke が呼ばれ、Tauri fs 経由の一時ファイルは使わない
    expect(h.invokeMock).toHaveBeenCalledWith(
      'run_ocr',
      expect.objectContaining({ imageBytes: expect.any(Array) }),
    );
    const runOcrArgs = h.invokeMock.mock.calls.find(([cmd]) => cmd === 'run_ocr')?.[1] as Record<string, unknown>;
    expect(runOcrArgs.imagePath).toBeUndefined();
    expect(h.writeFileMock).not.toHaveBeenCalled();
    expect(h.removeMock).not.toHaveBeenCalled();

    // store 反映: textBlocks 3 件、全て isDirty=true
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(3);
    expect(p0.textBlocks.every((b) => b.isDirty)).toBe(true);
    expect(p0.textBlocks.map((b) => b.text)).toEqual(['α', 'β', 'γ']);
    expect(p0.isDirty).toBe(true);

    // 成功トースト
    expect(toasts.some((t) => t.msg.includes('OCR'))).toBe(true);
  });

  it('issue: currentPageIndex=1 の runOcrCurrentPage は 2 ページ目だけ OCR 更新する', async () => {
    const pdf = makeMockPdf(3);
    h.openFreshPdfDocMock.mockResolvedValue(pdf);
    usePecoStore.getState().setDocument(makeDoc(3));
    usePecoStore.setState({ currentPageIndex: 1 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'PAGE_2', bbox: { x: 10, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(doc.pages.get(1)!.textBlocks).toHaveLength(1);
    expect(doc.pages.get(1)!.textBlocks[0].text).toBe('PAGE_2');
    expect(doc.pages.get(2)!.textBlocks).toHaveLength(0);
    expect(pdf.getPage).toHaveBeenCalledWith(2);
    expect(h.invokeMock).toHaveBeenCalledTimes(1);
  });

  it('非identity pageOrder では source page をOCRし、display pageへ結果を書き込む', async () => {
    const pdf = makeMockPdf(3);
    h.openFreshPdfDocMock.mockResolvedValue(pdf);
    usePecoStore.getState().setDocument(makeDoc(3));
    usePecoStore.setState({ currentPageIndex: 0, pageOrder: [2, 0, 1] } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'SOURCE_3', bbox: { x: 10, y: 10, width: 20, height: 20 }, writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks).toHaveLength(1);
    expect(doc.pages.get(0)!.textBlocks[0].text).toBe('SOURCE_3');
    expect(doc.pages.get(1)!.textBlocks).toHaveLength(0);
    expect(doc.pages.get(2)!.textBlocks).toHaveLength(0);
    expect(pdf.getPage).toHaveBeenCalledWith(3);
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

  it('キャンセル: runOcrForPage 完了後に cancelOcr 済みなら結果を store に反映しない', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(1));
    h.askMock.mockResolvedValue(true);

    let resolveOcr: (raw: string) => void = () => {};
    const ocrStarted = new Promise<void>((resolve) => {
      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        resolve();
        return await new Promise<string>((r) => { resolveOcr = r; });
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    const promise = result.current.runOcrAllPages();

    await ocrStarted;
    act(() => { result.current.cancelOcr(); });
    resolveOcr(JSON.stringify({
      status: 'ok',
      blocks: [{ text: 'CANCELLED', bbox: { x: 0, y: 0, width: 10, height: 10 },
        writingMode: 'horizontal', confidence: 1 }],
    }));
    await act(async () => { await promise; });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
  });

  it('issue #9: LRU 退避ページに対する runOcrCurrentPage で IDB 既存 textBlocks があれば上書き確認が出る', async () => {
    // 1 ページの doc を作るが、メモリ Map からは pageIndex=0 を削除して LRU 退避状態を模倣
    const doc = makeDoc(1);
    doc.pages.delete(0);
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // IDB 側には退避済み textBlocks が残っている状態を mock で再現
    const evictedBlock: TextBlock = {
      id: 'evicted', text: 'EVICTED_EDIT', originalText: 'EVICTED_EDIT',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      writingMode: 'horizontal', order: 0, isNew: false, isDirty: true,
    };
    h.getTemporaryPageDataMock.mockResolvedValue({
      pageIndex: 0, width: 595, height: 842, isDirty: true, textBlocks: [evictedBlock],
    });

    // ユーザーは上書きをキャンセル
    h.askMock.mockResolvedValue(false);

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // 上書き確認 ask() が呼ばれ、IDB 退避済み textBlocks がチェックされている
    expect(h.getTemporaryPageDataMock).toHaveBeenCalledWith('/t.pdf', 0);
    expect(h.askMock).toHaveBeenCalled();
    // ユーザーがキャンセルしたので invoke('run_ocr') は走らない
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('PCT-007: runOcrAllPages は IDB 退避ページの既存 textBlocks で上書き確認し、キャンセルなら OCR しない', async () => {
    const doc = makeDoc(3);
    doc.pages.delete(1);
    usePecoStore.getState().setDocument(doc);

    const evictedBlock: TextBlock = {
      id: 'evicted-all', text: 'EVICTED_ALL', originalText: 'EVICTED_ALL',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      writingMode: 'horizontal', order: 0, isNew: false, isDirty: true,
    };
    h.getTemporaryPageDataMock.mockImplementation(async (_filePath: string, pageIndex: number) => (
      pageIndex === 1
        ? { pageIndex, width: 595, height: 842, isDirty: true, textBlocks: [evictedBlock] }
        : null
    ));
    h.askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    expect(h.getTemporaryPageDataMock).toHaveBeenCalledWith('/t.pdf', 1);
    expect(h.askMock).toHaveBeenCalledTimes(2);
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('PCT-007: runOcrRange は対象 range の IDB 退避ページだけ確認し、キャンセルなら OCR しない', async () => {
    const doc = makeDoc(3);
    doc.pages.delete(1);
    usePecoStore.getState().setDocument(doc);

    const evictedBlock: TextBlock = {
      id: 'evicted-range', text: 'EVICTED_RANGE', originalText: 'EVICTED_RANGE',
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      writingMode: 'horizontal', order: 0, isNew: false, isDirty: true,
    };
    h.getTemporaryPageDataMock.mockImplementation(async (_filePath: string, pageIndex: number) => (
      pageIndex === 1
        ? { pageIndex, width: 595, height: 842, isDirty: true, textBlocks: [evictedBlock] }
        : null
    ));
    h.askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrRange('2'); });

    expect(h.getTemporaryPageDataMock).toHaveBeenCalledWith('/t.pdf', 1);
    expect(h.getTemporaryPageDataMock).not.toHaveBeenCalledWith('/t.pdf', 0);
    expect(h.getTemporaryPageDataMock).not.toHaveBeenCalledWith('/t.pdf', 2);
    expect(h.askMock).toHaveBeenCalledTimes(2);
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  // ─────────────────────────────────────────────────────────────
  // #48: フォルダ OCR は savePdf() === false を受けたら即時中止する
  // ─────────────────────────────────────────────────────────────
  it('issue #48: フォルダ OCR は savePdf が false を返したら次の PDF へ進まずに中止する', async () => {
    // 2 ファイル分の PDF を返すフォルダを mock
    const askDialogMock = (await import('@tauri-apps/plugin-dialog')).open as ReturnType<typeof vi.fn>;
    askDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true); // フォルダOCR確認 OK

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') return ['/folder/a.pdf', '/folder/b.pdf'];
      if (cmd === 'run_ocr') {
        return JSON.stringify({
          status: 'ok',
          blocks: [
            { text: 'X', bbox: { x: 0, y: 0, width: 5, height: 5 },
              writingMode: 'horizontal', confidence: 1 },
          ],
        });
      }
      return '';
    });

    // openPdf は doc を store にセットして true を返す
    const openCalls: string[] = [];
    const openPdf = async (filePath: string) => {
      openCalls.push(filePath);
      usePecoStore.getState().setDocument({
        filePath,
        fileName: filePath.split('/').pop()!,
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, {
          pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
        }]]),
      });
      return true;
    };
    // 1 ファイル目: savePdf が false → ループ中止、2 ファイル目には進まないはず
    const savePdf = vi.fn(async () => false);

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() =>
      useOcrEngine((m, e) => toasts.push({ msg: m, err: e }), { openPdf, savePdf }),
    );

    await act(async () => { await result.current.runOcrFolder(); });

    // openPdf は 1 ファイル目までしか呼ばれていない
    expect(openCalls).toEqual(['/folder/a.pdf']);
    expect(savePdf).toHaveBeenCalledTimes(1);
    // 保存失敗トーストが出ている
    expect(toasts.some((t) => t.err === true && /保存に失敗/.test(t.msg))).toBe(true);
    // ループ中止後にキャンセル toast が出る
    expect(toasts.some((t) => t.msg.includes('キャンセル'))).toBe(true);
  });

  it('issue #48: フォルダ OCR は savePdf が true を返したら次の PDF へ進む', async () => {
    const openDialogMock = (await import('@tauri-apps/plugin-dialog')).open as ReturnType<typeof vi.fn>;
    openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') return ['/folder/a.pdf', '/folder/b.pdf'];
      if (cmd === 'run_ocr') {
        return JSON.stringify({
          status: 'ok',
          blocks: [{ text: 'OK', bbox: { x: 0, y: 0, width: 5, height: 5 },
            writingMode: 'horizontal', confidence: 1 }],
        });
      }
      return '';
    });

    const openCalls: string[] = [];
    const openPdf = async (filePath: string) => {
      openCalls.push(filePath);
      usePecoStore.getState().setDocument({
        filePath,
        fileName: filePath.split('/').pop()!,
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, {
          pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null,
        }]]),
      });
      return true;
    };
    const savePdf = vi.fn(async () => true);

    const { result } = renderHook(() => useOcrEngine(() => {}, { openPdf, savePdf }));
    await act(async () => { await result.current.runOcrFolder(); });

    // 2 ファイル全て処理される
    expect(openCalls).toEqual(['/folder/a.pdf', '/folder/b.pdf']);
    expect(savePdf).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────
  // #71 (regression of #50): /Rotate 90 ページの OCR 結果 BB は viewport 空間のまま保持する
  // (旧 #50 では useOcrEngine 側で PDF user space に変換していたが、pdfSaver が viewport-y を
  //  仮定して描画していたため R=90/180/270 で位置がページ外へ飛んでいた。
  //  修正後: bbox は viewport のまま、pdfSaver が page.getRotation() を読んで cm で補正。)
  // ─────────────────────────────────────────────────────────────
  it('issue #71: /Rotate 90 ページの OCR 結果 BB は viewport 空間のまま store に入る', async () => {
    // 入力 BB (rotated viewport, scale=1.0): x=10, y=10, w=20, h=30
    // 修正前: convertToPdfPoint で PDF user space に変換 → x=10, y=10, w=30, h=20
    // 修正後: viewport 座標のまま → x=10, y=10, w=20, h=30
    const rotated = makeMockPdf(1, { width: 595, height: 842, rotation: 90 });
    h.openFreshPdfDocMock.mockResolvedValue(rotated);
    h.getCachedPageProxyMock.mockResolvedValue(makeMockPage(595, 842, 90));

    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'R', bbox: { x: 10, y: 10, width: 20, height: 30 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    const bb = p0.textBlocks[0].bbox;
    // viewport 座標そのまま (w/h スワップなし)
    expect(bb.x).toBeCloseTo(10, 6);
    expect(bb.y).toBeCloseTo(10, 6);
    expect(bb.width).toBeCloseTo(20, 6);
    expect(bb.height).toBeCloseTo(30, 6);
  });

  it('issue #71: /Rotate 0 ページの OCR 結果 BB も viewport 空間のまま保持する (y 軸反転なし)', async () => {
    // 入力 BB (viewport): x=10, y=10, w=20, h=30
    // 修正前: y 軸反転で y=802 へ変換
    // 修正後: viewport 座標のまま (y=10)
    const unrotated = makeMockPdf(1, { width: 595, height: 842, rotation: 0 });
    h.openFreshPdfDocMock.mockResolvedValue(unrotated);

    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'U', bbox: { x: 10, y: 10, width: 20, height: 30 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const bb = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].bbox;
    expect(bb.x).toBeCloseTo(10, 6);
    expect(bb.y).toBeCloseTo(10, 6);
    expect(bb.width).toBeCloseTo(20, 6);
    expect(bb.height).toBeCloseTo(30, 6);
  });

  // ─────────────────────────────────────────────────────────────
  // #102: 全ページ OCR 中に「同じ filePath のまま document 参照だけ差し替わった」
  // (= F5/Ctrl+O で再ロード) ケースで、古い OCR 結果が新 doc に書き込まれないこと。
  // 旧実装は filePath 一致のみで isCurrentDocument を判定していたため汚染が起きた。
  // 修正後: doc reference identity で判定。
  // ─────────────────────────────────────────────────────────────
  it('issue #102: OCR 中に同 filePath で document 参照が差し替わったら新 doc に書き込まれない', async () => {
    const initialDoc = makeDoc(3);
    usePecoStore.getState().setDocument(initialDoc);
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));
    h.askMock.mockResolvedValue(true);

    // 1 ページ目処理完了直後に、同じ filePath '/t.pdf' のまま別オブジェクトに差し替え。
    let processed = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      processed++;
      await new Promise((r) => setTimeout(r, 0));
      if (processed === 1) {
        // F5 相当: 同 filePath のまま新 PecoDocument にすり替え (reference identity が変わる)
        const reloadedDoc = makeDoc(3);
        usePecoStore.getState().setDocument(reloadedDoc);
      }
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: `P${processed}`, bbox: { x: 0, y: 0, width: 10, height: 10 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    await act(async () => { await result.current.runOcrAllPages(); });

    // 新 doc (現在の document) には何も書き込まれていない
    const liveDoc = usePecoStore.getState().document!;
    expect(liveDoc).not.toBe(initialDoc);
    for (let i = 0; i < liveDoc.totalPages; i++) {
      const page = liveDoc.pages.get(i);
      expect(page?.textBlocks ?? []).toHaveLength(0);
    }

    // 別 PDF への切替を検知して中断 toast が出ている
    expect(toasts.some((t) => t.msg.includes('別のPDF'))).toBe(true);
  });

  // ── #191: 範囲指定 OCR ──────────────────────────────────────────────────────

  describe('#191 runOcrOnRegion', () => {
    function makeOffscreenCanvas(w: number, h: number): HTMLCanvasElement {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }

    it('正常系: クロップ画像を run_ocr に渡して新規 BB が追加される', async () => {
      usePecoStore.getState().setDocument(makeDoc(1));
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        return JSON.stringify({
          status: 'ok',
          blocks: [
            { text: '範囲テキスト', bbox: { x: 0, y: 0, width: 50, height: 20 }, writingMode: 'horizontal', confidence: 0.9 },
          ],
        });
      });

      const toasts: Array<{ msg: string; err?: boolean }> = [];
      const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

      const canvas = makeOffscreenCanvas(400, 600);
      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 100, y: 200, width: 80, height: 40 }, 0, 100);
      });

      expect(h.invokeMock).toHaveBeenCalledWith('run_ocr', expect.objectContaining({ imageBytes: expect.any(Array) }));
      const runOcrArgs = h.invokeMock.mock.calls.find(([cmd]) => cmd === 'run_ocr')?.[1] as Record<string, unknown>;
      expect(runOcrArgs.imagePath).toBeUndefined();
      expect(h.writeFileMock).not.toHaveBeenCalled();
      expect(h.removeMock).not.toHaveBeenCalled();

      const p0 = usePecoStore.getState().document!.pages.get(0)!;
      expect(p0.textBlocks).toHaveLength(1);
      expect(p0.textBlocks[0].text).toBe('範囲テキスト');
      expect(p0.isDirty).toBe(true);

      expect(toasts.some((t) => !t.err && t.msg.includes('範囲指定OCR'))).toBe(true);
    });

    it('座標オフセット: OCR 結果 bbox に rect の左上 offset が加算される', async () => {
      usePecoStore.getState().setDocument(makeDoc(1));
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        return JSON.stringify({
          status: 'ok',
          blocks: [
            { text: 'O', bbox: { x: 10, y: 5, width: 20, height: 10 }, writingMode: 'horizontal', confidence: 1 },
          ],
        });
      });

      const { result } = renderHook(() => useOcrEngine(() => {}));
      const canvas = makeOffscreenCanvas(400, 600);
      // zoom=100, rect.x=50, rect.y=100 → offset = {x: 50, y: 100}
      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 50, y: 100, width: 60, height: 30 }, 0, 100);
      });

      const p0 = usePecoStore.getState().document!.pages.get(0)!;
      expect(p0.textBlocks[0].bbox.x).toBeCloseTo(60); // 10 + 50
      expect(p0.textBlocks[0].bbox.y).toBeCloseTo(105); // 5 + 100
    });

    it('ページデータなしの場合はエラー toast が出て invoke 呼ばれない', async () => {
      const doc = makeDoc(1);
      usePecoStore.getState().setDocument(doc);
      // pages から page 0 を削除して未ロード状態をシミュレート
      doc.pages.delete(0);
      usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);

      const toasts: Array<{ msg: string; err?: boolean }> = [];
      const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
      const canvas = makeOffscreenCanvas(400, 600);

      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 10, y: 10, width: 40, height: 20 }, 0, 100);
      });

      expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
      expect(toasts.some((t) => t.err === true)).toBe(true);
    });

    it('OCR 結果が 0 件のとき「テキストが検出されなかった」toast が出る', async () => {
      usePecoStore.getState().setDocument(makeDoc(1));
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        return JSON.stringify({ status: 'ok', blocks: [] });
      });

      const toasts: Array<{ msg: string; err?: boolean }> = [];
      const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
      const canvas = makeOffscreenCanvas(400, 600);

      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 10, y: 10, width: 40, height: 20 }, 0, 100);
      });

      const p0 = usePecoStore.getState().document!.pages.get(0)!;
      expect(p0.textBlocks).toHaveLength(0);
      expect(toasts.some((t) => !t.err && t.msg.includes('検出されませんでした'))).toBe(true);
    });

    it('既存 textBlocks に追記 (上書きしない)', async () => {
      const existingBlock = {
        id: 'existing-1', text: 'existing', originalText: 'existing',
        bbox: { x: 0, y: 0, width: 100, height: 20 },
        writingMode: 'horizontal' as const, order: 0, isNew: false, isDirty: false,
      };
      const doc = makeDoc(1);
      doc.pages.get(0)!.textBlocks = [existingBlock];
      usePecoStore.getState().setDocument(doc);
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        return JSON.stringify({
          status: 'ok',
          blocks: [
            { text: '新規', bbox: { x: 0, y: 0, width: 30, height: 10 }, writingMode: 'horizontal', confidence: 1 },
          ],
        });
      });

      const { result } = renderHook(() => useOcrEngine(() => {}));
      const canvas = makeOffscreenCanvas(400, 600);

      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 60, height: 30 }, 0, 100);
      });

      const p0 = usePecoStore.getState().document!.pages.get(0)!;
      expect(p0.textBlocks).toHaveLength(2);
      expect(p0.textBlocks[0].text).toBe('existing');
      expect(p0.textBlocks[1].text).toBe('新規');
    });

    it('PCT-046 同根バグ: pageData.width=0 のとき getCachedPageProxy 経由の有効な寸法が run_ocr に渡される', async () => {
      // pageData の width/height を 0 にして store にセット
      const pages = new Map<number, import('../../types').PageData>();
      pages.set(0, {
        pageIndex: 0,
        width: 0,
        height: 0,
        textBlocks: [],
        isDirty: false,
        thumbnail: null,
      });
      const doc: import('../../types').PecoDocument = {
        filePath: '/zero-size-region.pdf',
        fileName: 'zero-size-region.pdf',
        totalPages: 1,
        metadata: {},
        pages,
      };
      usePecoStore.getState().setDocument(doc);
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      // getCachedPageProxy は width=612, height=792 を返す
      h.getCachedPageProxyMock.mockResolvedValue(makeMockPage(612, 792));

      let capturedRunOcrArgs: Record<string, unknown> | null = null;
      h.invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'run_ocr') {
          capturedRunOcrArgs = args ?? null;
          return JSON.stringify({
            status: 'ok',
            blocks: [
              { text: 'region', bbox: { x: 0, y: 0, width: 20, height: 10 }, writingMode: 'horizontal', confidence: 1 },
            ],
          });
        }
        return '';
      });

      const { result } = renderHook(() => useOcrEngine(() => {}));
      const canvas = makeOffscreenCanvas(612, 792);

      await act(async () => {
        await result.current.runOcrOnRegion(canvas, { x: 10, y: 10, width: 50, height: 30 }, 0, 100);
      });

      // run_ocr が呼ばれ、有効な寸法（getCachedPageProxy 由来の 612×792）が渡されること
      expect(capturedRunOcrArgs).not.toBeNull();
      expect(capturedRunOcrArgs!.pageWidth).toBe(612);
      expect(capturedRunOcrArgs!.pageHeight).toBe(792);
    });

    it('キャンセル済みなら run_ocr 完了後の範囲指定OCR結果を store に反映しない', async () => {
      usePecoStore.getState().setDocument(makeDoc(1));
      usePecoStore.setState({ currentPageIndex: 0 } as any);

      let resolveOcr: (raw: string) => void = () => {};
      const ocrStarted = new Promise<void>((resolve) => {
        h.invokeMock.mockImplementation(async (cmd: string) => {
          if (cmd !== 'run_ocr') return '';
          resolve();
          return await new Promise<string>((r) => { resolveOcr = r; });
        });
      });

      const { result } = renderHook(() => useOcrEngine(() => {}));
      const canvas = makeOffscreenCanvas(400, 600);
      const promise = result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 60, height: 30 }, 0, 100);

      await ocrStarted;
      act(() => { result.current.cancelOcr(); });
      resolveOcr(JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'CANCELLED_REGION', bbox: { x: 0, y: 0, width: 30, height: 10 }, writingMode: 'horizontal', confidence: 1 },
        ],
      }));
      await act(async () => { await promise; });

      const p0 = usePecoStore.getState().document!.pages.get(0)!;
      expect(p0.textBlocks).toHaveLength(0);
    });
  });

  it('キャンセル済みなら runOcrCurrentPage の run_ocr 完了後に結果を store に反映しない', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    let resolveOcr: (raw: string) => void = () => {};
    const ocrStarted = new Promise<void>((resolve) => {
      h.invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd !== 'run_ocr') return '';
        resolve();
        return await new Promise<string>((r) => { resolveOcr = r; });
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    const promise = result.current.runOcrCurrentPage();

    await ocrStarted;
    act(() => { result.current.cancelOcr(); });
    resolveOcr(JSON.stringify({
      status: 'ok',
      blocks: [
        { text: 'CANCELLED_CURRENT', bbox: { x: 0, y: 0, width: 10, height: 10 }, writingMode: 'horizontal', confidence: 1 },
      ],
    }));
    await act(async () => { await promise; });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
  });

  it('issue #102: runOcrCurrentPage 中に doc 参照が差し替わったら新 doc に書き込まれない', async () => {
    const initialDoc = makeDoc(1);
    usePecoStore.getState().setDocument(initialDoc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // invoke('run_ocr') の最中に doc 参照を差し替え (同じ filePath, 別オブジェクト)
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      await new Promise((r) => setTimeout(r, 0));
      const newDoc = makeDoc(1);
      usePecoStore.getState().setDocument(newDoc);
      return JSON.stringify({
        status: 'ok',
        blocks: [
          { text: 'STALE', bbox: { x: 0, y: 0, width: 10, height: 10 },
            writingMode: 'horizontal', confidence: 1 },
        ],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    await act(async () => { await result.current.runOcrCurrentPage(); });

    // 新 doc には STALE が書き込まれていない
    const liveDoc = usePecoStore.getState().document!;
    expect(liveDoc).not.toBe(initialDoc);
    const p0 = liveDoc.pages.get(0)!;
    expect(p0.textBlocks ?? []).toHaveLength(0);
    // 破棄通知の toast が出ている
    expect(toasts.some((t) => t.err === true && t.msg.includes('破棄'))).toBe(true);
  });
});

// PCT-046 回帰テスト: runOcrCurrentPage の pageWidth/pageHeight が常に有効な数値であること
describe('PCT-046 regression: runOcrCurrentPage が pageWidth/pageHeight に有効な数値を渡す', () => {
  it('pageData.width/height が 0 のとき、viewport から取得した値が run_ocr に渡される', async () => {
    // pageData の width/height を 0 にした doc をセット
    const pages = new Map<number, import('../../types').PageData>();
    pages.set(0, {
      pageIndex: 0,
      width: 0,
      height: 0,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
    });
    const doc: import('../../types').PecoDocument = {
      filePath: '/zero-size.pdf',
      fileName: 'zero-size.pdf',
      totalPages: 1,
      metadata: {},
      pages,
    };
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // openFreshPdfDoc が返す mock PDF は viewport width=595, height=842
    const pdf = makeMockPdf(1, { width: 595, height: 842 });
    h.openFreshPdfDocMock.mockResolvedValue(pdf);

    let capturedRunOcrArgs: Record<string, unknown> | null = null;
    h.invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'run_ocr') {
        capturedRunOcrArgs = args ?? null;
        return JSON.stringify({ status: 'ok', blocks: [] });
      }
      return '';
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // run_ocr が呼ばれていること
    expect(capturedRunOcrArgs).not.toBeNull();
    // pageWidth/pageHeight が有効な数値（undefined でも 0 でもない）であること
    expect(typeof capturedRunOcrArgs!.pageWidth).toBe('number');
    expect(typeof capturedRunOcrArgs!.pageHeight).toBe('number');
    expect(capturedRunOcrArgs!.pageWidth).toBeGreaterThan(0);
    expect(capturedRunOcrArgs!.pageHeight).toBeGreaterThan(0);
    // viewport の寸法が使われていること (scale=1.0 で 595×842)
    expect(capturedRunOcrArgs!.pageWidth).toBe(595);
    expect(capturedRunOcrArgs!.pageHeight).toBe(842);
  });

  it('pageData が未ロード（pages.get(0)===undefined）のとき、getCachedPageProxy 経由で取得した有効な寸法が run_ocr に渡される', async () => {
    // pages.get(0) が undefined となるケース（未ロード / LRU 退避ページ）
    // runOcrCurrentPage 先頭の getCachedPageProxy 経路を通り、合成 pageData（width=800, height=600）が使われる。
    // getPageSize のフォールバック（viewport 再取得）は踏まない（pageData.width===800>0 のため）。
    const pages = new Map<number, import('../../types').PageData>();
    const doc: import('../../types').PecoDocument = {
      filePath: '/no-page-data.pdf',
      fileName: 'no-page-data.pdf',
      totalPages: 1,
      metadata: {},
      pages,
    };
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ currentPageIndex: 0 } as any);

    // getCachedPageProxy が width=800, height=600 の viewport を返す
    h.getCachedPageProxyMock.mockResolvedValue(makeMockPage(800, 600));
    const pdf = makeMockPdf(1, { width: 800, height: 600 });
    h.openFreshPdfDocMock.mockResolvedValue(pdf);

    let capturedRunOcrArgs: Record<string, unknown> | null = null;
    h.invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'run_ocr') {
        capturedRunOcrArgs = args ?? null;
        return JSON.stringify({ status: 'ok', blocks: [] });
      }
      return '';
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // run_ocr が呼ばれていること
    expect(capturedRunOcrArgs).not.toBeNull();
    // getCachedPageProxy 経由の合成 pageData（width=800, height=600）がそのまま渡されること
    expect(capturedRunOcrArgs!.pageWidth).toBe(800);
    expect(capturedRunOcrArgs!.pageHeight).toBe(600);
  });
});
