import { PageData } from '../types';

// IndexedDB cache for OCR results and temporary edits
const DB_NAME = 'peco_ocr_cache';
const STORE_NAME = 'pages';
const STORE_NAME_DIRTY = 'temporary_changes'; // New store for un-saved edits
const PAGE_CACHE_MAX_ENTRIES = 800;
const PAGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const PAGE_CACHE_PRUNE_WRITE_INTERVAL = 25;

// DB接続を一度だけ開いて使い回す
let dbPromise: Promise<IDBDatabase> | null = null;
let pageCacheWritesSincePrune = PAGE_CACHE_PRUNE_WRITE_INTERVAL;
let openingPruneStarted = false;

type CachedPageRecord = PageData & {
  __pecotoolCacheUpdatedAt?: number;
  __pecotoolCacheBytes?: number;
};

type CachedPageSummary = {
  key: IDBValidKey;
  updatedAt: number;
  bytes: number;
};

// JSON.stringify は大規模 textBlocks で実測 10ms 級になり setCachedPage の
// 書き込み毎に走る。textBlocks 1 件 ≒ 256byte (text + bbox + 属性) + メタ overhead
// として推定する近似値で代替する。pruneCachedPages の閾値比較は近似値同士の
// 比較なので絶対精度より一貫した単位の方が重要。
const HEURISTIC_BYTES_PER_TEXT_BLOCK = 256;
const HEURISTIC_RECORD_OVERHEAD = 1024;
function estimateCachedPageBytes(record: CachedPageRecord): number {
  const blockCount = Array.isArray(record.textBlocks) ? record.textBlocks.length : 0;
  return blockCount * HEURISTIC_BYTES_PER_TEXT_BLOCK + HEURISTIC_RECORD_OVERHEAD;
}

function stripCacheMetadata(record: CachedPageRecord): PageData {
  const { __pecotoolCacheUpdatedAt, __pecotoolCacheBytes, ...pageData } = record;
  void __pecotoolCacheUpdatedAt;
  void __pecotoolCacheBytes;
  return pageData;
}

function withCacheMetadata(data: PageData, updatedAt: number): CachedPageRecord {
  const record: CachedPageRecord = { ...data, thumbnail: null, __pecotoolCacheUpdatedAt: updatedAt };
  record.__pecotoolCacheBytes = estimateCachedPageBytes(record);
  return record;
}

function waitForTransaction(tx: IDBTransaction, timeoutMessage: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => done(new Error(timeoutMessage)), 10_000);
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err !== undefined) reject(err); else resolve();
    };
    tx.oncomplete = () => done();
    tx.onerror = () => done(tx.error);
    tx.onabort = () => done(tx.error);
  });
}

async function collectCachedPageSummaries(db: IDBDatabase): Promise<CachedPageSummary[]> {
  const summaries: CachedPageSummary[] = [];
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.openCursor();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(summaries);
    };
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (cursor) {
          const record = cursor.value as CachedPageRecord;
          summaries.push({
            key: cursor.key,
            updatedAt: typeof record.__pecotoolCacheUpdatedAt === 'number' ? record.__pecotoolCacheUpdatedAt : 0,
            bytes: typeof record.__pecotoolCacheBytes === 'number'
              ? record.__pecotoolCacheBytes
              : estimateCachedPageBytes(record),
          });
          cursor.continue();
        } else {
          done();
        }
      } catch {
        done();
      }
    };
    request.onerror = () => done();
    tx.oncomplete = () => done();
    tx.onerror = () => done();
    tx.onabort = () => done();
  });
}

async function pruneCachedPages(db: IDBDatabase): Promise<void> {
  try {
    const summaries = await collectCachedPageSummaries(db);
    let totalBytes = summaries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (summaries.length <= PAGE_CACHE_MAX_ENTRIES && totalBytes <= PAGE_CACHE_MAX_BYTES) return;

    summaries.sort((a, b) => a.updatedAt - b.updatedAt);
    const keysToDelete: IDBValidKey[] = [];
    let remainingEntries = summaries.length;
    for (const entry of summaries) {
      if (remainingEntries <= PAGE_CACHE_MAX_ENTRIES && totalBytes <= PAGE_CACHE_MAX_BYTES) break;
      keysToDelete.push(entry.key);
      remainingEntries--;
      totalBytes -= entry.bytes;
    }
    if (keysToDelete.length === 0) return;

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const key of keysToDelete) {
      store.delete(key);
    }
    await waitForTransaction(tx, '[pruneCachedPages] tx timeout');
  } catch { /* ignore cache GC errors */ }
}

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2); // Version up to 2 for new store
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STORE_NAME_DIRTY)) {
          db.createObjectStore(STORE_NAME_DIRTY);
        }
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        // issue #147: session 中に DB がクローズ/version change された場合
        // dbPromise が古い (close 済) connection を握り続けてしまい、以後の
        // すべての tx が InvalidStateError で落ちる。close / versionchange を
        // 検知して dbPromise を null に戻すことで、次回 openDB() で再接続する。
        db.onclose = () => {
          if (dbPromise && dbPromise.then) {
            // 自分が現在の dbPromise を握っているならクリア
            void dbPromise.then((cur) => {
              if (cur === db) dbPromise = null;
            }).catch(() => { dbPromise = null; });
          } else {
            dbPromise = null;
          }
        };
        db.onversionchange = () => {
          // 他タブが upgrade を要求してきたら自分を閉じて promise を捨てる
          db.close();
          dbPromise = null;
        };
        if (!openingPruneStarted) {
          openingPruneStarted = true;
          void pruneCachedPages(db);
        }
        resolve(db);
      };
    });
  }
  return dbPromise;
}

export async function getTemporaryPageData(filePath: string, pageIndex: number): Promise<Partial<PageData> | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readonly');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    const key = `${filePath}:${pageIndex}`;
    const request = store.get(key);
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveTemporaryPageData(filePath: string, pageIndex: number, data: Partial<PageData>) {
  await saveTemporaryPageDataBatch([{ filePath, pageIndex, data }]);
}

export async function saveTemporaryPageDataBatch(
  entries: Array<{ filePath: string; pageIndex: number; data: Partial<PageData> }>
) {
  if (entries.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(STORE_NAME_DIRTY, 'readwrite');
  const store = tx.objectStore(STORE_NAME_DIRTY);
  for (const { filePath, pageIndex, data } of entries) {
    const key = `${filePath}:${pageIndex}`;
    const { thumbnail: _thumbnail, ...cleanData } = data;
    store.put(cleanData, key);
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err !== undefined) reject(err); else resolve();
    };
    tx.oncomplete = () => done();
    tx.onerror = () => done(tx.error);
    tx.onabort = () => done(tx.error);
    setTimeout(() => done(new Error('[saveTemporaryPageDataBatch] tx timeout')), 10_000);
  });
}

export async function clearTemporaryChanges(filePath: string) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readwrite');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    const prefix = `${filePath}:`;
    // IDBKeyRange でfilePath配下のキーのみに絞り込む（フルスキャン回避）
    const range = IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, false);
    const request = store.openCursor(range);
    await new Promise<void>((resolve) => {
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        } catch (e) {
          console.warn('[clearTemporaryChanges] cursor iteration failed:', e);
          resolve();
        }
      };
      request.onerror = () => resolve();
      // transaction 完了を fallback として拾い、永久 hang を防ぐ
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* ignore */ }
}

export async function clearCachedPages(filePath: string) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const prefix = `${filePath}:`;
    const range = IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, false);
    const request = store.openCursor(range);
    await new Promise<void>((resolve) => {
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        } catch (e) {
          console.warn('[clearCachedPages] cursor iteration failed:', e);
          resolve();
        }
      };
      request.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* ignore */ }
}

export async function getAllTemporaryPageData(filePath: string): Promise<Map<number, Partial<PageData>>> {
  const results = new Map<number, Partial<PageData>>();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readonly');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    const prefix = `${filePath}:`;
    // IDBKeyRange でfilePath配下のキーのみに絞り込む（フルスキャン回避）
    const range = IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, false);
    const request = store.openCursor(range);

    return new Promise((resolve) => {
      // cursor.continue() や parseInt で例外が throw されると onsuccess が
      // 途中終了し、resolve に到達せず Promise が永久停止する。try-catch で
      // 既集約分を返して保存経路をブロックしないようにする。
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) {
            const key = cursor.key as string;
            const pageIndex = parseInt(key.slice(prefix.length), 10);
            results.set(pageIndex, cursor.value as Partial<PageData>);
            cursor.continue();
          } else {
            resolve(results);
          }
        } catch (e) {
          console.warn('[getAllTemporaryPageData] cursor iteration failed:', e);
          resolve(results);
        }
      };
      request.onerror = () => resolve(results);
      // transaction 自体の終了もフォールバックとして拾う (onsuccess が
      // 一度も呼ばれないケースで永久 hang しないため)
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => resolve(results);
      tx.onabort = () => resolve(results);
    });
  } catch {
    return results;
  }
}

export async function getCachedPage(key: string): Promise<PageData | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const record = request.result as CachedPageRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        const pageData = stripCacheMetadata(record);
        try {
          store.put(withCacheMetadata(pageData, Date.now()), key);
        } catch { /* ignore LRU touch errors */ }
        resolve(pageData);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedPage(key: string, data: PageData) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Remove thumbnail from cached data to save space in IndexedDB
    const dataToCache = withCacheMetadata(data, Date.now());
    store.put(dataToCache, key);
    await waitForTransaction(tx, '[setCachedPage] tx timeout');
    pageCacheWritesSincePrune++;
    if (pageCacheWritesSincePrune >= PAGE_CACHE_PRUNE_WRITE_INTERVAL) {
      pageCacheWritesSincePrune = 0;
      await pruneCachedPages(db);
    }
  } catch { /* ignore write errors */ }
}
