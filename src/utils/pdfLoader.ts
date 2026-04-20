import * as pdfjsLib from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
// 注意: `./pdfjs-worker-wrapper.ts?url` は Vite が .ts ファイルを
// `data:video/mp2t;base64,...`（生 TypeScript ソース）として埋め込むため、
// サブワーカーが起動できず pdfjs が無期限ハングする不具合があった。
// pdf.worker.min.mjs を直接 `?url` 指定して使用する。
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PecoDocument } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { stat } from '@tauri-apps/plugin-fs';
import { clearBitmapCache } from './bitmapCache';
import { logger } from './logger';

// 直前に生成したラッパーWorker用ObjectURLを保持し、再生成前にrevokeしてリークを防ぐ
let lastPatchedWorkerUrl: string | null = null;

function buildPatchedWorkerUrl(originalWorkerUrl: string): string {
  const absoluteWorkerUrl = new URL(originalWorkerUrl, self.location.href).href;
  const wrapperSrc = `
const _origFetch = self.fetch.bind(self);
self.fetch = function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url);
  if (url && url.includes('asset.localhost')) {
    return _origFetch(input, init).then(function(response) {
      const headers = new Headers(response.headers);
      if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
    });
  }
  return _origFetch(input, init);
};
import(${JSON.stringify(absoluteWorkerUrl)});
`;
  const blob = new Blob([wrapperSrc], { type: 'application/javascript' });
  if (lastPatchedWorkerUrl) {
    try { URL.revokeObjectURL(lastPatchedWorkerUrl); } catch { /* ignore */ }
  }
  const url = URL.createObjectURL(blob);
  lastPatchedWorkerUrl = url;
  return url;
}

if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = buildPatchedWorkerUrl(PdfWorkerUrl);
}

// Tauri asset protocol は Range Request (206) を返すが Accept-Ranges ヘッダーを含めない。
// pdfjs-dist は Accept-Ranges: bytes ヘッダーが無いと Range 非対応と判定し、
// PDF 全体をダウンロードしてから getDocument() を解決するため 210MB で 80 秒かかる。
// asset.localhost URL へのレスポンスに Accept-Ranges: bytes を注入して回避する。
if (typeof window !== 'undefined') {
  const _origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('asset.localhost')) {
      return _origFetch(input, init).then(response => {
        const headers = new Headers(response.headers);
        if (!headers.has('accept-ranges')) {
          headers.set('accept-ranges', 'bytes');
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      });
    }
    return _origFetch(input, init);
  } as typeof fetch;
}

const CMAP_URL = '/cmaps/';
const CMAP_PACKED = true;
const STANDARD_FONT_DATA_URL = '/standard_fonts/';

/**
 * Open a PDF document using a URL (convertFileSrc) to enable range requests and streaming.
 */
function getDocumentTask(urlOrData: string | Uint8Array) {
  const config: DocumentInitParameters = {
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    disableAutoFetch: true,
    // Tauri asset protocol の background stream 占有を避けるため true。
    // Range は patch/wrapper で Accept-Ranges を注入しているので on-demand でも動作する。
    disableStream: true,
    disableRange: false,
  };

  if (typeof urlOrData === 'string') {
    config.url = urlOrData;
  } else {
    config.data = urlOrData.slice();
  }

  return pdfjsLib.getDocument(config);
}

// アプリ起動直後にworkerを起動しておく（初回PDF読込を高速化）
// 不正なPDFデータで呼ぶためworker側でエラーになるが、プロセス起動は完了する
export function prewarmPdfjsWorker(): void {
  const task = pdfjsLib.getDocument({ data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }); // "%PDF"
  task.promise.catch(() => {});
}

export async function loadPDF(filePath: string): Promise<PecoDocument> {
  let url = convertFileSrc(filePath);
  // Tauri v2 (Windows) は https://asset.localhost を使う。
  // CSP で https も許可したが、古い環境との互換性のために startsWith チェックを維持。
  if (url.startsWith('asset.localhost')) {
    url = 'http://' + url;
  }

  // getDocument の結果を globalSharedPdfProxy に直接格納することで
  // 後続の getSharedPdfProxy が2回目の getDocument を呼ばないようにする
  destroySharedPdfProxy();
  const loadId = ++globalLoadId;
  const promise = getDocumentTask(url).promise;
  globalSharedPdfProxy = { filePath, promise, loadId };

  // stat と getDocument を並列実行（statは通常先に完了する）
  const statPromise = stat(filePath);
  const pdf = await promise;

  // ファイルが切り替わっていた場合は破棄
  if (globalLoadId !== loadId) {
    try { pdf.destroy(); } catch { /* ignore */ }
    throw new Error('[loadPDF] cancelled: newer file load started');
  }

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
    const info = metadata.info as Record<string, unknown> | undefined;
    const title = info?.Title;
    const author = info?.Author;
    doc.metadata.title = typeof title === 'string' ? title : undefined;
    doc.metadata.author = typeof author === 'string' ? author : undefined;
  }).catch(() => {});

  // ファイルの最終更新時刻をキャッシュキーに使うために取得（getDocumentと並列取得済み）
  try {
    const fileStat = await statPromise;
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

/**
 * Open a fresh, isolated PDF document for OCR rendering.
 * This does NOT touch the shared proxy or LRU page cache,
 * so concurrent renders in PdfCanvas will not conflict.
 * Caller is responsible for calling pdf.destroy() when done.
 */
export async function openFreshPdfDoc(filePath: string): Promise<pdfjsLib.PDFDocumentProxy> {
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) {
    url = 'http://' + url;
  }
  return getDocumentTask(url).promise;
}

// ページプロキシのメモリキャッシュ（ページ切り替えをゼロ秒にするため）
let globalSharedPdfProxy: { filePath: string, promise: Promise<pdfjsLib.PDFDocumentProxy>, loadId: number } | null = null;
// 単調増加カウンタ：ファイル切り替え時に古い非同期処理を識別して無視するために使う
let globalLoadId = 0;

// LRUキャッシュ：挿入順序を利用してMapで最大50ページ分を保持
const PAGE_PROXY_CACHE_LIMIT = 50;
const pageProxyCache = new Map<string, pdfjsLib.PDFPageProxy>();

function evictPageProxyCache() {
  while (pageProxyCache.size > PAGE_PROXY_CACHE_LIMIT) {
    const oldestKey = pageProxyCache.keys().next().value!;
    const evicted = pageProxyCache.get(oldestKey);
    pageProxyCache.delete(oldestKey);
    if (evicted) {
      try { evicted.cleanup(); } catch { /* ignore */ }
    }
  }
}

export async function getSharedPdfProxy(filePath: string): Promise<pdfjsLib.PDFDocumentProxy> {
  if (globalSharedPdfProxy?.filePath === filePath) {
    return globalSharedPdfProxy.promise;
  }
  destroySharedPdfProxy();
  const loadId = ++globalLoadId;
  let url = convertFileSrc(filePath);
  if (url.startsWith('asset.localhost')) {
    url = 'http://' + url;
  }
  const promise = getDocumentTask(url).promise;
  globalSharedPdfProxy = { filePath, promise, loadId };
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

  const capturedLoadId = globalLoadId;
  const doc = await getSharedPdfProxy(filePath);

  // await 中にファイルが切り替わっていた場合は古い結果を返さない
  if (globalLoadId !== capturedLoadId || globalSharedPdfProxy?.filePath !== filePath) {
    throw new Error(`[getCachedPageProxy] cancelled: file switched (page ${pageIndex})`);
  }

  const page = await doc.getPage(pageIndex + 1);
  pageProxyCache.set(key, page);
  evictPageProxyCache();
  return page;
}

export function destroySharedPdfProxy() {
  // ファイル切替時にビットマップキャッシュもクリア
  clearBitmapCache();
  if (globalSharedPdfProxy) {
    const proxy = globalSharedPdfProxy;
    globalSharedPdfProxy = null; // 先にnullにして後続のgetSharedPdfProxy呼び出しをブロックしない
    proxy.promise.then(p => {
      // pdfjs-dist の PDFDocumentProxy は destroy() を持つが、
      // テストモックや中間プロキシなど一部のオブジェクトは持たない。
      // silent catch ではなく事前チェック + 警告ログで観測可能にする。
      if (typeof p?.destroy !== 'function') {
        logger.warn('[pdfLoader] destroySharedPdfProxy: proxy.destroy is not a function', {
          type: typeof p,
          keys: p ? Object.keys(p) : null,
        });
        return;
      }
      try { p.destroy(); } catch (e) {
        logger.warn('[pdfLoader] PDFDocumentProxy.destroy() 失敗:', e);
      }
    }).catch((e) => {
      logger.warn('[pdfLoader] destroySharedPdfProxy: Promiseエラー:', e);
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

// 責務分離後の後方互換 re-export: 既存 import 文を一切変更しないため pdfLoader から透過的に公開する
export { loadPecoToolBBoxMeta } from './pdfMetadataLoader';
export {
  getTemporaryPageData,
  saveTemporaryPageData,
  saveTemporaryPageDataBatch,
  clearTemporaryChanges,
  getAllTemporaryPageData,
} from './pdfTemporaryStorage';
export { loadPage } from './pdfTextExtractor';
