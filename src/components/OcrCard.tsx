import React, { useRef, useEffect } from "react";
import { GripVertical } from "lucide-react";
import { TextBlock, WritingMode } from "../types";
import { usePecoStore } from "../store/pecoStore";

interface OcrCardProps {
  block: TextBlock;
  pageIndex: number;
  dragListeners?: any;
}

export function OcrCard({ block, pageIndex, dragListeners }: OcrCardProps) {
  const { updatePageData, document, selectedIds, toggleSelection } = usePecoStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedIds.has(block.id);

  // 選択されたら自動スクロール
  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isSelected]);

  // contentEditable の内容は React children ではなく DOM API で同期する
  // React は contentEditable の子要素を正しく更新できない既知の問題がある
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
    // If clicking the text content for editing, don't toggle selection if already selected
    if (contentRef.current?.contains(e.target as Node) && isSelected) return;
    toggleSelection(block.id, e.ctrlKey || e.shiftKey);
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
        suppressContentEditableWarning
      />

    </div>
  );
}
