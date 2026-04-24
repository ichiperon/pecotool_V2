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
});
