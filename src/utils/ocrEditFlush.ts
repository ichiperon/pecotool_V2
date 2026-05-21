import { usePecoStore } from '../store/pecoStore';

export function flushActiveOcrCardText(): boolean {
  if (typeof window === 'undefined') return false;

  const active = window.document.activeElement;
  if (!(active instanceof HTMLElement)) return false;

  const content = active.closest<HTMLElement>('.ocr-card-content[data-page-index][data-block-id]');
  if (!content) return false;

  const pageIndex = Number(content.dataset.pageIndex);
  const blockId = content.dataset.blockId;
  if (!Number.isInteger(pageIndex) || !blockId) return false;

  const { document, updatePageData } = usePecoStore.getState();
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
