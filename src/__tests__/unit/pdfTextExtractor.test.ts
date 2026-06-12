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
// In-memory simulate IDB cache for cache-key-isolation test.
const __mockCache = new Map<string, any>();
vi.mock('../../utils/pdfTemporaryStorage', () => ({
  getCachedPage: vi.fn(async (key: string) => __mockCache.get(key) ?? null),
  setCachedPage: vi.fn(async (key: string, data: any) => { __mockCache.set(key, data); }),
  getTemporaryPageData: vi.fn(async () => null),
}));
vi.mock('../../utils/perfLogger', () => ({
  perf: { mark: vi.fn() },
}));

import { loadPage, shouldUseSavedMeta } from '../../utils/pdfTextExtractor';
import { getCachedPageProxy } from '../../utils/pdfLoader';
import { getTemporaryPageData } from '../../utils/pdfTemporaryStorage';

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

describe('loadPage bboxMeta vs pdfjs fallback (#99 主因リグレッション)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __mockCache.clear();
    vi.mocked(getTemporaryPageData).mockResolvedValue(null);
  });

  it('savedMeta が渡されたとき、pdfjs fallback (ascent*1.16 経路) ではなく meta の bbox.y がそのまま採用される', async () => {
    // pdfjs textItems 経路は item.height=12, thickness*1.16=13.92 で bbox を上方向に拡張する。
    // 同じ transform を持つ run に対して、savedMeta が与えられている場合は meta の bbox.y
    // (viewport-space で保存時に確定済み) がそのまま使われるべきで、fallback の上方拡張は
    // 起きてはならない (これが #99 主因のずれの正体)。
    const viewport: ViewportLike = {
      width: 595,
      height: 842,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    };
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        // PDF 座標 (100, 100) で transform [12,0,0,12,100,100] → viewport y は 842-100=742
        // fallback では ascent=12*1.16=13.92 を加算して bbox.y が変動する。
        { str: 'Hello', transform: [12, 0, 0, 12, 100, 100], width: 40, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    // 保存時の viewport-space bbox は (x=100, y=720, w=40, h=20) と仮定 (実際の OCR/編集後の値)
    const savedMeta = {
      '0': [
        {
          bbox: { x: 100, y: 720, width: 40, height: 20 },
          writingMode: 'horizontal',
          order: 0,
          text: 'Hello',
        },
      ],
    };

    const result = await loadPage(null as any, 0, '/tmp/test-meta-vs-fallback.pdf', savedMeta);
    expect(result.textBlocks).toHaveLength(1);
    // meta 経路: bbox は savedMeta の値そのまま
    expect(result.textBlocks[0].bbox).toEqual({ x: 100, y: 720, width: 40, height: 20 });
    expect(result.textBlocks[0].text).toBe('Hello');
  });

  it('savedMeta なし (fallback) で bboxMeta 経路の bbox.y と差がある = 旧バグの発生条件', async () => {
    // この差が #99 主因。
    // 修正で usePageNavigation 側が meta を await するため、初回再読込でも savedMeta が
    // 渡される (fallback には落ちない) のが正解。
    const viewport: ViewportLike = {
      width: 595,
      height: 842,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    };
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Hello', transform: [12, 0, 0, 12, 100, 100], width: 40, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    // 同 PDF を meta なしで loadPage (これが旧 fire-and-forget 経路で起きていた状況)
    const fallbackResult = await loadPage(null as any, 0, '/tmp/test-fallback-only.pdf');
    expect(fallbackResult.textBlocks).toHaveLength(1);
    // fallback は viewport-space で ascent (thickness*1.16=13.92) を上方拡張するので、
    // bbox.y は保存メタの y=720 と一致しない (上方にずれる)。
    // この乖離が再読込で発生していたのが #99 のメカニズム。
    const fbBbox = fallbackResult.textBlocks[0].bbox;
    // 旧バグの数値特性をピン留め: fallback の bbox.height は ascent*1.16 = ~13.92 ≈ 14
    // → height ≈ 13.92 で 12 (item.height) より上方拡張されている
    expect(fbBbox.height).toBeGreaterThan(12);
    expect(fbBbox.height).toBeCloseTo(12 * 1.16, 5);
  });

  it('meta キャッシュキー分離: 同 pageIndex でも meta 有無で別エントリ', async () => {
    // 同一ファイル/同一ページに対して、最初に fallback (meta なし) でロード → 次に meta 付きで
    // ロードしたとき、fallback の結果が IDB キャッシュに残っていて meta 経路の結果が
    // 復活する固着問題を防ぐ。pdfTextExtractor 内で cacheKey に `m1`/`m0` を mix-in する。
    const viewport: ViewportLike = {
      width: 595,
      height: 842,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    };
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'Z', transform: [12, 0, 0, 12, 50, 50], width: 12, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);

    // 1st: meta なし
    const r1 = await loadPage(null as any, 0, '/tmp/cache-isolation.pdf');
    const fbHeight = r1.textBlocks[0].bbox.height;

    // 2nd: meta あり (異なる bbox を意図的に指定)
    const savedMeta = {
      '0': [
        { bbox: { x: 50, y: 50, width: 12, height: 12 }, writingMode: 'horizontal', order: 0, text: 'Z' },
      ],
    };
    const r2 = await loadPage(null as any, 0, '/tmp/cache-isolation.pdf', savedMeta);
    expect(r2.textBlocks[0].bbox.height).toBe(12); // meta の値そのまま
    expect(r2.textBlocks[0].bbox.height).not.toBeCloseTo(fbHeight, 5); // fallback と異なる
  });

  it('PCT-025: source page と display page が異なる場合、IDB 一時変更は display page index で読む', async () => {
    const viewport: ViewportLike = {
      width: 595,
      height: 842,
      convertToViewportPoint: (x: number, y: number) => [x, 842 - y],
    };
    const pageProxy = makeMockPageProxy({
      viewport,
      textItems: [
        { str: 'SOURCE_TEXT', transform: [12, 0, 0, 12, 100, 100], width: 80, height: 12 },
      ],
    });
    vi.mocked(getCachedPageProxy).mockResolvedValue(pageProxy);
    // PCT-104: pdfTextExtractor は pageIdForIdb = 'src:${pageIndex}' で呼ぶ
    // pageIndex=2（source）の場合、pageId は 'src:2'
    vi.mocked(getTemporaryPageData).mockImplementation(async (_filePath: string, pageId: string) => (
      pageId === 'src:2'
        ? {
            pageIndex: 2,
            textBlocks: [{
              id: 'display-edit',
              text: 'DISPLAY_EDIT',
              originalText: 'DISPLAY_EDIT',
              bbox: { x: 1, y: 2, width: 3, height: 4 },
              writingMode: 'horizontal',
              order: 0,
              isNew: false,
              isDirty: true,
            }],
            isDirty: true,
            isTextExtracted: true,
            ocrCleared: false,
          }
        : null
    ));

    const result = await loadPage(null as any, 2, '/tmp/reordered-display-idb.pdf', null, undefined, { displayPageIndex: 0 });

    expect(getCachedPageProxy).toHaveBeenCalledWith('/tmp/reordered-display-idb.pdf', 2);
    // PCT-104: pageId 形式 'src:N' (source pageIndex ベース) で呼ばれる
    expect(getTemporaryPageData).toHaveBeenCalledWith('/tmp/reordered-display-idb.pdf', 'src:2');
    expect(getTemporaryPageData).not.toHaveBeenCalledWith('/tmp/reordered-display-idb.pdf', 'src:0');
    expect(result.textBlocks[0].text).toBe('DISPLAY_EDIT');
  });
});

describe('loadPage writing mode detection (#39)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __mockCache.clear();
    vi.mocked(getTemporaryPageData).mockResolvedValue(null);
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

// ---------------------------------------------------------------------------
// #347: shouldUseSavedMeta の境界値テスト
// 閾値: threshold = Math.max(nonEmptyTextItemCount * 2, nonEmptyTextItemCount + 25)
// savedMeta.length <= threshold → true（メタ経路採用）
// ---------------------------------------------------------------------------

/**
 * テスト用の最小限 PecoToolBBoxMetaEntry を生成するヘルパー
 */
function makeSavedMetaEntries(count: number): Array<{
  bbox: { x: number; y: number; width: number; height: number };
  writingMode: string;
  order: number;
  text: string;
}> {
  return Array.from({ length: count }, (_, i) => ({
    bbox: { x: 10 * i, y: 10, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: i,
    text: `block-${i}`,
  }));
}

/**
 * pdfjs TextItem を模した最小限オブジェクトを生成するヘルパー（非空の str のみ）
 */
function makeTextItems(count: number): Array<{ str: string }> {
  return Array.from({ length: count }, (_, i) => ({ str: `item-${i}` }));
}

describe('#347 shouldUseSavedMeta 境界値テスト（閾値 Math.max(count*2, count+25)）', () => {
  // --- count=0 の特殊ケース ---
  // threshold = Math.max(0, 25) = 25
  // nonEmptyTextItemCount=0 のとき: savedMeta が非空なら true を返す（pdfjs が何も返さない PDF でも meta を使う）

  it('count=0 特殊ケース: textItems が空で savedMeta が非空 → true（pdfjs が無テキスト PDF）', () => {
    const savedMeta = makeSavedMetaEntries(1);
    const textItems = makeTextItems(0);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  it('count=0 特殊ケース: savedMeta が空 → false（meta なしは false）', () => {
    const textItems = makeTextItems(0);
    expect(shouldUseSavedMeta([], textItems as any)).toBe(false);
  });

  it('count=0 特殊ケース: savedMeta が undefined → false', () => {
    const textItems = makeTextItems(0);
    expect(shouldUseSavedMeta(undefined as any, textItems as any)).toBe(false);
  });

  // --- count=24 の境界: threshold = Math.max(48, 49) = 49 ---
  // count+25 が効く側。savedMeta.length <= 49 → true

  it('count=24: savedMeta.length=49（閾値ちょうど）→ true', () => {
    const savedMeta = makeSavedMetaEntries(49);
    const textItems = makeTextItems(24);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  it('count=24: savedMeta.length=50（閾値+1）→ false', () => {
    const savedMeta = makeSavedMetaEntries(50);
    const textItems = makeTextItems(24);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(false);
  });

  it('count=24: savedMeta.length=48（閾値-1）→ true', () => {
    const savedMeta = makeSavedMetaEntries(48);
    const textItems = makeTextItems(24);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  // --- count=25 の境界: threshold = Math.max(50, 50) = 50 ---
  // count*2 と count+25 が等しくなる境界点。savedMeta.length <= 50 → true

  it('count=25: savedMeta.length=50（閾値ちょうど・count*2=count+25 の境界点）→ true', () => {
    const savedMeta = makeSavedMetaEntries(50);
    const textItems = makeTextItems(25);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  it('count=25: savedMeta.length=51（閾値+1）→ false', () => {
    const savedMeta = makeSavedMetaEntries(51);
    const textItems = makeTextItems(25);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(false);
  });

  it('count=25: savedMeta.length=49（閾値-1）→ true', () => {
    const savedMeta = makeSavedMetaEntries(49);
    const textItems = makeTextItems(25);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  // --- count=100: threshold = Math.max(200, 125) = 200 ---
  // count*2 が効く側（count > 25 で count*2 > count+25 になる）。savedMeta.length <= 200 → true

  it('count=100: savedMeta.length=200（閾値ちょうど・count*2 が効く側）→ true', () => {
    const savedMeta = makeSavedMetaEntries(200);
    const textItems = makeTextItems(100);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  it('count=100: savedMeta.length=201（閾値+1）→ false', () => {
    const savedMeta = makeSavedMetaEntries(201);
    const textItems = makeTextItems(100);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(false);
  });

  it('count=100: savedMeta.length=199（閾値-1）→ true', () => {
    const savedMeta = makeSavedMetaEntries(199);
    const textItems = makeTextItems(100);
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  // --- count=100: count+25=125 が threshold にならない（count*2=200 が大きい）確認 ---
  // savedMeta.length=126（count+25+1）でも threshold=200 以下なので true になるはず

  it('count=100: savedMeta.length=126（count+25+1）→ true（count*2=200 が threshold なので通過する）', () => {
    const savedMeta = makeSavedMetaEntries(126);
    const textItems = makeTextItems(100);
    // threshold = max(200, 125) = 200。126 <= 200 → true
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });

  // --- 典型的な正常ケース: savedMeta が textItems と同数 ---

  it('典型ケース: savedMeta.length = textItems.length（同数）→ true', () => {
    const savedMeta = makeSavedMetaEntries(10);
    const textItems = makeTextItems(10);
    // threshold = max(20, 35) = 35。10 <= 35 → true
    expect(shouldUseSavedMeta(savedMeta as any, textItems as any)).toBe(true);
  });
});
