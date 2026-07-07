import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBitmapCache, setBitmapCache, clearBitmapCache } from '../../utils/bitmapCache';

function makeBitmap(_id = 0) {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

function makeEntry(bitmap?: ImageBitmap, zoom = 1, width = 100, height = 100) {
  return { bitmap: bitmap ?? makeBitmap(), zoom, width, height };
}

describe('bitmapCache', () => {
  beforeEach(() => {
    clearBitmapCache();
  });

  it('U-BC-01: set → get returns the entry', () => {
    const entry = makeEntry();
    setBitmapCache('1:100', entry);
    expect(getBitmapCache('1:100')).toBe(entry);
  });

  it('U-BC-02: get missing key → undefined', () => {
    expect(getBitmapCache('missing')).toBeUndefined();
  });

  it('U-BC-03: 21st entry evicts oldest (limit=20)', () => {
    for (let i = 1; i <= 21; i++) {
      setBitmapCache(`${i}:100`, makeEntry());
    }
    expect(getBitmapCache('1:100')).toBeUndefined();
    expect(getBitmapCache('2:100')).toBeDefined();
    expect(getBitmapCache('21:100')).toBeDefined();
  });

  it('U-BC-04: evicted entry bitmap.close() is called', () => {
    const firstBitmap = makeBitmap();
    setBitmapCache('1:100', makeEntry(firstBitmap));
    for (let i = 2; i <= 21; i++) {
      setBitmapCache(`${i}:100`, makeEntry());
    }
    expect((firstBitmap as any).close).toHaveBeenCalledOnce();
  });

  it('U-BC-05: overwriting same key closes old bitmap first', () => {
    const oldBitmap = makeBitmap();
    setBitmapCache('1:100', makeEntry(oldBitmap));
    setBitmapCache('1:100', makeEntry());
    expect((oldBitmap as any).close).toHaveBeenCalledOnce();
  });

  it('U-BC-06: overwriting same key moves it to newest (LRU update)', () => {
    for (let i = 1; i <= 20; i++) {
      setBitmapCache(`${i}:100`, makeEntry());
    }
    // Re-set key 1 → moves to newest
    setBitmapCache('1:100', makeEntry());
    // Insert key 21 → should evict key 2 (now oldest), not key 1
    setBitmapCache('21:100', makeEntry());
    expect(getBitmapCache('1:100')).toBeDefined();
    expect(getBitmapCache('2:100')).toBeUndefined();
  });

  it('U-BC-07: clearBitmapCache calls close() on all entries', () => {
    const bitmaps = Array.from({ length: 3 }, () => makeBitmap());
    bitmaps.forEach((b, i) => setBitmapCache(`${i}:100`, makeEntry(b)));
    clearBitmapCache();
    bitmaps.forEach((b) => {
      expect((b as any).close).toHaveBeenCalledOnce();
    });
  });

  it('U-BC-08: clearBitmapCache empties cache completely', () => {
    for (let i = 0; i < 5; i++) {
      setBitmapCache(`${i}:100`, makeEntry());
    }
    clearBitmapCache();
    for (let i = 0; i < 5; i++) {
      expect(getBitmapCache(`${i}:100`)).toBeUndefined();
    }
  });

  it('U-BC-09: key format "5:150" works', () => {
    const entry = makeEntry();
    setBitmapCache('5:150', entry);
    expect(getBitmapCache('5:150')).toBe(entry);
  });

  it('U-BC-10: exactly 20 entries → no eviction', () => {
    for (let i = 1; i <= 20; i++) {
      setBitmapCache(`${i}:100`, makeEntry());
    }
    for (let i = 1; i <= 20; i++) {
      expect(getBitmapCache(`${i}:100`)).toBeDefined();
    }
  });

  it('U-BC-11: same page and zoom in different files do not collide', () => {
    const entryA = makeEntry();
    const entryB = makeEntry();

    setBitmapCache('C:\\docs\\a.pdf:0:100', entryA);
    setBitmapCache('C:\\docs\\b.pdf:0:100', entryB);

    expect(getBitmapCache('C:\\docs\\a.pdf:0:100')).toBe(entryA);
    expect(getBitmapCache('C:\\docs\\b.pdf:0:100')).toBe(entryB);
  });

  it('U-BC-12: total byte limit evicts oldest oversized footprint first', () => {
    const oldBitmap = makeBitmap();
    const newBitmap = makeBitmap();

    // Each entry: 6000 * 3000 * 4 = ~72MB. Two together = 144MB exceeds the
    // 128MB cap, so inserting `new` should evict the older `old.pdf` page.
    setBitmapCache('old.pdf:0:100', makeEntry(oldBitmap, 1, 6_000, 3_000));
    setBitmapCache('new.pdf:0:100', makeEntry(newBitmap, 1, 6_000, 3_000));

    expect(getBitmapCache('old.pdf:0:100')).toBeUndefined();
    expect(getBitmapCache('new.pdf:0:100')).toBeDefined();
    expect((oldBitmap as any).close).toHaveBeenCalledOnce();
    expect((newBitmap as any).close).not.toHaveBeenCalled();
  });

  // ── るしあ C-5: 内側 LRU (zoom) が正しいキーセグメントに効くことの回帰テスト ──
  //
  // 背景: usePdfRendering.renderCacheKey が末尾セグメントを dpr にしてしまい、
  // bitmapCache.parseKey が「末尾 = 内側 LRU キー」として dpr を拾っていた。
  // dpr は通常セッション中一定のため、内側 LRU (MAX_ZOOMS_PER_PAGE) が実質
  // 機能せず、zoom を変えるたびに外側 pageMap の別エントリを消費して他ページの
  // キャッシュを押し出していた。以下はキーが "pageKey:zoom" という正しい構造で
  // 渡されたときに、内側/外側 2 層 LRU の意図どおりの挙動を保証する。
  it('U-BC-13: 同一ページで zoom を MAX_ZOOMS_PER_PAGE(5) を超えて set しても、外側ページは 1 件のまま増えない', () => {
    for (let z = 1; z <= 8; z++) {
      setBitmapCache(`page1:${z}`, makeEntry(undefined, z));
    }
    // 内側 LRU (上限5) により最古の zoom (1,2,3) は evict 済み
    expect(getBitmapCache('page1:1')).toBeUndefined();
    expect(getBitmapCache('page1:2')).toBeUndefined();
    expect(getBitmapCache('page1:3')).toBeUndefined();
    // 直近 5 件 (4..8) は残っている
    for (let z = 4; z <= 8; z++) {
      expect(getBitmapCache(`page1:${z}`)).toBeDefined();
    }

    // page1 の zoom 連打で消費した外側スロットは 1 つだけのはず。
    // 別ページを 19 件 (=MAX_PAGES 20 に到達するちょうどの数) 追加しても、
    // page1 はまだ evict されない。
    for (let i = 1; i <= 19; i++) {
      setBitmapCache(`other${i}:100`, makeEntry());
    }
    expect(getBitmapCache('page1:8')).toBeDefined();
  });

  it('U-BC-14: 1ページの zoom 連打 (6回以上) が他ページのエントリを外側 LRU から押し出さない', () => {
    // 先に別ページを 19 件 set (外側スロットを 19 消費、MAX_PAGES=20 に余裕あり)
    for (let i = 1; i <= 19; i++) {
      setBitmapCache(`other${i}:100`, makeEntry());
    }
    // page1 の zoom を連打 (10 回)。内側 LRU で間引かれるだけで、外側スロットは
    // page1 用の 1 つしか消費しないはず。
    for (let z = 1; z <= 10; z++) {
      setBitmapCache(`page1:${z}`, makeEntry(undefined, z));
    }
    // 合計外側スロットは 19(other) + 1(page1) = 20 = MAX_PAGES ちょうどなので
    // other 系はまだ evict されていない。
    expect(getBitmapCache('other1:100')).toBeDefined();
    expect(getBitmapCache('other19:100')).toBeDefined();
    expect(getBitmapCache('page1:10')).toBeDefined();
  });

  it('U-BC-15: 単一エントリの footprint だけで MAX_TOTAL_BYTES を超える場合、挿入直後の get で取得でき close() されない', () => {
    const bitmap = makeBitmap();
    // 8000 * 5000 * 4 = 160MB > 128MB cap (単独で閾値超過)
    setBitmapCache('huge.pdf:0:100', makeEntry(bitmap, 1, 8_000, 5_000));

    expect(getBitmapCache('huge.pdf:0:100')).toBeDefined();
    expect((bitmap as any).close).not.toHaveBeenCalled();
  });
});
