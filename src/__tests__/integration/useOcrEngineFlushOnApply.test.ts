/**
 * R22狩り(交差汚染 HIGH) 修正3の再現テスト。
 *
 * OCR 結果 / テキスト層取り込みが現在ページの textBlocks を丸ごと差し替える際、
 * フォーカス中の OcrCard に未確定編集が残っていると、そのまま上書きすると
 * 編集が黙って消える (差し替え後は旧 block id が無くなるため、後続の
 * blur/unmount コミットが対象を見失って no-op になる)。
 *
 * 修正: useOcrEngine.ts の textBlocks 差し替え直前に commitActiveOcrCardEdit() を
 * 呼び、フォーカス中カードの最新テキストを store に確定させてから OCR 結果で
 * 上書きする (「OCR が上書きするのは仕様として正しい」が「編集がまず消える」のは
 * 誤り、というのが受入基準)。
 *
 * ここでは実際の pecoStore.updatePageData を spy して呼び出し順序を検証する:
 * 1. commitActiveOcrCardEdit 経由の flush 呼び出し (旧 block id + 編集後テキスト)
 * 2. OCR 結果適用の呼び出し (新しい block id 群) が (1) より後に来ること
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  askMock: vi.fn(),
  getCachedPageProxyMock: vi.fn(),
  getSharedPdfProxyMock: vi.fn(),
  openFreshPdfDocMock: vi.fn(),
  getTemporaryPageDataMock: vi.fn(),
  loadPecoToolBBoxMetaMock: vi.fn(),
  loadPageMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invokeMock, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: h.askMock, open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(),
  remove: vi.fn(),
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
vi.mock('../../utils/pdfMetadataLoader', () => ({ loadPecoToolBBoxMeta: h.loadPecoToolBBoxMetaMock }));

import { useOcrEngine } from '../../hooks/useOcrEngine';
import { usePecoStore } from '../../store/pecoStore';
import type { PecoDocument, PageData } from '../../types';

function makeDoc(): PecoDocument {
  const pages = new Map<number, PageData>();
  pages.set(0, {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [
      { id: 'old', text: 'OLD TEXT', originalText: 'OLD TEXT', bbox: { x: 0, y: 0, width: 10, height: 10 },
        writingMode: 'horizontal', order: 0, isNew: false, isDirty: false },
    ],
    isDirty: false,
    thumbnail: null,
  });
  return { filePath: '/t.pdf', fileName: 't.pdf', totalPages: 1, metadata: {}, pages };
}

function makeMockPage(width = 595, height = 842) {
  return {
    getViewport: vi.fn(({ scale = 1.0 }: { scale?: number } = {}) => ({ width: width * scale, height: height * scale, scale, rotation: 0 })),
    getTextContent: vi.fn(async () => ({ items: [] })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
}

function makeMockPdf(totalPages: number) {
  return {
    numPages: totalPages,
    getPage: vi.fn(async () => makeMockPage()),
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

// 編集中カードの DOM を再現する (実 OcrCard は使わず、flushActiveOcrCardText が
// 読む data-page-index/data-block-id/.ocr-card-content の契約だけを満たす最小要素)。
function mountFocusedEditingCard(pageIndex: number, blockId: string, editedText: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ocr-card-content';
  el.setAttribute('contenteditable', 'true');
  el.dataset.pageIndex = String(pageIndex);
  el.dataset.blockId = blockId;
  el.textContent = editedText;
  document.body.appendChild(el);
  el.focus();
  return el;
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
  h.getCachedPageProxyMock.mockReset().mockResolvedValue(makeMockPage());
  h.getSharedPdfProxyMock.mockReset().mockResolvedValue(makeMockPdf(1));
  h.openFreshPdfDocMock.mockReset().mockResolvedValue(makeMockPdf(1));
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
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('R22狩り(交差汚染 HIGH) 修正3: OCR結果適用前のフォーカス編集 flush', () => {
  it('runOcrCurrentPage: textBlocks 差し替え直前に、フォーカス中カードの未確定編集が commit されてから上書きされる', async () => {
    usePecoStore.getState().setDocument(makeDoc());
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? okOcrResult('NEW FROM OCR') : '',
    );

    const editingEl = mountFocusedEditingCard(0, 'old', 'EDITED BEFORE OCR');
    const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData');
    updateSpy.mockClear();

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrCurrentPage();
    });

    // 1) flush 呼び出し: 旧ブロック id のまま「編集後」テキストで一度 commit されている。
    const flushCallIndex = updateSpy.mock.calls.findIndex(([, patch]) =>
      Array.isArray((patch as any).textBlocks) &&
      (patch as any).textBlocks.some((b: any) => b.id === 'old' && b.text === 'EDITED BEFORE OCR'),
    );
    expect(flushCallIndex).toBeGreaterThanOrEqual(0);

    // 2) OCR 結果適用の呼び出しはその後に来る (新しい blocks で全差し替え)。
    const ocrApplyCallIndex = updateSpy.mock.calls.findIndex(([, patch]) =>
      Array.isArray((patch as any).textBlocks) &&
      (patch as any).textBlocks.some((b: any) => b.text === 'NEW FROM OCR'),
    );
    expect(ocrApplyCallIndex).toBeGreaterThan(flushCallIndex);

    // 3) 最終状態は OCR 結果のみ (上書きは仕様通り正しく行われている)。
    const finalBlocks = usePecoStore.getState().document!.pages.get(0)!.textBlocks;
    expect(finalBlocks).toHaveLength(1);
    expect(finalBlocks[0].text).toBe('NEW FROM OCR');

    editingEl.remove();
  });

  it('runOcrAllPages (processAllPages): 対象ページ適用前にも同様に flush される', async () => {
    usePecoStore.getState().setDocument(makeDoc());
    h.askMock.mockResolvedValue(true);
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? okOcrResult('NEW FROM ALL PAGES OCR') : '',
    );

    const editingEl = mountFocusedEditingCard(0, 'old', 'EDITED DURING BATCH OCR');
    const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData');
    updateSpy.mockClear();

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrAllPages();
    });

    const flushCallIndex = updateSpy.mock.calls.findIndex(([, patch]) =>
      Array.isArray((patch as any).textBlocks) &&
      (patch as any).textBlocks.some((b: any) => b.id === 'old' && b.text === 'EDITED DURING BATCH OCR'),
    );
    expect(flushCallIndex).toBeGreaterThanOrEqual(0);

    const ocrApplyCallIndex = updateSpy.mock.calls.findIndex(([, patch]) =>
      Array.isArray((patch as any).textBlocks) &&
      (patch as any).textBlocks.some((b: any) => b.text === 'NEW FROM ALL PAGES OCR'),
    );
    expect(ocrApplyCallIndex).toBeGreaterThan(flushCallIndex);

    editingEl.remove();
  });

  it('フォーカス中カードが無い場合は flush 相当の呼び出しは発生せず、OCR適用のみ行われる', async () => {
    usePecoStore.getState().setDocument(makeDoc());
    h.invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'run_ocr' ? okOcrResult('NEW NO FOCUS') : '',
    );

    const updateSpy = vi.spyOn(usePecoStore.getState(), 'updatePageData');
    updateSpy.mockClear();

    const { result } = renderHook(() => useOcrEngine(() => {}));
    await act(async () => {
      await result.current.runOcrCurrentPage();
    });

    // フォーカス無し → flush は no-op (updatePageData を呼ばない)。OCR 適用の1回のみ。
    const textBlockCalls = updateSpy.mock.calls.filter(([, patch]) => Array.isArray((patch as any).textBlocks));
    expect(textBlockCalls).toHaveLength(1);
    expect(textBlockCalls[0][1].textBlocks[0].text).toBe('NEW NO FOCUS');
  });
});
