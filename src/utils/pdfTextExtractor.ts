import type * as pdfjsLib from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { PageData, TextBlock, BoundingBox } from '../types';
import { getCachedPageProxy } from './pdfLoader';
import { getCachedPage, setCachedPage, getTemporaryPageData } from './pdfTemporaryStorage';
import { perf } from './perfLogger';

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
  const [cached, tempEdited] = await Promise.all([
    getCachedPage(cacheKey),
    getTemporaryPageData(filePath, pageIndex),
  ]);

  let pageData: PageData;

  if (cached) {
    pageData = { ...cached, pageIndex };
  } else {
    // キャッシュ済みプロキシを再利用して二重getPageを回避
    const page = await getCachedPageProxy(filePath, pageIndex);
    const viewport = page.getViewport({ scale: 1.0 });
    perf.mark('text.getTextStart', { page: pageIndex });
    const textContent = await page.getTextContent();
    perf.mark('text.getTextDone', { page: pageIndex, items: textContent.items.length });

    // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
    const allItems: Array<TextItem | TextMarkedContent> = textContent.items;
    // TextMarkedContent には str プロパティが存在しないため TypeGuard で TextItem のみに絞る
    const isTextItem = (item: TextItem | TextMarkedContent): item is TextItem =>
      typeof (item as TextItem).str === 'string';
    const textItems: TextItem[] = allItems.filter(isTextItem);

    let textBlocks: TextBlock[];

    // If PecoTool-saved bbox metadata is available for this page, use it directly.
    // bbox と text は保存時に同一 TextBlock から同時に書かれているため、meta から
    // 直接読むことでペアの整合を保証する。pdfjs textItems 経由の idx マッチングは
    // drawText スキップ(空文字/0幅/非有限スケール)で件数が食い違い、text が後続
    // ブロックに 1 つズレる既知バグの原因となるため採用しない。
    const savedMeta = bboxMeta?.[String(pageIndex)];
    if (savedMeta && savedMeta.length > 0) {
      textBlocks = savedMeta.map((meta) => ({
        id: crypto.randomUUID(),
        text: meta.text,
        originalText: meta.text,
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
      const pageW = viewport.width;
      const pageH = viewport.height;
      let order = 0;
      textBlocks = textItems
        .filter((item) => item.str.trim() !== '')
        .map((item) => {
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
            writingMode: (isVertical ? 'vertical' : 'horizontal') as 'horizontal' | 'vertical',
            order: order++,
            isNew: false,
            isDirty: false,
          };
        })
        // OCRツールがForm XObjectを複数ページで共有している場合、getTextContent()が
        // 他ページのテキストも返すことがある。ページ範囲外のブロックを除外する。
        .filter(block => {
          const b = block.bbox;
          // bboxが完全にページ範囲外なら除外（少しのはみ出しは許容）
          const margin = Math.max(pageW, pageH) * 0.05;
          return b.x + b.width > -margin && b.x < pageW + margin
              && b.y + b.height > -margin && b.y < pageH + margin;
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
