import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PecoDocument, PageData, TextBlock, BoundingBox } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { stat } from '@tauri-apps/plugin-fs';

// 爆速化の要：Worker を Blob URL 化して確実に別スレッドで動かす
if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;
}

const CMAP_URL = '/cmaps/';
const CMAP_PACKED = true;
const STANDARD_FONT_DATA_URL = '/standard_fonts/';

/**
 * Open a PDF document using a URL (convertFileSrc) to enable range requests and streaming.
 */
function getDocumentTask(urlOrData: string | Uint8Array) {
  const config: any = {
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    disableAutoFetch: true, 
    disableStream: false,
    disableRange: false,
  };

  if (typeof urlOrData === 'string') {
    config.url = urlOrData;
  } else {
    config.data = urlOrData.slice();
  }

  return pdfjsLib.getDocument(config);
}

export async function loadPDF(filePath: string): Promise<PecoDocument> {
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) {
    url = 'http://' + url;
  }

  // getDocument の結果を globalSharedPdfProxy に直接格納することで
  // 後続の getSharedPdfProxy が2回目の getDocument を呼ばないようにする
  destroySharedPdfProxy();
  const promise = getDocumentTask(url).promise;
  globalSharedPdfProxy = { filePath, promise };

  const pdf = await promise;
  const totalPages = pdf.numPages;

  const doc: PecoDocument = {
    filePath: filePath,
    fileName: filePath.split(/[\\/]/).pop() || 'document.pdf',
    totalPages: totalPages,
    metadata: {
      title: undefined,
      author: undefined,
    },
    pages: new Map(),
  };

  // getMetadata はページ表示に不要なため非同期で取得（ブロックしない）
  // filePath をクロージャーで保持し、globalSharedPdfProxy が切り替わった後は書き込まない
  const capturedFilePath = filePath;
  pdf.getMetadata().then((metadata) => {
    // 既に別ファイルに切り替わっている場合は書き込まない
    if (globalSharedPdfProxy?.filePath !== capturedFilePath) return;
    doc.metadata.title = (metadata.info as any)?.Title;
    doc.metadata.author = (metadata.info as any)?.Author;
  }).catch(() => {});

  // ファイルの最終更新時刻をキャッシュキーに使うために取得
  try {
    const fileStat = await stat(filePath);
    const mt = fileStat.mtime;
    doc.mtime = mt instanceof Date ? mt.getTime() : (mt ?? Date.now());
  } catch {
    doc.mtime = Date.now();
  }

  return doc;
}

export async function openPDF(filePath: string): Promise<pdfjsLib.PDFDocumentProxy> {
  const url = convertFileSrc(filePath);
  return getDocumentTask(url).promise;
}

// ページプロキシのメモリキャッシュ（ページ切り替えをゼロ秒にするため）
let globalSharedPdfProxy: { filePath: string, promise: Promise<pdfjsLib.PDFDocumentProxy> } | null = null;

// LRUキャッシュ：挿入順序を利用してMapで最大50ページ分を保持
const PAGE_PROXY_CACHE_LIMIT = 50;
const pageProxyCache = new Map<string, pdfjsLib.PDFPageProxy>();

function evictPageProxyCache() {
  while (pageProxyCache.size > PAGE_PROXY_CACHE_LIMIT) {
    const oldestKey = pageProxyCache.keys().next().value!;
    pageProxyCache.delete(oldestKey);
  }
}

export async function getSharedPdfProxy(filePath: string): Promise<pdfjsLib.PDFDocumentProxy> {
  if (globalSharedPdfProxy?.filePath === filePath) {
    return globalSharedPdfProxy.promise;
  }
  destroySharedPdfProxy();
  const url = convertFileSrc(filePath);
  const promise = getDocumentTask(url).promise;
  globalSharedPdfProxy = { filePath, promise };
  return promise;
}

export async function getCachedPageProxy(filePath: string, pageIndex: number): Promise<pdfjsLib.PDFPageProxy> {
  const key = `${filePath}:${pageIndex}`;
  if (pageProxyCache.has(key)) {
    // アクセスされたエントリを末尾に移動してLRU順序を更新
    const page = pageProxyCache.get(key)!;
    pageProxyCache.delete(key);
    pageProxyCache.set(key, page);
    return page;
  }

  const doc = await getSharedPdfProxy(filePath);
  const page = await doc.getPage(pageIndex + 1);
  pageProxyCache.set(key, page);
  evictPageProxyCache();
  return page;
}

export function destroySharedPdfProxy() {
  if (globalSharedPdfProxy) {
    const proxy = globalSharedPdfProxy;
    globalSharedPdfProxy = null; // 先にnullにして後続のgetSharedPdfProxy呼び出しをブロックしない
    proxy.promise.then(p => {
      try { p.destroy(); } catch (e) {
        console.warn('[pdfLoader] PDFDocumentProxy.destroy() 失敗:', e);
      }
    }).catch((e) => {
      console.warn('[pdfLoader] destroySharedPdfProxy: Promiseエラー:', e);
    });
  }
  // pageProxyCacheのページも明示的にcleanupする
  for (const page of pageProxyCache.values()) {
    try { page.cleanup(); } catch { /* ignore */ }
  }
  pageProxyCache.clear();
}


export async function generateThumbnail(filePath: string, pageIndex: number): Promise<string> {
  const page = await getCachedPageProxy(filePath, pageIndex);
  const unscaledViewport = page.getViewport({ scale: 1.0 });
  const scale = Math.min(150 / unscaledViewport.width, 1.0); // 最大幅150pxに制限
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })!;
  
  // 背景を白に塗る（jpegの黒背景化防止）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  
  // Convert to Blob instead of Base64 to save memory (Low quality JPEG for thumbnails)
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(URL.createObjectURL(blob));
      } else {
        resolve("");
      }
    }, 'image/jpeg', 0.5); // 品質を0.7から0.5に下げてさらに高速化
  });
}

/**
 * Read PecoTool bbox metadata from the PDF if it was saved by this tool.
 * Returns null if no metadata found.
 */
export async function loadPecoToolBBoxMeta(pdf: pdfjsLib.PDFDocumentProxy): Promise<Record<string, Array<{
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
}>> | null> {
  try {
    const metadata = await pdf.getMetadata();
    const raw = (metadata.info as any)?.Custom?.PecoToolBBoxes || (metadata.info as any)?.PecoToolBBoxes;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[loadPecoToolBBoxMeta] Failed to parse metadata:', err);
  }
  return null;
}

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
      request.onupgradeneeded = (_event: any) => {
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
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readwrite');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    const key = `${filePath}:${pageIndex}`;
    // Always strip thumbnails before saving to IDB to save space
    const { thumbnail: _thumbnail, ...cleanData } = data as any;
    store.put(cleanData, key);
  } catch { /* ignore */ }
}

export async function clearTemporaryChanges(_filePath: string) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readwrite');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    // There is no easy way to clear by prefix in IDB without cursor,
    // but we can at least clear the whole store when a document is saved/closed.
    // For now, let's just clear the specific keys if we know them.
    store.clear(); 
  } catch { /* ignore */ }
}

export async function getAllTemporaryPageData(filePath: string): Promise<Map<number, Partial<PageData>>> {
  const results = new Map<number, Partial<PageData>>();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME_DIRTY, 'readonly');
    const store = tx.objectStore(STORE_NAME_DIRTY);
    const request = store.openCursor();
    
    return new Promise((resolve) => {
      request.onsuccess = (event: any) => {
        const cursor = event.target.result;
        if (cursor) {
          const key = cursor.key as string;
          if (key.startsWith(`${filePath}:`)) {
            const pageIndex = parseInt(key.split(':')[1], 10);
            results.set(pageIndex, cursor.value);
          }
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

async function getCachedPage(key: string): Promise<PageData | null> {
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

async function setCachedPage(key: string, data: PageData) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Remove thumbnail from cached data to save space in IndexedDB
    const dataToCache = { ...data, thumbnail: null };
    store.put(dataToCache, key);
  } catch { /* ignore write errors */ }
}

export async function loadPage(
  _pdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  filePath: string,
  bboxMeta?: Record<string, Array<{
    bbox: BoundingBox;
    writingMode: string;
    order: number;
    text: string;
  }>> | null,
  mtime?: number
): Promise<PageData> {
  const cacheKey = `${filePath}:${pageIndex}:${mtime ?? 0}`;
  const cached = await getCachedPage(cacheKey);
  const tempEdited = await getTemporaryPageData(filePath, pageIndex);

  let pageData: PageData;

  if (cached) {
    pageData = { ...cached, pageIndex };
  } else {
    // キャッシュ済みプロキシを再利用して二重getPageを回避
    const page = await getCachedPageProxy(filePath, pageIndex);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
    const allItems = textContent.items;
    const textItems = allItems.filter((item: any) => typeof item.str === 'string');

    let textBlocks: TextBlock[];

    // If PecoTool-saved bbox metadata is available for this page, use it directly.
    const savedMeta = bboxMeta?.[String(pageIndex)];
    if (savedMeta && savedMeta.length > 0) {
      const textByOrder = new Map(
        textItems
          .filter((item: any) => item.str.trim() !== '')
          .map((item: any, idx: number) => [idx, item.str as string])
      );

      textBlocks = savedMeta.map((meta, idx) => ({
        id: crypto.randomUUID(),
        text: textByOrder.get(idx) ?? meta.text,
        originalText: textByOrder.get(idx) ?? meta.text,
        bbox: meta.bbox,
        writingMode: meta.writingMode as 'horizontal' | 'vertical',
        order: meta.order,
        isNew: false,
        isDirty: false,
      }));
    } else {
      // Fallback: compute bboxes from pdfjs transform (original OCR text)
      // Use viewport.convertToViewportPoint to correctly handle page rotation (/Rotate)
      // and CropBox offsets set by Acrobat.
      let order = 0;
      textBlocks = textItems
        .filter((item: any) => item.str.trim() !== '')
        .map((item: any) => {
          const tx = item.transform;
          // Text run direction unit vector in PDF user space
          const mag = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || 1;
          const ux = tx[0] / mag;
          const uy = tx[1] / mag;
          // Perpendicular direction (above baseline) in PDF user space
          const px = -uy;
          const py = ux;

          const thickness = item.height > 0
            ? item.height
            : (Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || mag || 12);
          const runLength = item.width || mag * item.str.length * 0.6;
          const ascent = thickness * 1.16;

          // Compute 4 corners of the text bbox in PDF user space, then transform
          // all of them to viewport (screen) space via convertToViewportPoint.
          // This correctly handles page rotation and CropBox offsets.
          const corners: [number, number][] = [
            [tx[4],                                    tx[5]],
            [tx[4] + ux * runLength,                   tx[5] + uy * runLength],
            [tx[4] + px * ascent,                      tx[5] + py * ascent],
            [tx[4] + ux * runLength + px * ascent,     tx[5] + uy * runLength + py * ascent],
          ];

          const vc = corners.map(([cx, cy]) => viewport.convertToViewportPoint(cx, cy));
          const vxs = vc.map(c => c[0]);
          const vys = vc.map(c => c[1]);

          const bbox: BoundingBox = {
            x: Math.min(...vxs),
            y: Math.min(...vys),
            width: Math.max(...vxs) - Math.min(...vxs),
            height: Math.max(...vys) - Math.min(...vys),
          };

          // Determine writing mode from screen-space text run direction.
          // Using bbox shape would misclassify short vertical runs (e.g. single char)
          // where ascent > run length. The direction vector is always reliable.
          const [vDirX, vDirY] = viewport.convertToViewportPoint(tx[4] + ux, tx[5] + uy);
          const isVertical = Math.abs(vDirY - vc[0][1]) > Math.abs(vDirX - vc[0][0]);

          return {
            id: crypto.randomUUID(),
            text: item.str,
            originalText: item.str,
            bbox,
            writingMode: isVertical ? 'vertical' : 'horizontal',
            order: order++,
            isNew: false,
            isDirty: false,
          };
        });
    }

    pageData = {
      pageIndex,
      width: viewport.width,
      height: viewport.height,
      textBlocks,
      isDirty: false,
      thumbnail: null,
    };
    await setCachedPage(cacheKey, pageData);
  }

  // If there are temporary (un-saved) edits, merge them
  if (tempEdited) {
    pageData = { ...pageData, ...tempEdited, isDirty: true };
  }

  return pageData;
}

