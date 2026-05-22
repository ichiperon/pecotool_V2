// ページ切替時の再レンダリングを回避するビットマップキャッシュ (2層LRU)
const MAX_PAGES = 20;
const MAX_ZOOMS_PER_PAGE = 5;
const MAX_BITMAP_CACHE_BYTES = 256 * 1024 * 1024;

function safeClose(bitmap: ImageBitmap) {
  try {
    bitmap.close();
  } catch {
    // 既にclose済み等は無視
  }
}

type Entry = { bitmap: ImageBitmap; zoom: number; width: number; height: number };

// 外側LRU: document/page key -> 内側LRU: zoom -> Entry
const pageMap = new Map<string, Map<number, Entry>>();
const entryBytes = new WeakMap<Entry, number>();
let totalBytes = 0;

function estimateBytes(entry: Entry): number {
  const width = Number.isFinite(entry.width) ? entry.width : entry.bitmap.width;
  const height = Number.isFinite(entry.height) ? entry.height : entry.bitmap.height;
  return Math.max(0, Math.ceil(width) * Math.ceil(height) * 4);
}

function evictEntry(entry: Entry) {
  const bytes = entryBytes.get(entry) ?? estimateBytes(entry);
  totalBytes = Math.max(0, totalBytes - bytes);
  entryBytes.delete(entry);
  safeClose(entry.bitmap);
}

function evictPage(pageKey: string) {
  const zoomMap = pageMap.get(pageKey);
  pageMap.delete(pageKey);
  if (zoomMap) {
    for (const e of zoomMap.values()) evictEntry(e);
  }
}

function parseKey(key: string): { pageKey: string; zoom: number } | null {
  const idx = key.lastIndexOf(':');
  if (idx < 0) return null;
  const pageKey = key.slice(0, idx);
  const zoom = Number(key.slice(idx + 1));
  if (!pageKey || !Number.isFinite(zoom)) return null;
  return { pageKey, zoom };
}

export function getBitmapCache(key: string): Entry | undefined {
  const parsed = parseKey(key);
  if (!parsed) return undefined;
  const zoomMap = pageMap.get(parsed.pageKey);
  if (!zoomMap) return undefined;
  const entry = zoomMap.get(parsed.zoom);
  if (entry) {
    // LRU bump: ページ・ズーム両方
    pageMap.delete(parsed.pageKey);
    pageMap.set(parsed.pageKey, zoomMap);
    zoomMap.delete(parsed.zoom);
    zoomMap.set(parsed.zoom, entry);
  }
  return entry;
}

export function setBitmapCache(key: string, entry: Entry) {
  const parsed = parseKey(key);
  if (!parsed) return;
  let zoomMap = pageMap.get(parsed.pageKey);
  if (!zoomMap) {
    zoomMap = new Map();
    pageMap.set(parsed.pageKey, zoomMap);
  } else {
    // ページLRUバンプ
    pageMap.delete(parsed.pageKey);
    pageMap.set(parsed.pageKey, zoomMap);
    // 同じズームの既存エントリを破棄
    const existing = zoomMap.get(parsed.zoom);
    if (existing) {
      evictEntry(existing);
      zoomMap.delete(parsed.zoom);
    }
  }
  const bytes = estimateBytes(entry);
  entryBytes.set(entry, bytes);
  totalBytes += bytes;
  zoomMap.set(parsed.zoom, entry);

  // 内側LRU上限を超えたら最古ズームを退避
  while (zoomMap.size > MAX_ZOOMS_PER_PAGE) {
    const oldestZoom = zoomMap.keys().next().value as number;
    const evicted = zoomMap.get(oldestZoom);
    zoomMap.delete(oldestZoom);
    if (evicted) evictEntry(evicted);
  }

  // 外側LRU上限を超えたら最古ページのズーム変種を一括退避
  while (pageMap.size > MAX_PAGES) {
    const oldestPage = pageMap.keys().next().value as string;
    evictPage(oldestPage);
  }

  while (totalBytes > MAX_BITMAP_CACHE_BYTES && pageMap.size > 0) {
    const oldestPage = pageMap.keys().next().value as string;
    evictPage(oldestPage);
  }
}

export function clearBitmapCache() {
  for (const zoomMap of pageMap.values()) {
    for (const entry of zoomMap.values()) evictEntry(entry);
  }
  pageMap.clear();
  totalBytes = 0;
}
