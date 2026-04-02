import React, { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { GripVertical } from "lucide-react";
import { TextBlock, WritingMode } from "../types";
import { usePecoStore } from "../store/pecoStore";

export interface OcrCardHandle {
  focusContent: () => void;
}

interface OcrCardProps {
  block: TextBlock;
  pageIndex: number;
  dragListeners?: any;
  onNavigate?: (direction: 'up' | 'down') => void;
  onSelect?: (id: string, ctrl: boolean, shift: boolean) => void;
}

export const OcrCard = forwardRef<OcrCardHandle, OcrCardProps>(
  function OcrCard({ block, pageIndex, dragListeners, onNavigate, onSelect }, ref) {
  const { updatePageData, document, selectedIds, toggleSelection } = usePecoStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedIds.has(block.id);

  // 外部からテキストエリアにフォーカスできるようにする
  useImperativeHandle(ref, () => ({
    focusContent: () => {
      const el = contentRef.current;
      if (!el) return;
      el.focus();
      // カーソルを末尾に移動
      const range = window.document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }));

  // 選択されたら自動スクロール
  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isSelected]);

  // contentEditable の内容は React children ではなく DOM API で同期する
  useEffect(() => {
    if (contentRef.current && contentRef.current.textContent !== block.text) {
      contentRef.current.textContent = block.text;
    }
  }, [block.text]);

  const handleBlur = () => {
    const newText = contentRef.current?.innerText || "";
    if (newText !== block.text) {
      const page = document?.pages.get(pageIndex);
      if (page) {
        const newBlocks = page.textBlocks.map(b =>
          b.id === block.id ? { ...b, text: newText, isDirty: true } : b
        );
        updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true });
      }
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (contentRef.current?.contains(e.target as Node) && isSelected) return;
    if (onSelect) {
      onSelect(block.id, e.ctrlKey || e.metaKey, e.shiftKey);
    } else {
      toggleSelection(block.id, e.ctrlKey || e.metaKey || e.shiftKey);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!isSelected) {
      toggleSelection(block.id, false);
    }
  };

  const toggleWritingMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newMode: WritingMode = block.writingMode === 'vertical' ? 'horizontal' : 'vertical';
    const page = document?.pages.get(pageIndex);
    if (page) {
      const newBlocks = page.textBlocks.map(b =>
        b.id === block.id ? { ...b, writingMode: newMode, isDirty: true } : b
      );
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!onNavigate || !e.ctrlKey) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onNavigate('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onNavigate('up');
    }
  };

  return (
    <div
      ref={cardRef}
      className={`ocr-card ${block.isDirty ? 'dirty' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="ocr-card-header">
        <div {...dragListeners} style={{ cursor: 'grab', opacity: 0.5, display: 'flex', alignItems: 'center' }} title="ドラッグして並び替え">
          <GripVertical size={14} />
        </div>
        <span>#{block.order + 1}</span>
        <button
          className="mode-badge"
          onClick={toggleWritingMode}
          title="クリックで縦書き/横書きを切り替え"
        >
          {block.writingMode === 'vertical' ? '縦書き' : '横書き'}
        </button>
        {block.isDirty && <span className="dirty-dot">●</span>}
      </div>
      <div
        ref={contentRef}
        className="ocr-card-content"
        contentEditable
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        suppressContentEditableWarning
      />
    </div>
  );
});
