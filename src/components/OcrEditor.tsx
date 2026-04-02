import { useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { SortableOcrCard } from './SortableOcrCard';
import { OcrCardHandle } from './OcrCard';
import { Search } from 'lucide-react';

interface OcrEditorProps {
  width: number;
}

export function OcrEditor({ width }: OcrEditorProps) {
  const { document, currentPageIndex, updatePageData, toggleSelection, selectedIds, lastSelectedId, setSelectedIds } = usePecoStore();
  const currentPage = document?.pages.get(currentPageIndex);
  const [searchTerm, setSearchTerm] = useState("");

  // 各カードへの ref 配列
  const cardRefs = useRef<(OcrCardHandle | null)[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: searchTerm
        ? { distance: Infinity }
        : { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id && currentPage) {
      const oldIndex = currentPage.textBlocks.findIndex((b) => b.id === active.id);
      const newIndex = currentPage.textBlocks.findIndex((b) => b.id === over.id);
      
      const newBlocks = arrayMove(currentPage.textBlocks, oldIndex, newIndex).map((b, i) => ({
        ...b,
        order: i,
        isDirty: b.isDirty || oldIndex !== newIndex
      }));

      updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    }
  };

  const filteredBlocks = currentPage?.textBlocks.filter(b =>
    b.text.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  // ↑↓キーナビゲーション：選択 + フォーカス移動
  const handleNavigate = (currentBlockId: string, direction: 'up' | 'down') => {
    const currentIndex = filteredBlocks.findIndex(b => b.id === currentBlockId);
    if (currentIndex === -1) return;

    const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= filteredBlocks.length) return;

    const nextBlock = filteredBlocks[nextIndex];
    toggleSelection(nextBlock.id, false);

    // 少し待ってからフォーカスを移動（scrollIntoView と競合しないように）
    setTimeout(() => {
      cardRefs.current[nextIndex]?.focusContent();
    }, 50);
  };

  const handleSelect = (id: string, ctrl: boolean, shift: boolean) => {
    if (shift && lastSelectedId) {
      const startIdx = filteredBlocks.findIndex(b => b.id === lastSelectedId);
      const endIdx = filteredBlocks.findIndex(b => b.id === id);
      if (startIdx !== -1 && endIdx !== -1) {
        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);
        const rangeIds = filteredBlocks.slice(min, max + 1).map(b => b.id);
        
        if (ctrl) {
          const newSet = new Set(selectedIds);
          rangeIds.forEach(rId => newSet.add(rId));
          setSelectedIds(Array.from(newSet));
        } else {
          setSelectedIds(rangeIds);
        }
        return;
      }
    }
    toggleSelection(id, ctrl || shift);
  };

  return (
    <aside className="editor-panel" style={{ width: `${width}px` }}>
      <div className="panel-header">
        <span>OCRテキスト</span>
        <div className="search-container">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            placeholder="検索..."
            className="search-box"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>
      <div className="scroll-content">
        {!document ? (
          <div className="placeholder">データなし</div>
        ) : !currentPage ? (
          <div className="placeholder">読み込み中...</div>
        ) : currentPage.textBlocks.length === 0 ? (
          <div className="placeholder placeholder--no-ocr">OCRテキストなし</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={filteredBlocks.map(b => b.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="ocr-card-list">
                {filteredBlocks.map((block, index) => (
                  <SortableOcrCard
                    key={block.id}
                    ref={(el) => { cardRefs.current[index] = el; }}
                    block={block}
                    pageIndex={currentPageIndex}
                    onNavigate={(dir) => handleNavigate(block.id, dir)}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </aside>
  );
}
