import { PageData } from '../types';

// IndexedDB cache for OCR results and temporary edits
const DB_NAME = 'peco_ocr_cache';
const STORE_NAME = 'pages';
const STORE_NAME_DIRTY = 'temporary_changes'; // New store for un-saved edits

// DB接続を一度だけ開いて使い回す
let dbPromise: Promise<IDBDatabase> | null = null;

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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
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
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || null);
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
    const dataToCache = { ...data, thumbnail: null };
    store.put(dataToCache, key);
  } catch { /* ignore write errors */ }
}
