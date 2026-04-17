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
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readwrite');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    for (const { filePath, pageIndex, data } of entries) {
      const key = `${filePath}:${pageIndex}`;
      // Always strip thumbnails before saving to IDB to save space
      const { thumbnail: _thumbnail, ...cleanData } = data;
      store.put(cleanData, key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
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
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
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
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const key = cursor.key as string;
          const pageIndex = parseInt(key.slice(prefix.length), 10);
          results.set(pageIndex, cursor.value as Partial<PageData>);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => resolve(results);
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
