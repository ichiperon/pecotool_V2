/**
 * Issue #112: pdfTextExtractor.loadPage の pdfjs fallback 経路 (meta なし PDF) の
 * bbox ascent が実フォントメトリクス由来であることの回帰テスト。
 *
 * 背景 (THE BUG):
 *   meta なし PDF (PecoToolBBoxes メタを持たない外部 OCR PDF の初回オープン等) では
 *   OCR BB を pdfjs textItems から再構成する。旧実装は ascent を固定係数
 *   `thickness * 1.16` で算出していた。1.16 はどの実フォントの ascent 比よりも
 *   大きく (実フォントの正規化 ascent 比は ≒0.7〜0.95)、BB が縦方向に過大膨張し
 *   上方向へずれていた。これは兄弟 issue #110 (保存側 baseline drift) の
 *   再読込/fallback 側に相当する。
 *
 * 修正 (THE FIX):
 *   pdfjs `getTextContent()` が返す `textContent.styles[fontName].ascent`
 *   (正規化済みフォント ascent 比) を使い、`thickness * style.ascent` で
 *   ascent を導く。styles が取れない / 非有限 or 非正のときだけ 1.16 にフォールバック。
 *
 * このテストは fallback 経路 (savedMeta なし) のみを対象とする。
 * meta-bearing PDF は別ブランチ (savedMeta.map) を通り ascent を使わないため
 * 本修正の影響を受けない ── それも下のケースで明示的に確認する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: vi.fn(),
}));
const __mockCache = new Map<string, any>();
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  getCachedPage: vi.fn(async (key: string) => __mockCache.get(key) ?? null),
  setCachedPage: vi.fn(async (key: string, data: any) => { __mockCache.set(key, data); }),
  getTemporaryPageData: vi.fn(async () => null),
}));
vi.mock('../../utils/perfLogger', () => ({
  perf: { mark: vi.fn() },
}));

import { loadPage } from '../../utils/pdfTextExtractor';
import { getCachedPageProxy } from '../../utils/pdfLoader';

// crypto.randomUUID polyfill (Node test env が古い場合のみ)
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  (globalThis as any).crypto = {
    ...globalThis.crypto,
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  };
}

interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

interface TextStyleLike {
  ascent: number;
  descent: number;
  vertical: boolean;
  fontFamily: string;
}

/** 回転なし (0°) viewport: PDF (x, y) → screen (x, pageH - y). */
function makeViewport(pdfW = 595, pdfH = 842): ViewportLike {
  return {
    width: pdfW,
    height: pdfH,
    convertToViewportPoint: (x: number, y: number): [number, number] => [x, pdfH - y],
  };
}

function makeMockPageProxy(opts: {
  viewport: ViewportLike;
  textItems: Array<{ str: string; transform: number[]; width: number; height: number; fontName?: string }>;
  styles?: Record<string, TextStyleLike>;
}) {
  return {
    getViewport: ({ scale: _scale }: { scale: number }) => opts.viewport,
    // pdfjs getTextContent() は items に加えて styles (fontName→TextStyle) を返す。
    getTextContent: async () => ({ items: opts.textItems, styles: opts.styles ?? {} }),
  } as any;
}

describe('loadPage pdfjs fallback ascent (#112)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __mockCache.clear();
  });

  it('fallback では bbox の ascent が固定 1.16 ではなく textContent.styles の実フォント ascent 比から導かれる', async () => {
    // viewport は y を反転するだけなので、横書き run の bbox.height は
    // PDF user space の ascent (= thickness * ascentRatio) にそのまま一致する。
    const viewport = makeViewport(595, 842);
    const thickness = 12;
    // 実フォント相当の正規化 ascent 比 (例: 0.905)。1.16 とは明確に異なる値を使う。
    const realAscentRatio = 0.905;
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Hello', transform: [thickness, 0, 0, thickness, 100, 100], width: 40, height: thickness, fontName: 'g_d0_f1' },
      ],
      styles: {
        g_d0_f1: { ascent: realAscentRatio, descent: -0.212, vertical: false, fontFamily: 'sans-serif' },
      },
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test-112-real-ascent.pdf');
    expect(result.textBlocks).toHaveLength(1);

    const h = result.textBlocks[0].bbox.height;
    // 実フォントメトリクス由来: height ≒ thickness * 0.905 = 10.86
    expect(h).toBeCloseTo(thickness * realAscentRatio, 5);
    // 回帰ガード: 旧バグの固定値 thickness * 1.16 = 13.92 ではない。
    expect(h).not.toBeCloseTo(thickness * 1.16, 3);
    // 実フォントの ascent 比は 1.0 未満なので、bbox は thickness を超えて膨張しない。
    expect(h).toBeLessThan(thickness);
  });

  it('styles が取れないフォント (styles 欠落 / fontName 不一致) では 1.16 にフォールバックする', async () => {
    const viewport = makeViewport(595, 842);
    const thickness = 12;
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        // styles に対応エントリが無い fontName
        { str: 'World', transform: [thickness, 0, 0, thickness, 100, 100], width: 40, height: thickness, fontName: 'missing_font' },
      ],
      styles: {}, // 空 = メトリクス取得不能
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test-112-fallback-default.pdf');
    expect(result.textBlocks).toHaveLength(1);
    // メトリクスが無いので従来の固定係数 1.16 を使う。
    expect(result.textBlocks[0].bbox.height).toBeCloseTo(thickness * 1.16, 5);
  });

  it('style.ascent が非正 (0 や負値) の不正フォントでも 1.16 にフォールバックする', async () => {
    const viewport = makeViewport(595, 842);
    const thickness = 12;
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Bad', transform: [thickness, 0, 0, thickness, 100, 100], width: 40, height: thickness, fontName: 'bad_font' },
      ],
      styles: {
        // ascent=0 は実フォントとしてあり得ない不正値。固定係数へフォールバックすべき。
        bad_font: { ascent: 0, descent: 0, vertical: false, fontFamily: 'sans-serif' },
      },
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test-112-nonpositive-ascent.pdf');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0].bbox.height).toBeCloseTo(thickness * 1.16, 5);
  });

  it('meta-bearing PDF は別ブランチを通り、本修正 (fallback ascent) の影響を受けない', async () => {
    // savedMeta が与えられた場合 loadPage は savedMeta.map ブランチを通り、
    // ascent / textContent.styles を一切参照しない。bbox はメタの値そのまま。
    const viewport = makeViewport(595, 842);
    const thickness = 12;
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Meta', transform: [thickness, 0, 0, thickness, 100, 100], width: 40, height: thickness, fontName: 'g_d0_f1' },
      ],
      // styles を与えても meta 経路では使われない。
      styles: {
        g_d0_f1: { ascent: 0.905, descent: -0.212, vertical: false, fontFamily: 'sans-serif' },
      },
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const savedMeta = {
      '0': [
        { bbox: { x: 100, y: 720, width: 40, height: 20 }, writingMode: 'horizontal', order: 0, text: 'Meta' },
      ],
    };
    const result = await loadPage(null as any, 0, '/tmp/test-112-meta-unaffected.pdf', savedMeta);
    expect(result.textBlocks).toHaveLength(1);
    // メタの bbox がそのまま採用される (fallback ascent ロジックは無関係)。
    expect(result.textBlocks[0].bbox).toEqual({ x: 100, y: 720, width: 40, height: 20 });
  });
});
