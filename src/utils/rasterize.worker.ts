import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, PDFName, PDFHexString, PDFDict, degrees, pushGraphicsState, popGraphicsState, translate, scale } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PageData, PDFMetadata } from '../types';

// pdfjs-dist v5 では workerSrc='' がエラーになるため正規のWorker URLを指定する
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

const BATCH_SIZE = 4;

async function renderPageToJpeg(
  pdfJsDoc: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  quality: number
): Promise<{ jpegBytes: Uint8Array; width: number; height: number }> {
  const jsPage = await pdfJsDoc.getPage(pageIndex + 1);
  const viewport = jsPage.getViewport({ scale });

  const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

  // pdfjs の render() 型は CanvasRenderingContext2D / HTMLCanvasElement を要求するが、
  // Worker 内ではそれらが存在しないため OffscreenCanvas 系を unknown 経由で渡す。
  await jsPage.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const arrayBuffer = await blob.arrayBuffer();
  return {
    jpegBytes: new Uint8Array(arrayBuffer),
    width: viewport.width,
    height: viewport.height,
  };
}

type RasterizeRequest = {
  type: 'RASTERIZE_PDF';
  data: {
    originalPdfBytes: Uint8Array;
    documentState: { pages: Record<number, Omit<PageData, 'thumbnail'>>; metadata?: PDFMetadata };
    quality: number;
    fontBytes?: ArrayBuffer;
  };
};

self.onmessage = async (e: MessageEvent<RasterizeRequest>) => {
  const { type, data } = e.data;
  if (type !== 'RASTERIZE_PDF') return;

  try {
    const { originalPdfBytes, documentState, quality, fontBytes } = data;

    const renderScale = 1.0;

    // pdfjs でレンダリング用にロード
    const pdfJsDoc = await pdfjsLib.getDocument({
      data: originalPdfBytes.slice(),
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
    }).promise;

    const totalPages = pdfJsDoc.numPages;

    // 全ページをバッチ並列でJPEGにレンダリング
    const jpegResults: Array<{ jpegBytes: Uint8Array; width: number; height: number }> = new Array(totalPages);

    for (let batchStart = 0; batchStart < totalPages; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalPages);
      const batch = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i);

      const results = await Promise.all(
        batch.map(pageIndex => renderPageToJpeg(pdfJsDoc, pageIndex, renderScale, quality))
      );

      for (let i = 0; i < results.length; i++) {
        jpegResults[batchStart + i] = results[i];
      }

      // 進捗通知
      self.postMessage({ type: 'RASTERIZE_PROGRESS', current: batchEnd, total: totalPages });
    }

    // pdf-lib で新規PDFを構築
    const newPdf = await PDFDocument.create();
    newPdf.registerFontkit(fontkit);

    const customFont = fontBytes
      ? await newPdf.embedFont(fontBytes, { subset: true })
      : await newPdf.embedFont(StandardFonts.Helvetica);

    type BBoxMetaEntry = {
      bbox: PageData['textBlocks'][number]['bbox'];
      writingMode: PageData['textBlocks'][number]['writingMode'];
      order: number;
      text: string;
    };
    const bboxMeta: Record<string, BBoxMetaEntry[]> = {};

    for (let i = 0; i < totalPages; i++) {
      const { jpegBytes, width, height } = jpegResults[i];

      const jpgImage = await newPdf.embedJpg(jpegBytes);
      const pageW = width / renderScale;
      const pageH = height / renderScale;
      const page = newPdf.addPage([pageW, pageH]);

      page.drawImage(jpgImage, { x: 0, y: 0, width: pageW, height: pageH });

      const pageData = documentState.pages[i];
      if (pageData) {
        const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);
        bboxMeta[String(i)] = sortedBlocks.map((b) => ({
          bbox: b.bbox,
          writingMode: b.writingMode,
          order: b.order,
          text: b.text,
        }));

        for (const block of sortedBlocks) {
          if (!block.text) continue;
          try {
            const fontSize = 1;
            const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
            const textHeight = customFont.heightAtSize(fontSize);
            
            if (textWidth === 0 || textHeight === 0) continue;

            if (block.writingMode === 'vertical') {
              const sx = block.bbox.width / textHeight;
              const sy = block.bbox.height / textWidth;
              
              if (!isFinite(sx) || !isFinite(sy)) continue;

              const baselineX = block.bbox.x + textHeight * sx * 0.2;
              const baselineY = pageH - block.bbox.y;
              page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
              page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
              page.pushOperators(popGraphicsState());
            } else {
              const sx = block.bbox.width / textWidth;
              const sy = block.bbox.height / textHeight;
              
              if (!isFinite(sx) || !isFinite(sy)) continue;

              const baselineY = pageH - block.bbox.y - textHeight * sy * 0.8;
              page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
              page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, opacity: 0 });
              page.pushOperators(popGraphicsState());
            }
          } catch { /* ignore block draw errors */ }
        }
      }
    }

    newPdf.setTitle(documentState.metadata?.title || 'OCR Document');
    newPdf.setCreator('PecoTool V2');

    const infoDict = (newPdf as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
    if (infoDict) {
      infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
    }

    const savedBytes = await newPdf.save({ useObjectStreams: true, addDefaultPage: false });
    // tsconfig に WebWorker lib が無いため Worker 版 postMessage 型を明示する
    (self.postMessage as (m: unknown, transfer: Transferable[]) => void)(
      { type: 'RASTERIZE_SUCCESS', data: savedBytes },
      [savedBytes.buffer]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'ERROR', message });
  }
};
