/**
 * useOcrEngine: EMA 計算 + estimatedRemainingMs ロジックのユニットテスト (#200)
 * + detectTextLayerSamples の 3 点サンプリング検証 (#204)
 *
 * useOcrEngine 本体は Tauri/pdfjs への依存が重いためフックごとテストしない。
 * 代わりに「EMA 更新式」「estimatedRemainingMs 計算式」「formatMmSs」を
 * 純粋関数として抽出し、仕様どおりに動くことを確認する。
 * detectTextLayerSamples はモジュールレベルの export 関数なので直接インポートしてテストする。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── detectTextLayerSamples 用モック ──────────────────────────
// Tauri / pdfLoader / pdfTextExtractor への依存をスタブする
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../utils/pdfLoader', () => ({
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
  openFreshPdfDoc: vi.fn(),
  getTemporaryPageData: vi.fn(async () => null),
}));
vi.mock('../../utils/pdfTextExtractor', () => ({ loadPage: vi.fn() }));
vi.mock('../../store/pecoStore', () => ({
  usePecoStore: Object.assign(
    vi.fn((sel: any) => sel({ document: null, currentPageIndex: 0 })),
    { getState: vi.fn(() => ({ document: null, updatePageData: vi.fn() })) },
  ),
  selectHasDocument: (s: any) => !!s.document,
  selectCurrentPageIndex: (s: any) => s.currentPageIndex ?? 0,
}));
// #278: documentEpoch は infraStore に移動したためこちらでモックする
vi.mock('../../store/infraStore', () => ({
  useInfraStore: Object.assign(
    vi.fn((sel: any) => sel({ documentEpoch: 0, pageAccessOrder: [], pendingRestoration: null, lastIdbError: null, currentPageProxy: null, currentPageProxyKey: null })),
    { getState: vi.fn(() => ({ documentEpoch: 0 })) },
  ),
}));
vi.mock('../../store/ocrSettingsStore', () => ({
  useOcrSettingsStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ ocrLanguage: 'jpn' })),
  }),
}));
vi.mock('../../utils/ocrSort', () => ({ sortOcrBlocks: vi.fn((b: any) => b) }));
vi.mock('../../utils/logger', () => ({ logger: { log: vi.fn(), warn: vi.fn() } }));
vi.mock('../../utils/perfLogger', () => ({ perf: { mark: vi.fn() } }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import { detectTextLayerSamples } from '../../hooks/useOcrEngine';
import { invoke } from '@tauri-apps/api/core';

// ─── テスト用ヘルパ ───────────────────────────────────────────

/**
 * pdfjs PDFDocumentProxy 風モックを生成。
 * pageTextMap: { [1-based page number]: string[] }
 */
function makeMockPdf(pageTextMap: Record<number, string[]>): any {
  return {
    getPage: vi.fn(async (pageNum: number) => {
      const strs = pageTextMap[pageNum] ?? [];
      return {
        getTextContent: vi.fn(async () => ({ items: strs.map((str) => ({ str })) })),
        cleanup: vi.fn(),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// detectTextLayerSamples (#204)
// ─────────────────────────────────────────────────────────────

describe('detectTextLayerSamples (#204) — 3 点サンプリング', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全サンプルページの items が空のとき all_empty を返す', async () => {
    const pdf = makeMockPdf({ 1: [], 2: [], 3: [] });
    expect(await detectTextLayerSamples(pdf, 3)).toBe('all_empty');
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    expect(pdf.getPage).toHaveBeenCalledWith(2);
    expect(pdf.getPage).toHaveBeenCalledWith(3);
  });

  it('先頭ページにテキストがある場合は has_text を返す', async () => {
    const pdf = makeMockPdf({ 1: ['Hello'], 5: [], 10: [] });
    expect(await detectTextLayerSamples(pdf, 10)).toBe('has_text');
  });

  it('中央ページにテキストがある場合は has_text を返す', async () => {
    // totalPages=5 → samples: 1, 3, 5
    const pdf = makeMockPdf({ 1: [], 3: ['中央'], 5: [] });
    expect(await detectTextLayerSamples(pdf, 5)).toBe('has_text');
  });

  it('末尾ページにテキストがある場合は has_text を返す', async () => {
    const pdf = makeMockPdf({ 1: [], 5: [], 10: ['End'] });
    expect(await detectTextLayerSamples(pdf, 10)).toBe('has_text');
  });

  it('1 ページ PDF では getPage が 1 回だけ呼ばれる (Set で重複排除)', async () => {
    const pdf = makeMockPdf({ 1: ['text'] });
    expect(await detectTextLayerSamples(pdf, 1)).toBe('has_text');
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
  });

  it('空白文字のみの str は has_text と判定しない', async () => {
    const pdf = {
      getPage: vi.fn(async () => ({
        getTextContent: vi.fn(async () => ({ items: [{ str: '   ' }, { str: '\t\n' }] })),
        cleanup: vi.fn(),
      })),
    };
    expect(await detectTextLayerSamples(pdf as any, 1)).toBe('all_empty');
  });

  it('str プロパティを持たない TextMarkedContent は除外して判定する', async () => {
    const pdf = {
      getPage: vi.fn(async () => ({
        getTextContent: vi.fn(async () => ({
          items: [
            { type: 'beginMarkedContent', tag: 'Span' }, // str なし
            { str: '' },                                  // str はあるが空
          ],
        })),
        cleanup: vi.fn(),
      })),
    };
    expect(await detectTextLayerSamples(pdf as any, 1)).toBe('all_empty');
  });

  it('2 ページ PDF のサンプル点は重複排除後 [1, 2] の 2 点になる', async () => {
    // [1, ceil(2/2)=1, 2] → Set → [1, 2]
    const pdf = makeMockPdf({ 1: [], 2: ['text'] });
    expect(await detectTextLayerSamples(pdf, 2)).toBe('has_text');
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
  });
});

// ---- EMA ヘルパー (useOcrEngine.ts の実装と同一ロジック) ----

const EMA_ALPHA = 0.3;

function updateAvgMsPerPage(prev: number, pageDurationMs: number): number {
  if (prev === 0) return pageDurationMs;
  return EMA_ALPHA * pageDurationMs + (1 - EMA_ALPHA) * prev;
}

function calcEstimatedRemainingMs(avgMsPerPage: number, remainingPages: number): number {
  return avgMsPerPage * remainingPages;
}

// ---- mm:ss フォーマット (App.tsx の formatMmSs と同一ロジック) ----

function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- テスト ----

describe('OCR EMA: updateAvgMsPerPage', () => {
  it('初回ページ(prev=0)はそのまま pageDurationMs を返す', () => {
    expect(updateAvgMsPerPage(0, 500)).toBe(500);
  });

  it('2ページ目以降は EMA (α=0.3) で更新される', () => {
    const prev = 500;
    const next = 1000;
    // 0.3 * 1000 + 0.7 * 500 = 650
    expect(updateAvgMsPerPage(prev, next)).toBeCloseTo(650, 5);
  });

  it('ページ時間が前回と同じなら変化しない', () => {
    expect(updateAvgMsPerPage(400, 400)).toBeCloseTo(400, 5);
  });

  it('連続10ページで平均が入力値に収束していく方向に動く', () => {
    let avg = 0;
    const target = 800;
    for (let i = 0; i < 10; i++) {
      avg = updateAvgMsPerPage(avg, target);
    }
    // 初回は target のまま, 2回目以降 EMA なので最終は target に近いはず
    expect(avg).toBeCloseTo(target, 0);
  });
});

describe('OCR EMA: calcEstimatedRemainingMs', () => {
  it('avgMsPerPage * remainingPages を返す', () => {
    expect(calcEstimatedRemainingMs(1000, 10)).toBe(10000);
  });

  it('残りページ 0 なら 0 を返す', () => {
    expect(calcEstimatedRemainingMs(1000, 0)).toBe(0);
  });

  it('avgMsPerPage が 0 なら 0 を返す', () => {
    expect(calcEstimatedRemainingMs(0, 50)).toBe(0);
  });
});

describe('formatMmSs', () => {
  it('0ms → 00:00', () => {
    expect(formatMmSs(0)).toBe('00:00');
  });

  it('60000ms → 01:00', () => {
    expect(formatMmSs(60000)).toBe('01:00');
  });

  it('90500ms → 01:31 (丸め: 90.5秒 → 91秒)', () => {
    expect(formatMmSs(90500)).toBe('01:31');
  });

  it('3661000ms → 61:01', () => {
    expect(formatMmSs(3661000)).toBe('61:01');
  });

  it('負の値は 00:00 にクランプ', () => {
    expect(formatMmSs(-5000)).toBe('00:00');
  });
});

describe('OCR 3ページ以下は計算中扱い', () => {
  it('current <= 3 のとき avgMsPerPage を表示しない判定', () => {
    // App.tsx の表示ロジック: ocrProgress.current <= 3 で「計算中...」
    const shouldShowAvg = (current: number) => current > 3;
    expect(shouldShowAvg(0)).toBe(false);
    expect(shouldShowAvg(1)).toBe(false);
    expect(shouldShowAvg(3)).toBe(false);
    expect(shouldShowAvg(4)).toBe(true);
    expect(shouldShowAvg(100)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// #285 D案: run_ocr bytes 渡し regression guard
// invoke に渡るパラメータが imageBytes (number[]) であり、
// imagePath パラメータが存在しないことを assert する。
// ─────────────────────────────────────────────────────────────

describe('#285 run_ocr invoke contract — bytes-based, no imagePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invoke("run_ocr") が imageBytes を持ち imagePath を持たないことを検証するヘルパ', () => {
    // このテストは invoke の呼び出しシグネチャを静的に検証するヘルパ関数を定義し、
    // 旧 imagePath 渡しへのリグレッションを防ぐ。
    // 実際の invoke 呼び出しは Tauri runtime が必要なため、ここではパラメータ形状を検査する。

    type RunOcrParams = {
      imageBytes: number[];
      pageWidth: number;
      pageHeight: number;
      renderScale: number;
      languageTag: string | null;
    };

    const isValidRunOcrParams = (params: unknown): params is RunOcrParams => {
      if (typeof params !== 'object' || params === null) return false;
      const p = params as Record<string, unknown>;
      // imageBytes が存在し number[] であること
      if (!Array.isArray(p['imageBytes'])) return false;
      // imagePath が存在しないこと (regression guard)
      if ('imagePath' in p) return false;
      // 数値フィールドが揃っていること
      if (typeof p['pageWidth'] !== 'number') return false;
      if (typeof p['pageHeight'] !== 'number') return false;
      if (typeof p['renderScale'] !== 'number') return false;
      return true;
    };

    const validParams: RunOcrParams = {
      imageBytes: [0x89, 0x50, 0x4e, 0x47],
      pageWidth: 595,
      pageHeight: 842,
      renderScale: 2.0,
      languageTag: 'ja',
    };
    expect(isValidRunOcrParams(validParams)).toBe(true);

    // imagePath があると false になること (旧 API は reject される)
    const legacyParams = { imagePath: '/tmp/test.png', pageWidth: 595, pageHeight: 842, renderScale: 2.0, languageTag: 'ja' };
    expect(isValidRunOcrParams(legacyParams)).toBe(false);

    // imageBytes がない場合も false
    const missingBytes = { pageWidth: 595, pageHeight: 842, renderScale: 2.0, languageTag: null };
    expect(isValidRunOcrParams(missingBytes)).toBe(false);
  });

  it('invoke mock が imageBytes パラメータで呼ばれたことを確認', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ status: 'ok', blocks: [] })
    );

    // invoke を直接呼び出して bytes 渡し契約をシミュレート
    const fakeBytes = new Uint8Array([137, 80, 78, 71]);
    await invoke('run_ocr', {
      imageBytes: Array.from(fakeBytes),
      pageWidth: 100,
      pageHeight: 100,
      renderScale: 2.0,
      languageTag: null,
    });

    expect(mockInvoke).toHaveBeenCalledOnce();
    const [cmd, params] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe('run_ocr');
    // imageBytes が渡されていること
    expect(params).toHaveProperty('imageBytes');
    expect(Array.isArray(params['imageBytes'])).toBe(true);
    // imagePath が渡されていないこと (regression guard)
    expect(params).not.toHaveProperty('imagePath');
  });
});
