// =====================================================================
// Web Worker コンテキストでは `window` / `document` が未定義。
// pdfjs-dist の内部レンダリング経路 (パターンキャッシュ・画像デコード等) で
// `document.createElement('canvas')` を呼び出す箇所があり、未定義だと
// `Cannot read properties of undefined (reading 'createElement')` で render() が失敗する。
// 最小限のスタブで補完する: canvas は OffscreenCanvas を返し、その他の要素は
// 空のスタブを返してpdfjs内部のスタイル設定等で例外を出さないようにする。
// ※ import は巻き上げられて先に実行されるが、getDocument()/render() 呼び出しは
//    このポリフィル実行後になるため、ランタイムエラーは防げる。
// =====================================================================
// pdfjs 内部が触る window/document を最小限スタブ化する。
// Worker コンテキストでは Window/Document 型と整合しないため unknown 経由で書き込む。
type ElementStub = {
  style: Record<string, string>;
  setAttribute(): void;
  getContext(): null;
  appendChild(): void;
  remove(): void;
};

const _globalAny = globalThis as unknown as Record<string, unknown>;
if (typeof (_globalAny as { window?: unknown }).window === 'undefined') {
  _globalAny.window = globalThis;
}
if (typeof (_globalAny as { document?: unknown }).document === 'undefined') {
  const documentStub = {
    createElement(tag: string): OffscreenCanvas | ElementStub {
      if (typeof tag === 'string' && tag.toLowerCase() === 'canvas') {
        return new OffscreenCanvas(1, 1);
      }
      // 他要素はpdfjs内部のスタイル/属性設定が落ちないようにスタブを返す
      return {
        style: {},
        setAttribute() {},
        getContext() { return null; },
        appendChild() {},
        remove() {},
      };
    },
    createElementNS(_ns: string, tag: string): OffscreenCanvas | ElementStub {
      return documentStub.createElement(tag);
    },
  };
  _globalAny.document = documentStub;
}

import * as pdfjsLib from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
import type { ThumbnailWorkerRequest, ThumbnailWorkerResponse } from './thumbnailWorkerTypes';
// このWorkerはメインスレッドから ArrayBuffer を転送で受け取るため、
// 内部で fetch を行わない → Accept-Ranges パッチ (pdfjs-worker-wrapper) は不要。
// ラッパーを経由すると Vite の `?url` import が .ts ファイルを
// data:video/mp2t;base64,... として生TSのまま埋め込み、サブワーカーが
// 起動できずに getDocument() が無期限ハングする不具合がある。
// そのため素の pdf.worker.min.mjs を直接 workerSrc として使用する。
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let loadPromise: Promise<void> | null = null;
// 進行中の getDocument タスク。新 LOAD_PDF 到着時に前回タスクを destroy() して
// 未解決 promise の孤立と pdfDoc の古いまま上書きを防ぐ。
let currentLoadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

function post(msg: ThumbnailWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self.postMessage as (m: unknown, transfer: Transferable[]) => void)(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

// OffscreenCanvas 同時レンダリング数を制限するセマフォ
let activeRenders = 0;
const MAX_CONCURRENT_RENDERS = 4;
const renderWaitQueue: Array<() => void> = [];

async function handleLoadPdf(source: string | ArrayBuffer): Promise<void> {
  // 新しいPDFロード時にセマフォをリセット
  // ただし待機中の resolver は先に起こして「抜けさせる」必要がある（さもないと
  // handleGenerateThumbnail の Promise が永久に resolve されず忘れられる）
  activeRenders = 0;
  renderWaitQueue.forEach(r => r());
  renderWaitQueue.length = 0;

  // 進行中の getDocument タスクがあれば先に destroy() して未解決 promise を確実に
  // 終端化する（destroy 後の .promise は reject される）。そうしないと、前回の
  // loadPromise が後から resolve して古い pdfDoc を代入し race になる。
  if (currentLoadingTask) {
    try { await currentLoadingTask.destroy(); } catch { /* ignore */ }
    currentLoadingTask = null;
  }
  if (pdfDoc) {
    // 既存のドキュメントが完全に破棄されてから新規ロードへ（race 防止）
    try { await pdfDoc.destroy(); } catch { /* ignore */ }
    pdfDoc = null;
  }
  loadPromise = null;

  try {
    // Worker コンテキストでは self.location.origin で絶対 URL を構築
    // （相対パスのままだと pdfjs が window.location を参照してしまう）
    const origin = self.location.origin;
    const config: DocumentInitParameters = {
      cMapUrl: `${origin}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${origin}/standard_fonts/`,
    };

    if (typeof source === 'string') {
      config.url = source;
    } else {
      // ArrayBuffer 転送（メインスレッドで fetch 済み → ネットワーク不要）
      config.data = new Uint8Array(source);
    }

    const task = pdfjsLib.getDocument(config);
    currentLoadingTask = task;
    loadPromise = task.promise.then(doc => {
      // この解決時点で別 LOAD_PDF により currentLoadingTask が差し替わっていたら
      // 古い doc を採用しない（destroy して破棄）。
      if (currentLoadingTask !== task) {
        try { doc.destroy(); } catch { /* ignore */ }
        return;
      }
      pdfDoc = doc;
      post({ type: 'LOAD_COMPLETE', numPages: doc.numPages, workerPerfNow: performance.now() });
    }).catch((e) => {
      if (currentLoadingTask === task) {
        currentLoadingTask = null;
        loadPromise = null;
        post({ type: 'LOAD_ERROR', message: String(e) });
      }
      // 別タスクに差し替え済みの場合はキャンセルによる reject なのでログのみ
      console.error('[thumbnail.worker] PDF load failed:', e);
    });
  } catch (e) {
    console.error('[thumbnail.worker] PDF load exception:', e);
    loadPromise = null;
    post({ type: 'LOAD_ERROR', message: String(e) });
  }
}

async function handleGenerateThumbnail(pageIndex: number): Promise<void> {
  // セマフォ: 同時レンダリング数が上限に達していたら待機
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    await new Promise<void>(resolve => renderWaitQueue.push(resolve));
  }
  activeRenders++;
  const workerGenStart = performance.now();
  try {
    // loadPromise が設定されている場合は PDF ロード完了を待つ
    // （LOAD_PDF より先に GENERATE_THUMBNAIL が届いた場合の保護）
    if (loadPromise) await loadPromise;
    if (!pdfDoc) {
      post({ type: 'THUMBNAIL_ERROR', pageIndex });
      return;
    }

    const page = await pdfDoc.getPage(pageIndex + 1);
    const unscaled = page.getViewport({ scale: 1.0 });

    // ★ 高速化: 120px（表示サイズに一致）で描画 → 150px より ~34% ピクセル減
    const scale = Math.min(120 / unscaled.width, 1.0);
    const viewport = page.getViewport({ scale });

    const w = Math.max(1, Math.round(viewport.width));
    const h = Math.max(1, Math.round(viewport.height));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // サムネイルはアノテーション不要 → DISABLE で内部処理を軽量化
    // pdfjs の render() 型は CanvasRenderingContext2D / HTMLCanvasElement を要求するが、
    // 実行時は OffscreenCanvas 系でも動く。型定義との差分のみ unknown 経由で吸収する。
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
      annotationMode: 0,
    }).promise;

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
    const buf = await blob.arrayBuffer();

    // ArrayBuffer を Transferable として転送（零コピー）
    post(
      {
        type: 'THUMBNAIL_DONE',
        pageIndex,
        bytes: new Uint8Array(buf),
        workerGenStart,
        workerGenDone: performance.now(),
      },
      [buf],
    );
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[thumbnail.worker] Page ${pageIndex + 1} failed:`, e);
    // エラー内容をメインスレッドへ伝搬してDevToolsで確認できるようにする
    post({ type: 'THUMBNAIL_ERROR', pageIndex, error: errMsg });
  } finally {
    activeRenders--;
    renderWaitQueue.shift()?.();
  }
}

self.onmessage = (e: MessageEvent<ThumbnailWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'LOAD_PDF') {
    // discriminated union で url | bytes を narrow
    if (msg.url !== undefined) {
      handleLoadPdf(msg.url);
    } else {
      handleLoadPdf(msg.bytes);
    }
  } else if (msg.type === 'GENERATE_THUMBNAIL') {
    // await しない → 複数ページ協調並行処理（内部で loadPromise を await）
    handleGenerateThumbnail(msg.pageIndex);
  } else {
    // 網羅性チェック
    const _exhaustive: never = msg;
    return _exhaustive;
  }
};
