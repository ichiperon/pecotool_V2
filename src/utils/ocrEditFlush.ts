import type { PecoDocument, PageData } from '../types';

type UpdatePageDataFn = (pageIndex: number, data: Partial<PageData>) => void;

/**
 * フォーカス中の .ocr-card-content DOM テキストを store へ確定する pure util。
 * store への依存をなくすため updatePageData と document を引数で受け取る。
 */
export function flushActiveOcrCardText(
  updatePageData: UpdatePageDataFn,
  document: PecoDocument | null,
): boolean {
  if (typeof window === 'undefined') return false;

  const active = window.document.activeElement;
  if (!(active instanceof HTMLElement)) return false;

  const content = active.closest<HTMLElement>('.ocr-card-content[data-page-index][data-block-id]');
  if (!content) return false;

  const pageIndex = Number(content.dataset.pageIndex);
  const blockId = content.dataset.blockId;
  if (!Number.isInteger(pageIndex) || !blockId) return false;

  const page = document?.pages.get(pageIndex);
  if (!page) return false;

  const nextText = content.textContent ?? '';
  const block = page.textBlocks.find((item) => item.id === blockId);
  if (!block || block.text === nextText) return false;

  updatePageData(pageIndex, {
    textBlocks: page.textBlocks.map((item) =>
      item.id === blockId ? { ...item, text: nextText, isDirty: true } : item
    ),
    isDirty: true,
  });

  return true;
}
