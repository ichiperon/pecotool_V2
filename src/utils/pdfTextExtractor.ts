import type * as pdfjsLib from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { PageData, TextBlock, BoundingBox } from '../types';
import { getCachedPageProxy } from './pdfLoader';
import { getCachedPage, setCachedPage, getTemporaryPageData } from './pdfTemporaryStorage';

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
  // メタデータの有無をキャッシュキーに含める。
  // 初回ロード（bboxMeta=null）とメタデータ到着後の再ロードで
  // 異なるキャッシュエントリを使い、古いデータが返るのを防ぐ。
  const hasMeta = bboxMeta && bboxMeta[String(pageIndex)]?.length > 0;
  const cacheKey = `${filePath}:${pageIndex}:${mtime ?? 0}${hasMeta ? ':m' : ''}`;
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
    const textContent = await page.getTextContent();

    // pdfjs v5 mixes TextItem and TextMarkedContent in items array.
    const allItems: Array<TextItem | TextMarkedContent> = textContent.items;
    // TextMarkedContent には str プロパティが存在しないため TypeGuard で TextItem のみに絞る
    const isTextItem = (item: TextItem | TextMarkedContent): item is TextItem =>
      typeof (item as TextItem).str === 'string';
    const textItems: TextItem[] = allItems.filter(isTextItem);

    let textBlocks: TextBlock[];

    // If PecoTool-saved bbox metadata is available for this page, use it directly.
    const savedMeta = bboxMeta?.[String(pageIndex)];
    if (savedMeta && savedMeta.length > 0) {
      const textByOrder = new Map<number, string>(
        textItems
          .filter((item) => item.str.trim() !== '')
          .map((item, idx) => [idx, item.str])
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
          // Perpendicular direction (above baseline) in PDF user space.
          // Use the actual perpendicular column (tx[2], tx[3]) from the transform
          // matrix instead of computing a 90° rotation from the text direction.
          // Some OCR tools (Adobe Acrobat etc.) use Y-axis-flipped coordinate
          // systems (negative determinant), which reverses the perpendicular
          // direction. Using (-uy, ux) would compute the ascent in the wrong
          // direction, shifting the bbox by ~2×ascent for those pages.
          const perpMag = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          // Degenerate transform (zero perpendicular column) → fall back to
          // 90° rotation of text direction
          const px = perpMag > 0.001 ? tx[2] / perpMag : -uy;
          const py = perpMag > 0.001 ? tx[3] / perpMag : ux;

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
