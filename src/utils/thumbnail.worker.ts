// =====================================================================
// Web Worker コンテキストでは `window` が未定義。
// pdfjs-dist が window を参照する箇所があるため globalThis で補完する。
// ※ import は巻き上げられて先に実行されるが、getDocument() 呼び出しは
//    このポリフィル実行後になるため、ランタイムエラーは防げる。
// =====================================================================
if (typeof window === 'undefined') {
  (globalThis as any).window = globalThis;
}

import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let loadPromise: Promise<void> | null = null;

function handleLoadPdf(source: string | ArrayBuffer): void {
  if (pdfDoc) {
    pdfDoc.destroy().catch(() => {});
    pdfDoc = null;
  }
  loadPromise = null;

  try {
    // Worker コンテキストでは self.location.origin で絶対 URL を構築
    // （相対パスのままだと pdfjs が window.location を参照してしまう）
    const origin = self.location.origin;
    const config: any = {
      cMapUrl: `${origin}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${origin}/standard_fonts/`,
    };

    if (typeof source === 'string') {
      config.url = source;
      config.disableAutoFetch = true;
      config.disableStream = false;
      config.disableRange = false;
    } else {
      // ArrayBuffer 転送（メインスレッドで fetch 済み → ネットワーク不要）
      config.data = new Uint8Array(source);
    }

    loadPromise = pdfjsLib.getDocument(config).promise.then(doc => {
      pdfDoc = doc;
      self.postMessage({ type: 'LOAD_COMPLETE', numPages: doc.numPages });
    }).catch((e) => {
      console.error('[thumbnail.worker] PDF load failed:', e);
      loadPromise = null;
      self.postMessage({ type: 'LOAD_ERROR', message: String(e) });
    });
  } catch (e) {
    console.error('[thumbnail.worker] PDF load exception:', e);
    loadPromise = null;
    self.postMessage({ type: 'LOAD_ERROR', message: String(e) });
  }
}

async function handleGenerateThumbnail(pageIndex: number): Promise<void> {
  try {
    // loadPromise が設定されている場合は PDF ロード完了を待つ
    // （LOAD_PDF より先に GENERATE_THUMBNAIL が届いた場合の保護）
    if (loadPromise) await loadPromise;
    if (!pdfDoc) {
      self.postMessage({ type: 'THUMBNAIL_ERROR', pageIndex });
      return;
    }

    const page = await pdfDoc.getPage(pageIndex + 1);
    const unscaled = page.getViewport({ scale: 1.0 });

    // ★ 高速化: 120px（表示サイズに一致）で描画 → 150px より ~34% ピクセル減
    const scale = Math.min(120 / unscaled.width, 1.0);
    const viewport = page.getViewport({ scale });

    const canvas = new OffscreenCanvas(
      Math.round(viewport.width),
      Math.round(viewport.height)
    );
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any }).promise;

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
    const buf = await blob.arrayBuffer();

    // ArrayBuffer を Transferable として転送（零コピー）
    self.postMessage(
      { type: 'THUMBNAIL_DONE', pageIndex, bytes: new Uint8Array(buf) },
      [buf] as any
    );
  } catch (e) {
    console.error(`[thumbnail.worker] Page ${pageIndex + 1} failed:`, e);
    self.postMessage({ type: 'THUMBNAIL_ERROR', pageIndex });
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;
  if (type === 'LOAD_PDF') {
    handleLoadPdf(e.data.url ?? e.data.bytes);
  } else if (type === 'GENERATE_THUMBNAIL') {
    // await しない → 複数ページ協調並行処理（内部で loadPromise を await）
    handleGenerateThumbnail(e.data.pageIndex);
  }
};
