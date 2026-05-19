/**
 * Issue #39: pdfTextExtractor.loadPage の writing mode 判定回帰テスト。
 *
 * 旧実装は viewport.convertToViewportPoint を介してスクリーン座標で
 * `|vDirY - origin.y| > |vDirX - origin.x|` を比較していたため、
 * /Rotate 270 のページでは PDF 上 horizontal な run が screen 上で
 * 軸入れ替えにより vertical 扱いされる逆転バグがあった。
 *
 * 修正: writing mode は PDF user space の (ux, uy) だけで判定する
 *   (Math.abs(uy) > Math.abs(ux) ⇒ vertical)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/pdfLoader', () => ({
  getCachedPageProxy: vi.fn(),
}));
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  getCachedPage: vi.fn(async () => null),
  setCachedPage: vi.fn(async () => undefined),
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

/**
 * /Rotate 270 を模した viewport: PDF 座標 (x, y) → screen 座標は (y, w - x) に近い変換
 * (時計回り 90° の場合に相当). 細部の符号は実装依存だが、軸が入れ替わるという特徴は
 * 共通なので writing mode 判定が screen-space 比較なら逆転する。
 */
function makeRotated270Viewport(pdfW = 595, pdfH = 842): ViewportLike {
  // 270° rotation: PDF (x, y) → screen (y, pdfW - x). screen の (w, h) は (pdfH, pdfW) に入れ替わる。
  const w = pdfH;
  const h = pdfW;
  return {
    width: w,
    height: h,
    convertToViewportPoint: (x: number, y: number): [number, number] => [y, pdfW - x],
  };
}

function makeMockPageProxy(opts: {
  viewport: ViewportLike;
  textItems: Array<{ str: string; transform: number[]; width: number; height: number }>;
}) {
  return {
    getViewport: ({ scale: _scale }: { scale: number }) => opts.viewport,
    getTextContent: async () => ({ items: opts.textItems }),
  } as any;
}

describe('loadPage writing mode detection (#39)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('回転 270° ページで PDF 上 horizontal な run は horizontal 判定される', async () => {
    // PDF user space で transform = [12, 0, 0, 12, 100, 100] → run direction (1, 0) = horizontal
    const viewport = makeRotated270Viewport(595, 842);
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Hello', transform: [12, 0, 0, 12, 100, 100], width: 40, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test.pdf');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0].writingMode).toBe('horizontal');
  });

  it('回転 270° ページで PDF 上 vertical な run は vertical 判定される', async () => {
    // 縦書き: transform = [0, -12, 12, 0, 200, 700] → run direction (0, -1) = vertical
    const viewport = makeRotated270Viewport(595, 842);
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'あ', transform: [0, -12, 12, 0, 200, 700], width: 12, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test-vert.pdf');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0].writingMode).toBe('vertical');
  });

  it('回転なしページ (0°) でも horizontal/vertical が正しく分類される', async () => {
    const viewport: ViewportLike = {
      width: 595,
      height: 842,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    };
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'horiz', transform: [12, 0, 0, 12, 100, 100], width: 40, height: 12 },
        { str: 'vert',  transform: [0, -12, 12, 0, 300, 500], width: 12, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    const result = await loadPage(null as any, 0, '/tmp/test-mixed.pdf');
    expect(result.textBlocks).toHaveLength(2);
    expect(result.textBlocks[0].writingMode).toBe('horizontal');
    expect(result.textBlocks[1].writingMode).toBe('vertical');
  });
});
