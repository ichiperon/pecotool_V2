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
import { perf } from './perfLogger';

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

// 主 pdfjs は URL (asset protocol) ベース経路で開く。
// この wrapper は pdfjs 内部の font/cmap fetch にも使用される。
// Tauri asset protocol は Range Request (206) を返すが Accept-Ranges ヘッダーを含めない。
// pdfjs-dist は Accept-Ranges: bytes ヘッダーが無いと Range 非対応と判定し、
// PDF 全体をダウンロードしてから getDocument() を解決するため 210MB で 80 秒かかる。
// asset.localhost URL へのレスポンスに Accept-Ranges: bytes を注入して回避する。
if (typeof window !== 'undefined') {
  const _origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('asset.localhost')) {
      perf.mark('net.fetch', { url, phase: 'start' });
      return _origFetch(input, init).then(response => {
        perf.mark('net.fetch', { url, phase: 'end', status: response.status });
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

// モジュールレベルの PDFWorker シングルトン。
// 各 getDocument 呼び出しごとに worker を spawn すると初期化コスト/メモリが嵩むため、
// 単一 worker を使い回す。destroy は（アプリ終了以外では）しない。
let sharedPdfWorker: pdfjsLib.PDFWorker | null = null;
function getSharedPdfWorker(): pdfjsLib.PDFWorker | undefined {
  if (sharedPdfWorker && !sharedPdfWorker.destroyed) return sharedPdfWorker;
  try {
    const PDFWorkerCtor = (pdfjsLib as unknown as { PDFWorker?: unknown }).PDFWorker;
    if (typeof PDFWorkerCtor !== 'function') return undefined;
    sharedPdfWorker = new (PDFWorkerCtor as new (opts: { name: string }) => pdfjsLib.PDFWorker)({ name: 'peco-shared-pdf-worker' });
    return sharedPdfWorker;
  } catch (e) {
    console.warn('[pdfLoader] PDFWorker instantiation failed, fallback to auto-spawn:', e);
    sharedPdfWorker = null;
    return undefined;
  }
}

/**
 * Open a PDF document using a URL (convertFileSrc) to enable range requests and streaming.
 * URL 経路では pdfjs のデフォルト設定で安定動作するため明示指定は不要。
 */
function getDocumentTask(url: string) {
  const config: DocumentInitParameters = {
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    worker: getSharedPdfWorker(),
    url,
  };

  return pdfjsLib.getDocument(config);
}

export async function loadPDF(filePath: string): Promise<PecoDocument> {
  // Tauri v2 の IPC 経由で 100MB 級のバイナリを転送すると ~700KB/s しか出ず
  // pdfjs の Range fetch (数 MB) より遅いため、URL (asset protocol) ベースに統一している。
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
  // PCT-072: loadingTask を proxy に保持し、進行中ロードを destroySharedPdfProxy()
  // から loadingTask.destroy() で即時中断できるようにする
  const task = getDocumentTask(url);
  const promise = task.promise;
  globalSharedPdfProxy = { filePath, promise, loadId, task };

  // stat と getDocument を並列実行（statは通常先に完了する）
  const statPromise = stat(filePath);
  // ロード失敗時に statPromise が orphan のまま reject して
  // unhandled rejection にならないようにする（成功経路の await には影響しない）
  statPromise.catch(() => {});
  let pdf: pdfjsLib.PDFDocumentProxy;
  try {
    pdf = await promise;
  } catch (e) {
    // PCT-072: 進行中に destroySharedPdfProxy() が走ると loadingTask.destroy() に
    // より promise が reject される。新ロード開始によるキャンセルの場合は
    // 従来の cancelled エラーへ正規化して呼び出し元の挙動を変えない。
    if (globalLoadId !== loadId) {
      throw new Error('[loadPDF] cancelled: newer file load started');
    }
    throw e;
  }

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
// PCT-072: getDocument の loadingTask も保持する。promise だけ持つ旧実装では
// ロード進行中に destroySharedPdfProxy() を呼んでも「解決後に destroy」しか
// できず、大型 PDF ロード中のファイル切替で旧ロードが完走するまでリソースを
// 保持し続けた（ハングしたロードは恒久リーク）。task を持てば即時中断できる。
let globalSharedPdfProxy: {
  filePath: string,
  promise: Promise<pdfjsLib.PDFDocumentProxy>,
  loadId: number,
  task: pdfjsLib.PDFDocumentLoadingTask,
} | null = null;
// 単調増加カウンタ：ファイル切り替え時に古い非同期処理を識別して無視するために使う
let globalLoadId = 0;

// LRUキャッシュ：挿入順序を利用してMapで最大30ページ分を保持。
// page.cleanup() は pdfjs の表層 (operatorList 等) しか解放せず、_transport の
// 内部 PageProxy / FontFaceObject キャッシュは proxy alive な間保持される。
// 上限を 50 → 30 に下げて、pdfjs 内部キャッシュの肥大を緩和する (issue #180)。
const PAGE_PROXY_CACHE_LIMIT = 30;
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
  // PCT-072: loadPDF と同様に loadingTask を保持して進行中ロードを中断可能にする
  const task = getDocumentTask(url);
  const promise = task.promise;
  globalSharedPdfProxy = { filePath, promise, loadId, task };
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
    if (typeof proxy.task?.destroy === 'function') {
      // PCT-072: loadingTask.destroy() はロード進行中なら fetch/parse を即時中断し、
      // 解決済みなら PDFDocumentProxy.destroy() と同等に transport を破棄する
      // (pdfjs の PDFDocumentProxy.destroy() は内部的に loadingTask.destroy() を呼ぶ)。
      // 旧実装の「promise 解決後に destroy」では進行中ロードを中断できなかった。
      //
      // destroy() により task.promise は reject され得るため、先に catch を登録して
      // 「誰も await していない proxy」が unhandled rejection にならないようにする。
      // await 中の呼び出し元には reject が伝播するが、loadPDF は cancelled エラーへ
      // 正規化し、getSharedPdfProxy / getCachedPageProxy の各呼び出し元は
      // try/catch 済み（usePageNavigation / usePdfRendering / useOcrEngine）。
      proxy.promise.catch(() => {});
      try {
        Promise.resolve(proxy.task.destroy()).catch((e) => {
          logger.warn('[pdfLoader] loadingTask.destroy() 失敗:', e);
        });
      } catch (e) {
        logger.warn('[pdfLoader] loadingTask.destroy() 失敗:', e);
      }
    } else {
      // loadingTask が destroy() を持たない場合（テストモック等）は
      // 従来どおり promise 解決後に PDFDocumentProxy.destroy() する。
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
  }
  // pageProxyCacheのページも明示的にcleanupする
  for (const page of pageProxyCache.values()) {
    try { page.cleanup(); } catch { /* ignore */ }
  }
  pageProxyCache.clear();
}


// 責務分離後の後方互換 re-export: 既存 import 文を一切変更しないため pdfLoader から透過的に公開する
export { loadPecoToolBBoxMeta } from './pdfMetadataLoader';
export {
  getTemporaryPageData,
  saveTemporaryPageData,
  saveTemporaryPageDataBatch,
  clearTemporaryChanges,
  clearTemporaryChangesForPages,
  clearCachedPages,
  getAllTemporaryPageData,
  deleteTemporaryPageKeys,
  renameTemporaryPageKeys,
} from './pdfTemporaryStorage';
export { loadPage } from './pdfTextExtractor';
