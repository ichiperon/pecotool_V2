import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PecoDocument, PageData, TextBlock, BoundingBox } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';

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
  const loadingTask = getDocumentTask(url);
  const pdf = await loadingTask.promise;
  
  const totalPages = pdf.numPages;
  const metadata = await pdf.getMetadata();
  
  const doc: PecoDocument = {
    filePath: filePath,
    fileName: filePath.split(/[\\/]/).pop() || 'document.pdf',
    totalPages: totalPages,
    metadata: {
      title: (metadata.info as any)?.Title,
      author: (metadata.info as any)?.Author,
    },
    pages: new Map(),
  };

  return doc;
}

export async function openPDF(filePath: string): Promise<pdfjsLib.PDFDocumentProxy> {
  const url = convertFileSrc(filePath);
  return getDocumentTask(url).promise;
}

// ページプロキシのメモリキャッシュ（ページ切り替えをゼロ秒にするため）
let globalSharedPdfProxy: { filePath: string, promise: Promise<pdfjsLib.PDFDocumentProxy> } | null = null;

// LRUキャッシュ：挿入順序を利用してMapで最大20ページ分を保持
const PAGE_PROXY_CACHE_LIMIT = 20;
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
    globalSharedPdfProxy.promise.then(p => {
      try { p.destroy(); } catch (e) {}
    }).catch(() => {});
    globalSharedPdfProxy = null;
  }
  pageProxyCache.clear();
}


export async function generateThumbnail(pdf: pdfjsLib.PDFDocumentProxy, pageIndex: number): Promise<string> {
  const page = await pdf.getPage(pageIndex + 1);
  const unscaledViewport = page.getViewport({ scale: 1.0 });
  const scale = Math.min(250 / unscaledViewport.width, 1.0); // 最大幅250pxに制限
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

// IndexedDB cache for OCR results
const DB_NAME = 'peco_ocr_cache';
const STORE_NAME = 'pages';

// DB接続を一度だけ開いて使い回す
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null; // エラー時は次回再試行できるようにリセット
        reject(request.error);
      };
    });
  }
  return dbPromise;
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
  } catch {}
}

export async function loadPage(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  filePath: string,
  bboxMeta?: Record<string, Array<{
    bbox: BoundingBox;
    writingMode: string;
    order: number;
    text: string;
  }>> | null
): Promise<PageData> {
  const cacheKey = `${filePath}:${pageIndex}`;
  const cached = await getCachedPage(cacheKey);
  if (cached) {
    console.log(`[loadPage] page ${pageIndex}: cache hit`);
    return { ...cached, pageIndex }; // Ensure pageIndex is correct
  }

  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();

  // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
  const allItems = textContent.items;
  const textItems = allItems.filter((item: any) => typeof item.str === 'string');
  const nonEmpty = textItems.filter((item: any) => item.str.trim() !== '');
  console.log(`[loadPage] page ${pageIndex}: total=${allItems.length}, hasStr=${textItems.length}, nonEmpty=${nonEmpty.length}`);

  let textBlocks: TextBlock[] = [];

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
    let order = 0;
    textBlocks = textItems
      .filter((item: any) => item.str.trim() !== '')
      .map((item: any) => {
        const isVertical = Math.abs(item.transform[0]) < Math.abs(item.transform[1]);
        let bbox: BoundingBox;
        if (isVertical) {
          const thickness = Math.sqrt(item.transform[2] * item.transform[2] + item.transform[3] * item.transform[3]) || 12;
          const runLength = item.width || Math.abs(item.transform[1]) * item.str.length || thickness * item.str.length;
          bbox = {
            x: item.transform[4] - thickness * 0.288,
            y: viewport.height - item.transform[5],
            width: thickness,
            height: runLength,
          };
        } else {
          const thickness = item.height > 0 ? item.height : Math.abs(item.transform[3]) || 12;
          const runLength = item.width || thickness * item.str.length * 0.6;
          bbox = {
            x: item.transform[4],
            y: viewport.height - item.transform[5] - thickness * 1.16,
            width: runLength,
            height: thickness,
          };
        }
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

  const pageData: PageData = {
    pageIndex,
    width: viewport.width,
    height: viewport.height,
    textBlocks,
    isDirty: false,
    thumbnail: null,
  };

  await setCachedPage(cacheKey, pageData);
  return pageData;
}
