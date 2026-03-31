import React, { useRef, useEffect } from "react";
import { GripVertical } from "lucide-react";
import { TextBlock } from "../types";
import { usePecoStore } from "../store/pecoStore";

interface OcrCardProps {
  block: TextBlock;
  pageIndex: number;
  dragListeners?: any;
}

export function OcrCard({ block, pageIndex, dragListeners }: OcrCardProps) {
  const { updatePageData, document, selectedIds, toggleSelection } = usePecoStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedIds.has(block.id);

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
    // Implementation of context menu could be a simple state or a library
    // For now, we'll just ensure selection and we can add a custom menu later
    if (!isSelected) {
      toggleSelection(block.id, false);
    }
  };

  return (
    <div 
      className={`ocr-card ${block.isDirty ? 'dirty' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="ocr-card-header">
        <div {...dragListeners} style={{ cursor: 'grab', opacity: 0.5, display: 'flex', alignItems: 'center' }} title="ドラッグして並び替え">
          <GripVertical size={14} />
        </div>
        <span>#{block.order + 1}</span>
        <span className="mode-badge">{block.writingMode === 'vertical' ? '縦書き' : '横書き'}</span>
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
