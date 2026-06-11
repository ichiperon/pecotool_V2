import type * as pdfjsLib from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { PageData, TextBlock, BoundingBox } from '../types';
import { getCachedPageProxy } from './pdfLoader';
import { getCachedPage, setCachedPage, getTemporaryPageData } from './pdfTemporaryStorage';
import { perf } from './perfLogger';

type PecoToolBBoxMetaEntry = {
  bbox: BoundingBox;
  writingMode: string;
  order: number;
  text: string;
  /** OCR 信頼度 (0..1)。PCT-047: 永続化・復元のために追加。後方互換のため optional。 */
  confidence?: number;
};

type LoadPageOptions = {
  displayPageIndex?: number;
};

export function shouldUseSavedMeta(
  savedMeta: PecoToolBBoxMetaEntry[] | undefined,
  textItems: TextItem[],
): savedMeta is PecoToolBBoxMetaEntry[] {
  if (!savedMeta || savedMeta.length === 0) return false;
  const nonEmptyTextItemCount = textItems.filter((item) => item.str.trim() !== '').length;
  if (nonEmptyTextItemCount === 0) return true;
  const overFragmentedThreshold = Math.max(nonEmptyTextItemCount * 2, nonEmptyTextItemCount + 25);
  return savedMeta.length <= overFragmentedThreshold;
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
    /** OCR 信頼度 (0..1)。PCT-047: 後方互換のため optional。 */
    confidence?: number;
  }>> | null,
  mtime?: number,
  options?: LoadPageOptions,
): Promise<PageData> {
  const displayPageIndex = options?.displayPageIndex ?? pageIndex;
  // #99: meta 有無でキャッシュキーを分離する。
  // meta なしで pdfjs textItems の transform から bbox を fallback 計算した結果は、
  // meta あり経路 (保存メタの viewport-space bbox) と数学的に別物 (ascent ratio や
  // thickness の扱いが異なる)。同一キーで保存すると、初回 meta-未解決ロード後に
  // meta が利用可能になっても古い fallback bbox が IDB から再生され続けて固着する。
  // savedMeta の有無 (`m1` / `m0`) を mix-in して分離する。
  const hasMeta = !!(bboxMeta && bboxMeta[String(pageIndex)] && bboxMeta[String(pageIndex)].length > 0);
  const cacheKey = `${filePath}:${pageIndex}:${mtime ?? 0}:${hasMeta ? 'm1' : 'm0'}`;
  // PCT-104 (A-lite 段階2): pageId = "src:" + sourceIndex (pageIndex)。
  // IDB temporary_changes は pageId キーで読む。displayPageIndex ではなく pageIndex を使う。
  const pageIdForIdb = `src:${pageIndex}`;
  const [cached, tempEdited] = await Promise.all([
    getCachedPage(cacheKey),
    getTemporaryPageData(filePath, pageIdForIdb),
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
    if (shouldUseSavedMeta(savedMeta, textItems)) {
      textBlocks = savedMeta.map((meta) => ({
        id: crypto.randomUUID(),
        text: meta.text,
        originalText: meta.text,
        bbox: meta.bbox,
        writingMode: meta.writingMode as 'horizontal' | 'vertical',
        order: meta.order,
        isNew: false,
        isDirty: false,
        // PCT-047: 永続化された confidence を復元する。
        // 欠如時 (既存 PDF) は undefined のままにして legacy 扱い（色付けしない）とする。
        ...(meta.confidence !== undefined ? { confidence: meta.confidence } : {}),
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
          // #112: bbox の ascent を実フォントのメトリクスから導く。
          // pdfjs `getTextContent()` は `textContent.styles[fontName].ascent` に
          // 正規化済みフォント ascent 比 (font ascent / 1000 units-per-em ≒ 0.7〜0.95)
          // を持つ。旧実装の固定係数 1.16 はどの実フォントの ascent 比よりも大きく、
          // meta なし PDF (外部 OCR PDF の初回オープン等) で OCR BB が上方向へ
          // ずれていた (兄弟 issue #110 の保存側修正に対応する再読込側の修正)。
          // styles が取れない / 値が非有限 or 非正のフォントだけ 1.16 にフォールバック。
          const style = item.fontName ? textContent.styles?.[item.fontName] : undefined;
          const ascentRatio = style && Number.isFinite(style.ascent) && style.ascent > 0
            ? style.ascent
            : 1.16;
          const ascent = thickness * ascentRatio;

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

          // 修正 (#39): writing mode は PDF 座標系 (ux, uy) だけで判定する。
          // 旧実装は viewport.convertToViewportPoint() を通したスクリーン座標で比較
          // していたが、ページが /Rotate 270 (または 90) の場合 viewport 変換は
          // 軸を入れ替えるため、PDF 上で横書き (ux≈1, uy≈0) の run がスクリーン上では
          // 縦方向に見え、誤って vertical 判定される逆転が起きていた。
          // run 方向は PDF user space のフォント行列に保存されているので、
          // PDF 座標で |uy| > |ux| を見ればページ回転に依らず正しく分類できる。
          const isVertical = Math.abs(uy) > Math.abs(ux);

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

  // PCT-104 (A-lite 段階0): pageId を付与する。
  // 値は "src:" + 初期 source index (pageIndex)。move/delete/rotate/undo/redo を通じて不変。
  // tempEdited に pageId が入っている場合はそちらを優先する（段階2以降で IDB から復元される）。
  const pageId = pageData.pageId ?? `src:${pageIndex}`;

  return { ...pageData, pageIndex: displayPageIndex, pageId };
}
