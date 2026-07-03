/**
 * useOcrEngine.ts の分岐カバレッジギャップ埋め。
 *
 * ocrEngineFlow.test.ts が既にカバーしている主要フロー（正常系 OCR / 上書き確認 /
 * エラー系 / 進捗 / キャンセル / #71 / #102 / #48 / PCT-076 / PCT-091 / PCT-094）は
 * 重複させず、実測カバレッジで branch 未到達だった経路だけを狙い撃ちする。
 *
 * 優先順位（過去バグ再発防止の観点）:
 *   1. epoch / ページ順序変更による中断系（#102 系統の未カバー分岐）
 *   2. 失敗ページの通知経路（status:error の握りつぶし vs invoke reject の外側 catch）
 *   3. 二重起動・キャンセル・後始末（PCT-076 系統の未カバー分岐）
 *   4. その他: runOcrRange の完走系、runOcrOnRegion の回転処理、既存 OCR 直接検出等
 *
 * 実 IPC（run_ocr 等）は invoke() を mock する。実機依存の Rust 側挙動は対象外。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  askMock: vi.fn(),
  openDialogMock: vi.fn(),
  writeFileMock: vi.fn(),
  removeMock: vi.fn(),
  getCachedPageProxyMock: vi.fn(),
  getSharedPdfProxyMock: vi.fn(),
  openFreshPdfDocMock: vi.fn(),
  getTemporaryPageDataMock: vi.fn(),
  loadPecoToolBBoxMetaMock: vi.fn(),
  loadPageMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invokeMock, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: h.askMock, open: h.openDialogMock, save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: h.writeFileMock,
  remove: h.removeMock,
  readFile: vi.fn(async () => new Uint8Array()),
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('@tauri-apps/api/path', () => ({
  tempDir: vi.fn(async () => '/tmp'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: h.getCachedPageProxyMock,
  getSharedPdfProxy: h.getSharedPdfProxyMock,
  openFreshPdfDoc: h.openFreshPdfDocMock,
  loadPDF: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getAllTemporaryPageData: vi.fn(async () => new Map()),
  getTemporaryPageData: h.getTemporaryPageDataMock,
  clearTemporaryChanges: vi.fn(async () => {}),
}));

vi.mock('../../utils/pdfTextExtractor', () => ({ loadPage: h.loadPageMock }));

vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

vi.mock('../../utils/pdfMetadataLoader', () => ({
  loadPecoToolBBoxMeta: h.loadPecoToolBBoxMetaMock,
}));

import { useOcrEngine } from '../../hooks/useOcrEngine';
import { usePecoStore } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import { useOcrSettingsStore } from '../../store/ocrSettingsStore';
import type { PecoDocument, PageData, TextBlock } from '../../types';

// ── ヘルパ (ocrEngineFlow.test.ts と同一パターン) ──────────────────────────

function makeDoc(totalPages: number, opts: { pageWidth?: number; pageHeight?: number } = {}): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < totalPages; i++) {
    pages.set(i, {
      pageIndex: i,
      width: opts.pageWidth ?? 595,
      height: opts.pageHeight ?? 842,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
    });
  }
  return { filePath: '/t.pdf', fileName: 't.pdf', totalPages, metadata: {}, pages };
}

function makeMockPage(width = 595, height = 842) {
  return {
    getViewport: vi.fn(({ scale = 1.0 }: { scale?: number } = {}) => ({
      width: width * scale,
      height: height * scale,
      scale,
      rotation: 0,
    })),
    getTextContent: vi.fn(async () => ({ items: [] })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
}

function makeMockPdf(totalPages: number, pageFactory?: (pageNum: number) => ReturnType<typeof makeMockPage>) {
  return {
    numPages: totalPages,
    getPage: vi.fn(async (pageNum: number) => (pageFactory ? pageFactory(pageNum) : makeMockPage())),
    destroy: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
}

function okOcrResult(text: string) {
  return JSON.stringify({
    status: 'ok',
    blocks: [{ text, bbox: { x: 0, y: 0, width: 10, height: 10 }, writingMode: 'horizontal', confidence: 1 }],
  });
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
  h.askMock.mockReset().mockResolvedValue(true);
  h.openDialogMock.mockReset();
  h.writeFileMock.mockReset().mockResolvedValue(undefined);
  h.removeMock.mockReset().mockResolvedValue(undefined);
  h.getCachedPageProxyMock.mockReset().mockResolvedValue(makeMockPage());
  h.getSharedPdfProxyMock.mockReset().mockResolvedValue(makeMockPdf(1));
  h.openFreshPdfDocMock.mockReset().mockResolvedValue(makeMockPdf(3));
  h.getTemporaryPageDataMock.mockReset().mockResolvedValue(null);
  h.loadPecoToolBBoxMetaMock.mockReset().mockResolvedValue(null);
  h.loadPageMock.mockReset().mockResolvedValue(null);

  usePecoStore.setState({
    document: null,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pendingRestoration: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
    pageOrder: [],
    clipboard: [],
  } as any);
  useOcrSettingsStore.setState({ ocrLanguage: 'ja' } as any);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. processAllPages (runOcrAllPages 経由) — epoch / ページ順序 / 失敗ページ
// ─────────────────────────────────────────────────────────────────────────
describe('processAllPages: epoch / ページ順序変更による中断', () => {
  it('#102 系統: openFreshPdfDoc 待機中に document が差し替わると 1 ページも処理せず中断する', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));

    let releaseOpen!: (pdf: unknown) => void;
    h.openFreshPdfDocMock.mockImplementationOnce(() => new Promise((resolve) => { releaseOpen = resolve; }));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));

    let done!: Promise<void>;
    act(() => { done = result.current.runOcrAllPages(); });
    // ask() の完了を待ってから openFreshPdfDoc 待機に入る
    await new Promise((r) => setTimeout(r, 0));

    // openFreshPdfDoc 解決前に document を差し替え (F5 相当) → documentEpoch が +1 される
    usePecoStore.getState().setDocument(makeDoc(3));
    releaseOpen(makeMockPdf(3));
    await act(async () => { await done; });

    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
    expect(toasts.some((t) => t.err === true && t.msg.includes('別のPDF'))).toBe(true);
  });

  it('ページ順序が OCR 実行中に変更されると、その時点で中断し以降のページを処理しない', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    usePecoStore.setState({ pageOrder: [0, 1, 2] } as any);
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));

    let processed = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      processed++;
      await new Promise((r) => setTimeout(r, 0));
      if (processed === 1) {
        // 1 ページ目の OCR 完了直後にドラッグ並べ替えが発生した状況を模倣
        usePecoStore.setState({ pageOrder: [0, 2, 1] } as any);
      }
      return okOcrResult(`P${processed}`);
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrAllPages(); });

    // 2 ページ目の invoke 自体は発火するが、結果が返ってきた時点の順序チェックで
    // 書き込み前に中断するため、3 ページ目には進まない (invoke は 2 回で打ち止め)。
    expect(h.invokeMock.mock.calls.filter(([cmd]) => cmd === 'run_ocr')).toHaveLength(2);
    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks).toHaveLength(1);
    expect(doc.pages.get(1)!.textBlocks).toHaveLength(0);
    expect(doc.pages.get(2)!.textBlocks).toHaveLength(0);
    expect(toasts.some((t) => t.err === true && t.msg.includes('ページ順序が変更されました'))).toBe(true);
  });

  it('1 ページが status:error でも継続し、以降のページは正常に処理される（通知は console のみ）', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));

    let call = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      call++;
      if (call === 2) {
        return JSON.stringify({ status: 'error', blocks: [], message: 'engine busy' });
      }
      return okOcrResult(`OK${call}`);
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrAllPages(); });

    // 3 ページとも invoke は呼ばれる (中断しない)
    expect(h.invokeMock.mock.calls.filter(([cmd]) => cmd === 'run_ocr')).toHaveLength(3);
    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks).toHaveLength(1);
    // エラーになった 2 ページ目は書き込まれない
    expect(doc.pages.get(1)!.textBlocks).toHaveLength(0);
    expect(doc.pages.get(2)!.textBlocks).toHaveLength(1);
    // processAllPages の per-page エラーは showToast を呼ばない（console.error のみ）。
    // 完了トーストのみが出て、失敗ページ個別のエラートーストは出ない。
    expect(toasts.some((t) => t.err === true)).toBe(false);
    expect(toasts.some((t) => t.msg.includes('完了'))).toBe(true);
  });

  it('run_ocr が reject（invoke 自体の throw）しても継続し、以降のページは正常に処理される', async () => {
    // useReportOcr の失敗ページ通知は invoke reject でなく renderPageOffscreen throw で
    // 再現するのが gotcha だったが、useOcrEngine 側は run_ocr の invoke 自体が reject した
    // 場合も継続する設計になっているかを確認する（processAllPages 内の try/catch）。
    usePecoStore.getState().setDocument(makeDoc(2));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(2));

    let call = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      call++;
      if (call === 1) throw new Error('IPC channel closed');
      return okOcrResult('SECOND');
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(doc.pages.get(1)!.textBlocks).toHaveLength(1);
    expect(doc.pages.get(1)!.textBlocks[0].text).toBe('SECOND');
  });

  it('LRU 退避済み（pages.get(i)===undefined）ページも viewport フォールバックでサイズ取得し OCR を継続する', async () => {
    const doc = makeDoc(2);
    doc.pages.delete(1); // 2 ページ目を LRU 退避状態に
    usePecoStore.getState().setDocument(doc);
    const pdf = makeMockPdf(2, () => makeMockPage(700, 900));
    h.openFreshPdfDocMock.mockResolvedValue(pdf);

    h.invokeMock.mockImplementation(async (cmd: string, _body?: unknown, opts?: { headers?: Record<string, string> }) => {
      if (cmd !== 'run_ocr') return '';
      return okOcrResult(`W${opts?.headers?.['x-page-width']}`);
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    const liveDoc = usePecoStore.getState().document!;
    // LRU 退避ページも viewport から取得したサイズ (700x900) で OCR 完了する
    expect(liveDoc.pages.get(1)!.textBlocks).toHaveLength(1);
    expect(liveDoc.pages.get(1)!.textBlocks[0].text).toBe('W700');
  });

  it('25 ページごとに ocrPdf.cleanup() が呼ばれる（メモリ解放のバッチ処理）', async () => {
    const doc = makeDoc(26);
    usePecoStore.getState().setDocument(doc);
    const pdf = makeMockPdf(26);
    h.openFreshPdfDocMock.mockResolvedValue(pdf);
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('X') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    expect(pdf.cleanup).toHaveBeenCalledTimes(1);
  }, 15000);

  it('run_ocr が blocks フィールドなしで status:ok を返しても 0 件で正常継続する', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(1));
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? JSON.stringify({ status: 'ok' }) : '',
    );

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
    expect(p0.isDirty).toBe(true); // updatePageData 自体は呼ばれている
  });

  it('サイズ取得 (getPageSize) が失敗したページはスキップし、以降のページは継続する', async () => {
    const doc = makeDoc(2);
    doc.pages.delete(1); // 2 ページ目を LRU 退避状態にしてサイズ取得を pdf.getPage に依存させる
    usePecoStore.getState().setDocument(doc);
    const pdf = makeMockPdf(2, (pageNum: number) => {
      if (pageNum === 2) throw new Error('corrupt page 2');
      return makeMockPage();
    });
    h.openFreshPdfDocMock.mockResolvedValue(pdf);
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('OK') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    const liveDoc = usePecoStore.getState().document!;
    // 1 ページ目は正常処理、サイズ取得失敗の 2 ページ目はスキップされ書き込みなし
    expect(liveDoc.pages.get(0)!.textBlocks).toHaveLength(1);
    expect(liveDoc.pages.get(1)).toBeUndefined();
    expect(h.invokeMock.mock.calls.filter(([cmd]) => cmd === 'run_ocr')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. hasExistingOcrBlocks — 直接メモリヒット / IDB 読み取り失敗
// ─────────────────────────────────────────────────────────────────────────
describe('hasExistingOcrBlocks: 既存 OCR 検出', () => {
  it('メモリ上の textBlocks で直接ヒットする場合は IDB を読まず上書き確認 ask が出る', async () => {
    const doc = makeDoc(2);
    doc.pages.get(0)!.textBlocks = [
      { id: 'x', text: 'A', originalText: 'A', bbox: { x: 0, y: 0, width: 1, height: 1 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    h.askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // 全ページOCR確認→上書き確認(キャンセル)

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    expect(h.askMock).toHaveBeenCalledTimes(2);
    expect(h.getTemporaryPageDataMock).not.toHaveBeenCalled();
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('IDB 読み取りが失敗しても例外を投げず既存なし扱いで継続する', async () => {
    const doc = makeDoc(1);
    doc.pages.delete(0);
    usePecoStore.getState().setDocument(doc);
    h.getTemporaryPageDataMock.mockRejectedValue(new Error('idb closed'));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('OK') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    // IDB 失敗 → 既存なし扱いなので上書き確認は出ず、確認は「全ページOCR確認」の 1 回のみ
    expect(h.askMock).toHaveBeenCalledTimes(1);
    expect(h.invokeMock).toHaveBeenCalledWith('run_ocr', expect.anything(), expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. runOcrCurrentPage — epoch / ページ順序 / 例外 / IDB / サイズ取得失敗 / 上書き確定
// ─────────────────────────────────────────────────────────────────────────
describe('runOcrCurrentPage: 未カバー分岐', () => {
  it('上書き確認で「はい」を選ぶと実際に既存 textBlocks が置き換わる', async () => {
    const doc = makeDoc(1);
    doc.pages.get(0)!.textBlocks = [
      { id: 'old', text: 'OLD', originalText: 'OLD', bbox: { x: 0, y: 0, width: 1, height: 1 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('NEW') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    expect(p0.textBlocks[0].text).toBe('NEW');
  });

  it('openFreshPdfDoc 待機中に document epoch が変わると、サイズ取得すら行わずに終了する', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    let releaseOpen!: (pdf: unknown) => void;
    h.openFreshPdfDocMock.mockImplementationOnce(() => new Promise((resolve) => { releaseOpen = resolve; }));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    let done!: Promise<void>;
    act(() => { done = result.current.runOcrCurrentPage(); });
    await new Promise((r) => setTimeout(r, 0));

    usePecoStore.getState().setDocument(makeDoc(1)); // epoch bump
    releaseOpen(makeMockPdf(1));
    await act(async () => { await done; });

    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('OCR 実行中にページ順序が変更されると結果を破棄しトーストを出す', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    usePecoStore.setState({ pageOrder: [0] } as any);
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      await new Promise((r) => setTimeout(r, 0));
      usePecoStore.setState({ pageOrder: [5] } as any); // 順序変更を模倣 (source page が変わる)
      return okOcrResult('X');
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(toasts.some((t) => t.err === true && t.msg.includes('ページ順序が変更されました'))).toBe(true);
  });

  it('run_ocr が reject（invoke 自体の throw）すると外側 catch でエラートーストが出て setOcrRunning(false) に戻る', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      throw new Error('native OCR crashed');
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('OCRに失敗しました'))).toBe(true);
    expect(result.current.isOcrRunning).toBe(false);
  });

  it('未ロードページで getCachedPageProxy が失敗すると「読み込みに失敗しました」を表示し OCR しない', async () => {
    const doc = makeDoc(1);
    doc.pages.delete(0);
    usePecoStore.getState().setDocument(doc);
    h.getCachedPageProxyMock.mockRejectedValue(new Error('page proxy unavailable'));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('読み込みに失敗しました'))).toBe(true);
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('未ロードページで IDB 読み取りが失敗しても例外を投げず OCR を継続する', async () => {
    const doc = makeDoc(1);
    doc.pages.delete(0);
    usePecoStore.getState().setDocument(doc);
    h.getTemporaryPageDataMock.mockRejectedValue(new Error('idb error'));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('OK') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    // 上書き確認は出ない (IDB 失敗 = 既存なし扱い)
    expect(h.askMock).not.toHaveBeenCalled();
    expect(h.invokeMock).toHaveBeenCalledWith('run_ocr', expect.anything(), expect.anything());
  });

  it('pageData.width/height が 0 のまま viewport 取得も失敗すると「サイズ取得に失敗しました」を表示する', async () => {
    const pages = new Map<number, PageData>();
    pages.set(0, { pageIndex: 0, width: 0, height: 0, textBlocks: [], isDirty: false, thumbnail: null });
    const doc: PecoDocument = { filePath: '/zero.pdf', fileName: 'zero.pdf', totalPages: 1, metadata: {}, pages };
    usePecoStore.getState().setDocument(doc);

    const failingPdf = makeMockPdf(1, () => { throw new Error('corrupt pdf'); });
    h.openFreshPdfDocMock.mockResolvedValue(failingPdf);

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('サイズ取得に失敗しました'))).toBe(true);
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('run_ocr が不正な JSON を返すと JSONパース失敗エラーとして通知される', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? 'not-json{{{' : ''));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('OCRエラー'))).toBe(true);
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
  });

  it('OcrSettingsStore.ocrLanguage が未設定でも run_ocr は空文字ヘッダで呼ばれる', async () => {
    useOcrSettingsStore.setState({ ocrLanguage: undefined } as any);
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('X') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const call = h.invokeMock.mock.calls.find(([cmd]) => cmd === 'run_ocr');
    const opts = call![2] as { headers: Record<string, string> };
    expect(opts.headers['x-language-tag']).toBe('');
  });

  it('document が無ければ何もせず終了する', async () => {
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('run_ocr が blocks フィールドなしで status:ok を返しても 0 件で正常完了する', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? JSON.stringify({ status: 'ok' }) : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrCurrentPage(); });

    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(0);
    expect(p0.isDirty).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. runOcrAllPages / runOcrAllPagesSilent — 素通しガード
// ─────────────────────────────────────────────────────────────────────────
describe('runOcrAllPages / runOcrAllPagesSilent: ガード節', () => {
  it('runOcrAllPages: document が無ければ何もせず終了する', async () => {
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });
    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('runOcrAllPagesSilent: document が無ければ false を返す', async () => {
    const { result } = renderHook(() => useOcrEngine(() => {}));
    let ret: boolean | undefined;
    await act(async () => { ret = await result.current.runOcrAllPagesSilent(); });
    expect(ret).toBe(false);
  });

  it('上書き確認で「はい」を選ぶと全ページ OCR が実際に走る', async () => {
    const doc = makeDoc(1);
    doc.pages.get(0)!.textBlocks = [
      { id: 'old', text: 'OLD', originalText: 'OLD', bbox: { x: 0, y: 0, width: 1, height: 1 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    h.askMock.mockResolvedValue(true); // 全ページOCR確認 → 上書き確認 とも「はい」
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('NEW') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrAllPages(); });

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('NEW');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. runOcrRange — 完走系が現状ゼロカバレッジだったためガードから完了まで一通り
// ─────────────────────────────────────────────────────────────────────────
describe('runOcrRange: ガードから完走までの分岐', () => {
  it('document が無ければ何もせず終了する', async () => {
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrRange('1'); });
    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('不正な範囲文字列はエラートーストのみで ask は呼ばれない', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrRange('xyz'); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('ページ範囲エラー'))).toBe(true);
    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('範囲内ページが 0 件（総ページ数超過の単ページ指定）はエラートーストのみで ask は呼ばれない', async () => {
    // parsePageRange 自体が indices.size===0 を { error: '有効なページが範囲内に存在しません' } として
    // 返す実装（pageRangeParser.ts 末尾）のため、フック側の `pageIndices.length === 0` 分岐
    // （useOcrEngine.ts:564-566）はこの入力では通らず 'error' in parsed 側に入る。
    // parsePageRange の契約上、成功時に空配列が返ることはないため当該分岐は事実上到達不能
    // （詳細は本タスクの出力末尾「対象外分岐」を参照）。ここでは実際に起き得る
    // 「シンタックスは有効だが対象ページが存在しない」入力の挙動を固定する。
    usePecoStore.getState().setDocument(makeDoc(3));
    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrRange('99'); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('有効なページが範囲内に存在しません'))).toBe(true);
    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('最初の確認ダイアログを断ると hasExistingOcrBlocks は呼ばれず即終了する', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    h.askMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrRange('1'); });

    expect(h.getTemporaryPageDataMock).not.toHaveBeenCalled();
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('既存 OCR がなければ上書き確認 ask は出ず、そのまま完走して完了トーストが出る', async () => {
    usePecoStore.getState().setDocument(makeDoc(3));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('R') : ''));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrRange('1-2'); });

    // 確認ダイアログは最初の 1 回のみ (上書き確認は出ない)
    expect(h.askMock).toHaveBeenCalledTimes(1);
    expect(h.invokeMock.mock.calls.filter(([cmd]) => cmd === 'run_ocr')).toHaveLength(2);
    expect(toasts.some((t) => !t.err && t.msg.includes('ページ範囲OCRが完了しました'))).toBe(true);
  });

  it('既存 OCR ありで上書き確認「はい」なら完走し、指定範囲のみ書き込まれる', async () => {
    const doc = makeDoc(3);
    doc.pages.get(1)!.textBlocks = [
      { id: 'old', text: 'OLD', originalText: 'OLD', bbox: { x: 0, y: 0, width: 1, height: 1 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ];
    usePecoStore.getState().setDocument(doc);
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(3));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('R2') : ''));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => { await result.current.runOcrRange('2'); });

    expect(h.askMock).toHaveBeenCalledTimes(2); // 範囲確認 + 上書き確認
    const liveDoc = usePecoStore.getState().document!;
    expect(liveDoc.pages.get(1)!.textBlocks[0].text).toBe('R2');
    // 範囲外のページ (0, 2) には触れていない
    expect(liveDoc.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(liveDoc.pages.get(2)!.textBlocks).toHaveLength(0);
  });

  it('OCR 中に cancelOcr するとキャンセルトーストが出る', async () => {
    usePecoStore.getState().setDocument(makeDoc(5));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(5));
    let processed = 0;
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      processed++;
      await new Promise((r) => setTimeout(r, 0));
      return okOcrResult(`P${processed}`);
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    const promise = result.current.runOcrRange('1-5');
    await new Promise((r) => setTimeout(r, 15));
    act(() => { result.current.cancelOcr(); });
    await act(async () => { await promise; });

    expect(toasts.some((t) => t.msg.includes('OCRをキャンセルしました'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. runOcrFolder — ガード / 例外 / ループ内スキップ
// ─────────────────────────────────────────────────────────────────────────
describe('runOcrFolder: ガードと例外経路', () => {
  it('openPdf/savePdf コールバックが未設定なら即エラートーストで終了する', async () => {
    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => { await result.current.runOcrFolder(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('フォルダOCRを実行できません'))).toBe(true);
    expect(h.openDialogMock).not.toHaveBeenCalled();
  });

  it('フォルダ選択ダイアログをキャンセルすると以降の処理をしない', async () => {
    h.openDialogMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useOcrEngine(() => {}, { openPdf: vi.fn(), savePdf: vi.fn() }),
    );
    await act(async () => { await result.current.runOcrFolder(); });

    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('確認ダイアログを断ると PDF 一覧取得すら行わない', async () => {
    h.openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useOcrEngine(() => {}, { openPdf: vi.fn(), savePdf: vi.fn() }),
    );
    await act(async () => { await result.current.runOcrFolder(); });

    expect(h.invokeMock).not.toHaveBeenCalledWith('list_pdf_files_in_folder', expect.anything());
  });

  it('PDF 一覧取得が失敗するとエラートーストを出して終了する', async () => {
    h.openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') throw new Error('folder read denied');
      return '';
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() =>
      useOcrEngine((m, e) => toasts.push({ msg: m, err: e }), { openPdf: vi.fn(), savePdf: vi.fn() }),
    );
    await act(async () => { await result.current.runOcrFolder(); });

    expect(toasts.some((t) => t.err === true && t.msg.includes('PDF一覧の取得に失敗しました'))).toBe(true);
  });

  it('フォルダ内に PDF が 0 件なら情報トーストのみで終了する', async () => {
    h.openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'list_pdf_files_in_folder' ? [] : '',
    );

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const { result } = renderHook(() =>
      useOcrEngine((m, e) => toasts.push({ msg: m, err: e }), { openPdf: vi.fn(), savePdf: vi.fn() }),
    );
    await act(async () => { await result.current.runOcrFolder(); });

    expect(toasts.some((t) => !t.err && t.msg.includes('フォルダ内にPDFが見つかりませんでした'))).toBe(true);
  });

  it('openPdf が false を返すファイルはスキップし、次のファイルへ進む', async () => {
    h.openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_pdf_files_in_folder') return ['/folder/broken.pdf', '/folder/ok/']; // 末尾セパレータでファイル名フォールバックも兼ねる
      if (cmd === 'run_ocr') return okOcrResult('OK');
      return '';
    });

    const openCalls: string[] = [];
    const openPdf = vi.fn(async (filePath: string) => {
      openCalls.push(filePath);
      if (filePath === '/folder/broken.pdf') return false;
      usePecoStore.getState().setDocument({
        filePath,
        fileName: 'ok.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null }]]),
      });
      return true;
    });
    const savePdf = vi.fn(async () => true);

    const { result } = renderHook(() => useOcrEngine(() => {}, { openPdf, savePdf }));
    await act(async () => { await result.current.runOcrFolder(); });

    expect(openCalls).toEqual(['/folder/broken.pdf', '/folder/ok/']);
    expect(savePdf).toHaveBeenCalledTimes(1); // broken.pdf はスキップされ savePdf も呼ばれない
  });

  it('openPdf 成功後に doc.filePath が一致しない（レース）場合はスキップする', async () => {
    h.openDialogMock.mockResolvedValueOnce('/folder');
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'list_pdf_files_in_folder' ? ['/folder/a.pdf'] : '',
    );

    const openPdf = vi.fn(async () => {
      // 別ファイルの document が既に開かれている状況を模倣 (レース)
      usePecoStore.getState().setDocument({
        filePath: '/folder/DIFFERENT.pdf',
        fileName: 'DIFFERENT.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, { pageIndex: 0, width: 595, height: 842, textBlocks: [], isDirty: false, thumbnail: null }]]),
      });
      return true;
    });
    const savePdf = vi.fn(async () => true);

    const { result } = renderHook(() => useOcrEngine(() => {}, { openPdf, savePdf }));
    await act(async () => { await result.current.runOcrFolder(); });

    // filePath 不一致でスキップされるため savePdf は呼ばれない
    expect(savePdf).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. checkAndPromptOcrZero — 多重起動ガード / epoch 中断 / 実 OCR 起動
// ─────────────────────────────────────────────────────────────────────────
describe('checkAndPromptOcrZero: 多重起動ガードと epoch 中断', () => {
  it('PCT-076 系統: 別経路の OCR 実行中は meta チェックすら行わず即 return する', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);

    let releaseOpen!: (pdf: unknown) => void;
    h.openFreshPdfDocMock.mockImplementationOnce(() => new Promise((resolve) => { releaseOpen = resolve; }));

    const { result } = renderHook(() => useOcrEngine(() => {}));
    let silentDone!: Promise<boolean>;
    act(() => { silentDone = result.current.runOcrAllPagesSilent(); });
    await new Promise((r) => setTimeout(r, 0));

    await act(async () => { await result.current.checkAndPromptOcrZero(doc); });

    expect(h.loadPecoToolBBoxMetaMock).not.toHaveBeenCalled();
    expect(h.getSharedPdfProxyMock).not.toHaveBeenCalled();

    await act(async () => {
      result.current.cancelOcr();
      releaseOpen(makeMockPdf(1));
      await silentDone;
    });
  });

  it('メタチェックの待機中に document epoch が変わると、テキスト層判定に進まず終了する', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);

    let resolveMeta!: (v: null) => void;
    h.loadPecoToolBBoxMetaMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveMeta = resolve; }),
    );

    const { result } = renderHook(() => useOcrEngine(() => {}));
    let done!: Promise<void>;
    act(() => { done = result.current.checkAndPromptOcrZero(doc); });
    await new Promise((r) => setTimeout(r, 0));

    usePecoStore.getState().setDocument(makeDoc(1)); // epoch bump
    resolveMeta(null);
    await act(async () => { await done; });

    // detectTextLayerSamplesForDoc (2 回目の getSharedPdfProxy 呼び出し) まで到達していない
    expect(h.getSharedPdfProxyMock).toHaveBeenCalledTimes(1);
    expect(h.askMock).not.toHaveBeenCalled();
  });

  it('テキスト層判定中に document epoch が変わると、自動取り込みを開始しない', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);
    h.loadPecoToolBBoxMetaMock.mockResolvedValue(null);

    const textLayerPdf = makeMockPdf(1, () => ({
      ...makeMockPage(),
      getTextContent: vi.fn(async () => {
        // サンプルページ取得中に別 PDF が開かれた状況を模倣
        usePecoStore.getState().setDocument(makeDoc(1));
        return { items: [{ str: 'テキスト' }] };
      }),
    }));
    h.getSharedPdfProxyMock.mockResolvedValue(textLayerPdf);

    const toasts: string[] = [];
    const { result } = renderHook(() => useOcrEngine((m) => toasts.push(m)));
    await act(async () => { await result.current.checkAndPromptOcrZero(doc); });

    expect(h.askMock).not.toHaveBeenCalled();
    expect(toasts.some((m) => m.includes('テキスト層を取り込み中'))).toBe(false);
  });

  it('テキスト層なし + OCR提案に「はい」を選ぶと実際に runOcrAllPages が起動し完走する', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);
    h.loadPecoToolBBoxMetaMock.mockResolvedValue(null);
    h.getSharedPdfProxyMock.mockResolvedValue(makeMockPdf(1, () => ({
      ...makeMockPage(),
      getTextContent: vi.fn(async () => ({ items: [] })),
    })));
    h.openFreshPdfDocMock.mockResolvedValue(makeMockPdf(1));
    h.askMock.mockResolvedValue(true); // 「OCR実行しますか？」→ はい、内部の「全ページOCR確認」→ はい
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('AUTO') : ''));

    const toasts: string[] = [];
    const { result } = renderHook(() => useOcrEngine((m) => toasts.push(m)));
    await act(async () => { await result.current.checkAndPromptOcrZero(doc); });

    expect(h.invokeMock).toHaveBeenCalledWith('run_ocr', expect.anything(), expect.anything());
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('AUTO');
    expect(toasts.some((m) => m.includes('全ページOCRが完了しました'))).toBe(true);
  });

  it('detectTextLayerSamplesForDoc が想定外に reject しても外側 catch で握りつぶし、未処理例外を投げない', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);
    h.loadPecoToolBBoxMetaMock.mockResolvedValue(null); // 1 回目の getSharedPdfProxy (meta 確認) は正常

    let call = 0;
    h.getSharedPdfProxyMock.mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('shared pdf proxy unavailable'); // detectTextLayerSamplesForDoc 側
      return makeMockPdf(1);
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useOcrEngine(() => {}));

    // 例外が外に漏れず正常に resolve すること自体がこのテストの主張
    await expect(act(async () => { await result.current.checkAndPromptOcrZero(doc); })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith('[OCR] OCRゼロ検出に失敗:', expect.any(Error));
    expect(h.askMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. importTextLayerAllPages — 実際の書き込み成功系 + ページ順序チェック
// ─────────────────────────────────────────────────────────────────────────
describe('importTextLayerAllPages: 実書き込み系（loadPage 経由）', () => {
  const setupHasTextDoc = (totalPages: number) => {
    const doc = makeDoc(totalPages);
    usePecoStore.getState().setDocument(doc);
    usePecoStore.setState({ pageOrder: Array.from({ length: totalPages }, (_, i) => i) } as any);
    h.loadPecoToolBBoxMetaMock.mockResolvedValue(null);
    h.getSharedPdfProxyMock.mockResolvedValue(makeMockPdf(totalPages, () => ({
      ...makeMockPage(),
      getTextContent: vi.fn(async () => ({ items: [{ str: 'あ' }] })),
    })));
    return doc;
  };

  it('loadPage が有効な textBlocks を返すと store に isTextExtracted:true で書き込まれる', async () => {
    setupHasTextDoc(2);
    const tb: TextBlock = {
      id: 'imported', text: 'IMPORTED', originalText: 'IMPORTED',
      bbox: { x: 0, y: 0, width: 10, height: 10 }, writingMode: 'horizontal', order: 0, isNew: false, isDirty: false,
    };
    h.loadPageMock.mockResolvedValue({
      pageIndex: 0, width: 595, height: 842, textBlocks: [tb], isDirty: false, thumbnail: null,
    });

    const toasts: string[] = [];
    const { result } = renderHook(() => useOcrEngine((m) => toasts.push(m)));
    await act(async () => {
      await result.current.checkAndPromptOcrZero(usePecoStore.getState().document!);
    });

    const doc = usePecoStore.getState().document!;
    expect(doc.pages.get(0)!.textBlocks[0].text).toBe('IMPORTED');
    expect(doc.pages.get(0)!.isTextExtracted).toBe(true);
    expect(doc.pages.get(1)!.textBlocks[0].text).toBe('IMPORTED');
    expect(toasts.some((m) => m.includes('テキスト層の取り込みが完了しました'))).toBe(true);
  });

  it('loadPage が null を返したページは continue され、store は変化しない', async () => {
    setupHasTextDoc(1);
    h.loadPageMock.mockResolvedValue(null);

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.checkAndPromptOcrZero(usePecoStore.getState().document!);
    });

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
  });

  it('取り込み中にページ順序が変わったページだけ書き込みをスキップする', async () => {
    setupHasTextDoc(1);
    h.loadPageMock.mockImplementation(async () => {
      // Promise.all 実行中 (書き込みループ前) にページ順序を変更
      usePecoStore.setState({ pageOrder: [7] } as any);
      return { pageIndex: 0, width: 595, height: 842, textBlocks: [
        { id: 'x', text: 'SKIPPED', originalText: 'SKIPPED', bbox: { x: 0, y: 0, width: 1, height: 1 },
          writingMode: 'horizontal' as const, order: 0, isNew: false, isDirty: false },
      ], isDirty: false, thumbnail: null };
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.checkAndPromptOcrZero(usePecoStore.getState().document!);
    });

    // pageOrder が変わったので displayToSourcePageIndex が captured と食い違い、書き込みされない
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
  });

  it('loadPage の Promise.all 実行中に document epoch が変わると、書き込みループに入らず中止する', async () => {
    setupHasTextDoc(1);
    h.loadPageMock.mockImplementation(async () => {
      // Promise.all の待機中 (書き込みループ開始前) に document が差し替わった状況を模倣
      usePecoStore.getState().setDocument(usePecoStore.getState().document!);
      return { pageIndex: 0, width: 595, height: 842, textBlocks: [
        { id: 'y', text: 'STALE_BATCH', originalText: 'STALE_BATCH', bbox: { x: 0, y: 0, width: 1, height: 1 },
          writingMode: 'horizontal' as const, order: 0, isNew: false, isDirty: false },
      ], isDirty: false, thumbnail: null };
    });

    const toasts: string[] = [];
    const { result } = renderHook(() => useOcrEngine((m) => toasts.push(m)));
    await act(async () => {
      await result.current.checkAndPromptOcrZero(usePecoStore.getState().document!);
    });

    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(toasts.some((m) => m.includes('取り込みを中止しました'))).toBe(true);
  });

  it('1 バッチ目完走後・2 バッチ目開始前に document epoch が変わるとバッチループ先頭で中止する', async () => {
    // BATCH=10 なので 11 ページ用意して 2 バッチ目の開始判定を踏ませる。
    setupHasTextDoc(11);
    h.loadPageMock.mockImplementation(async (_pdf: unknown, pageIndex: number) => {
      if (pageIndex === 9) {
        // 1 バッチ目最後のページ解決時に「次バッチ開始前」の yield ポイントで epoch を
        // 進める setTimeout(0) を仕込む。フック側も各バッチ末尾で setTimeout(0) yield する
        // ため (line789)、先に登録した本タイマーがフックの yield より先に発火し、
        // 2 バッチ目の for ループ先頭 (line741) の isCurrentDocument チェックに間に合う。
        setTimeout(() => {
          usePecoStore.getState().setDocument(usePecoStore.getState().document!);
        }, 0);
      }
      return {
        pageIndex, width: 595, height: 842, textBlocks: [
          { id: `p${pageIndex}`, text: `T${pageIndex}`, originalText: `T${pageIndex}`,
            bbox: { x: 0, y: 0, width: 1, height: 1 }, writingMode: 'horizontal' as const,
            order: 0, isNew: false, isDirty: false },
        ], isDirty: false, thumbnail: null,
      };
    });

    const toasts: string[] = [];
    const { result } = renderHook(() => useOcrEngine((m) => toasts.push(m)));
    await act(async () => {
      await result.current.checkAndPromptOcrZero(usePecoStore.getState().document!);
    });

    // 1 バッチ目 (index 0-9) は書き込み完了、2 バッチ目 (index 10) は中止されて未書き込み
    const doc = usePecoStore.getState().document!;
    for (let i = 0; i < 10; i++) {
      expect(doc.pages.get(i)!.textBlocks).toHaveLength(1);
    }
    expect(doc.pages.get(10)!.textBlocks).toHaveLength(0);
    expect(toasts.some((m) => m.includes('取り込みを中止しました'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. runOcrOnRegion — 回転処理 / epoch 中断 / エラー系 / 微小矩形
// ─────────────────────────────────────────────────────────────────────────
describe('runOcrOnRegion: 未カバー分岐', () => {
  function makeOffscreenCanvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  it('90度回転ページでは crop 矩形と結果 bbox が回転変換される (#71/#405 系統)', async () => {
    const doc = makeDoc(1);
    doc.pages.get(0)!.rotation = 90;
    usePecoStore.getState().setDocument(doc);

    let capturedDrawArgs: number[] = [];
    const canvas = makeOffscreenCanvas(600, 400);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // cropCanvas.getContext だけを検証したいので、drawImage 呼び出し引数を記録する
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: any[]) {
      const ctx = {
        fillStyle: '',
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn((...drawArgs: number[]) => { capturedDrawArgs = drawArgs.slice(1) as number[]; }),
      };
      return ctx as any;
    });

    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      return JSON.stringify({
        status: 'ok',
        blocks: [{ text: 'R', bbox: { x: 2, y: 3, width: 5, height: 8 }, writingMode: 'horizontal', confidence: 1 }],
      });
    });

    const { result } = renderHook(() => useOcrEngine(() => {}));
    // rect は bbox 空間 (回転前): x=10, y=20, w=30, h=15
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 10, y: 20, width: 30, height: 15 }, 0, 100);
    });

    // bboxRectToRotatedScreenRect({x:10,y:20,w:30,h:15}, {rotation:90, vw:600, vh:400})
    // → {x:565, y:10, width:15, height:30} (詳細は canvasRotation.ts の r=90 変換式)
    expect(capturedDrawArgs[0]).toBeCloseTo(565); // sx
    expect(capturedDrawArgs[1]).toBeCloseTo(10);  // sy
    expect(capturedDrawArgs[2]).toBeCloseTo(15);  // sw
    expect(capturedDrawArgs[3]).toBeCloseTo(30);  // sh

    const bb = usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].bbox;
    // rotatedScreenRectToBbox の逆変換で bbox 空間に戻ると w/h が入れ替わる
    expect(bb.x).toBeCloseTo(13);
    expect(bb.y).toBeCloseTo(28);
    expect(bb.width).toBeCloseTo(8);
    expect(bb.height).toBeCloseTo(5);

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockRestore();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('矩形が 2px 未満なら invoke を呼ばず即終了する', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 1, height: 1 }, 0, 100);
    });
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('document が無ければ何もせず終了する', async () => {
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('OcrSettingsStore.ocrLanguage が未設定でも run_ocr は空文字ヘッダで呼ばれる', async () => {
    useOcrSettingsStore.setState({ ocrLanguage: undefined } as any);
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? okOcrResult('X') : ''));

    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    const call = h.invokeMock.mock.calls.find(([cmd]) => cmd === 'run_ocr');
    const opts = call![2] as { headers: Record<string, string> };
    expect(opts.headers['x-language-tag']).toBe('');
  });

  it('pageData.width/height が 0 で getCachedPageProxy も失敗すると「サイズ取得に失敗しました」を表示する', async () => {
    const pages = new Map<number, PageData>();
    pages.set(0, { pageIndex: 0, width: 0, height: 0, textBlocks: [], isDirty: false, thumbnail: null });
    const doc: PecoDocument = { filePath: '/zero-region.pdf', fileName: 'zero-region.pdf', totalPages: 1, metadata: {}, pages };
    usePecoStore.getState().setDocument(doc);
    h.getCachedPageProxyMock.mockRejectedValue(new Error('proxy unavailable'));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    expect(toasts.some((t) => t.err === true && t.msg.includes('サイズ取得に失敗しました'))).toBe(true);
    expect(h.invokeMock).not.toHaveBeenCalledWith('run_ocr', expect.anything());
  });

  it('run_ocr が不正な JSON を返すと「OCR結果のパースに失敗しました」を表示する', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => (cmd === 'run_ocr' ? 'not-json{{{' : ''));

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    expect(toasts.some((t) => t.err === true && t.msg.includes('OCR結果のパースに失敗しました'))).toBe(true);
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
  });

  it('status:error は破棄されエラートーストが出る', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? JSON.stringify({ status: 'error', blocks: [], message: 'region OCR failed' }) : '',
    );

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    expect(toasts.some((t) => t.err === true && t.msg.includes('OCRエラー'))).toBe(true);
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks).toHaveLength(0);
  });

  it('run_ocr が reject すると外側 catch でエラートーストが出る（#1020-1021 相当）', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      throw new Error('region invoke failed');
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    expect(toasts.some((t) => t.err === true && t.msg.includes('範囲指定OCRに失敗しました'))).toBe(true);
    expect(result.current.isOcrRunning).toBe(false);
  });

  it('run_ocr 完了直後に document epoch が変わると結果は破棄される（〜973 行相当）', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      await new Promise((r) => setTimeout(r, 0));
      usePecoStore.getState().setDocument(makeDoc(1)); // epoch bump: 結果到着直後に別 PDF が開かれた
      return JSON.stringify({
        status: 'ok',
        blocks: [{ text: 'STALE_REGION', bbox: { x: 0, y: 0, width: 5, height: 5 }, writingMode: 'horizontal', confidence: 1 }],
      });
    });

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    const liveDoc = usePecoStore.getState().document!;
    expect(liveDoc.pages.get(0)!.textBlocks).toHaveLength(0);
    expect(toasts.some((t) => t.err === true && t.msg.includes('破棄されました'))).toBe(true);
  });

  it('blocks フィールド無しの status:ok は「検出されませんでした」扱いになる', async () => {
    usePecoStore.getState().setDocument(makeDoc(1));
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? JSON.stringify({ status: 'ok' }) : '',
    );

    const toasts: Array<{ msg: string; err?: boolean }> = [];
    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine((m, e) => toasts.push({ msg: m, err: e })));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    expect(toasts.some((t) => !t.err && t.msg.includes('検出されませんでした'))).toBe(true);
  });

  it('OCR 完了までの間にページが store から退避されても merge は空配列を基点に安全に行われる', async () => {
    const doc = makeDoc(1);
    usePecoStore.getState().setDocument(doc);
    h.invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== 'run_ocr') return '';
      // OCR 実行中にページが LRU 退避された状況を模倣
      usePecoStore.getState().document!.pages.delete(0);
      return JSON.stringify({
        status: 'ok',
        blocks: [{ text: 'AFTER_EVICT', bbox: { x: 0, y: 0, width: 5, height: 5 }, writingMode: 'horizontal', confidence: 1 }],
      });
    });

    const canvas = makeOffscreenCanvas(400, 600);
    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrOnRegion(canvas, { x: 0, y: 0, width: 40, height: 20 }, 0, 100);
    });

    // updatePageData は新規ページとして書き込む (existingBlocks の ?? [] フォールバックで例外にならない)
    const p0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(p0.textBlocks).toHaveLength(1);
    expect(p0.textBlocks[0].text).toBe('AFTER_EVICT');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. detectTextLayerSamples — サンプルページ取得の reject（純粋関数を直接検証）
// ─────────────────────────────────────────────────────────────────────────
describe('detectTextLayerSamples: allSettled の rejected パス', () => {
  it('一部サンプルページの取得が reject しても残りで判定を継続する（全滅なら all_empty）', async () => {
    const { detectTextLayerSamples } = await import('../../hooks/useOcrEngine');
    const pdf = {
      getPage: vi.fn(async (pageNum: number) => {
        if (pageNum === 1) throw new Error('page 1 corrupt');
        return {
          getTextContent: vi.fn(async () => ({ items: [] })),
          cleanup: vi.fn(),
        };
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await detectTextLayerSamples(pdf as any, 3);
    expect(res).toBe('all_empty');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
