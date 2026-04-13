import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// pdfjs-dist v5 では workerSrc='' がエラーになるため正規のWorker URLを指定する
// Tauri(Chromium)はネストしたDedicated Workerをサポートしているため問題なし
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let loadPromise: Promise<void> | null = null;

// URLまたはArrayBufferでPDFを受け取る
function handleLoadPdf(source: string | ArrayBuffer): void {
  if (pdfDoc) {
    pdfDoc.destroy().catch(() => {});
    pdfDoc = null;
  }
  loadPromise = null;

  try {
    const config: any = {
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
    };

    if (typeof source === 'string') {
      config.url = source;
      config.disableAutoFetch = true;
      config.disableStream = false;
      config.disableRange = false;
    } else {
      config.data = new Uint8Array(source);
    }

    loadPromise = pdfjsLib.getDocument(config).promise.then(doc => {
      pdfDoc = doc;
      // ロード完了をメインスレッドに通知
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
    if (loadPromise) await loadPromise;
    if (!pdfDoc) {
      self.postMessage({ type: 'THUMBNAIL_ERROR', pageIndex });
      return;
    }

    const page = await pdfDoc.getPage(pageIndex + 1);
    const unscaled = page.getViewport({ scale: 1.0 });
    const scale = Math.min(150 / unscaled.width, 1.0);
    const viewport = page.getViewport({ scale });

    const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any }).promise;

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    const buf = await blob.arrayBuffer();

    self.postMessage(
      { type: 'THUMBNAIL_DONE', pageIndex, bytes: new Uint8Array(buf) },
      [buf] as any
    );
  } catch (e) {
    console.error(`[thumbnail.worker] Thumbnail generation failed for page ${pageIndex + 1}:`, e);
    self.postMessage({ type: 'THUMBNAIL_ERROR', pageIndex });
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;
  if (type === 'LOAD_PDF') {
    handleLoadPdf(e.data.url || e.data.bytes);
  } else if (type === 'GENERATE_THUMBNAIL') {
    // await しない → 複数ページを協調並行処理
    handleGenerateThumbnail(e.data.pageIndex);
  }
};
