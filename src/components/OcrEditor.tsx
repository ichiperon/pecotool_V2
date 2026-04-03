import { useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
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
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function OcrEditor({ width, searchInputRef }: OcrEditorProps) {
  const { document, currentPageIndex, updatePageData, toggleSelection, selectedIds, lastSelectedId, setSelectedIds } = usePecoStore();
  const currentPage = document?.pages.get(currentPageIndex);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

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

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id || !currentPage) return;

    const blocks = currentPage.textBlocks;
    const activeIsSelected = selectedIds.has(active.id as string);

    if (activeIsSelected && selectedIds.size > 1) {
      // 複数選択ドラッグ: 選択グループをまとめて over の位置に移動
      const overIndex = blocks.findIndex((b) => b.id === over.id);
      const selected = blocks.filter((b) => selectedIds.has(b.id));
      const notSelected = blocks.filter((b) => !selectedIds.has(b.id));

      // over が選択外のブロックの場合のみ挿入位置を決定
      const overIsSelected = selectedIds.has(over.id as string);
      let insertIndex: number;
      if (overIsSelected) {
        // ドロップ先も選択中の場合: active と over の位置関係で決める
        const activeIndex = blocks.findIndex((b) => b.id === active.id);
        insertIndex = overIndex > activeIndex
          ? notSelected.findIndex((b) => {
              const idx = blocks.findIndex((bb) => bb.id === b.id);
              return idx > overIndex;
            })
          : notSelected.findIndex((b) => {
              const idx = blocks.findIndex((bb) => bb.id === b.id);
              return idx >= overIndex;
            });
        if (insertIndex === -1) insertIndex = notSelected.length;
      } else {
        // over が選択外: そのブロックの前後に挿入
        const activeIndex = blocks.findIndex((b) => b.id === active.id);
        if (overIndex > activeIndex) {
          // 下に移動: over の後ろ側に挿入
          insertIndex = notSelected.findIndex((b) => {
            const idx = blocks.findIndex((bb) => bb.id === b.id);
            return idx > overIndex;
          });
          if (insertIndex === -1) insertIndex = notSelected.length;
        } else {
          // 上に移動: over の手前に挿入
          insertIndex = notSelected.findIndex((b) => {
            const idx = blocks.findIndex((bb) => bb.id === b.id);
            return idx >= overIndex;
          });
          if (insertIndex === -1) insertIndex = notSelected.length;
        }
      }

      const newBlocks = [
        ...notSelected.slice(0, insertIndex),
        ...selected,
        ...notSelected.slice(insertIndex),
      ].map((b, i) => ({ ...b, order: i, isDirty: true }));

      updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    } else {
      // 単一ドラッグ（従来通り）
      const oldIndex = blocks.findIndex((b) => b.id === active.id);
      const newIndex = blocks.findIndex((b) => b.id === over.id);
      const newBlocks = arrayMove(blocks, oldIndex, newIndex).map((b, i) => ({
        ...b,
        order: i,
        isDirty: b.isDirty || oldIndex !== newIndex,
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
            ref={searchInputRef}
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
            onDragStart={handleDragStart}
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
            {activeId && selectedIds.has(activeId) && selectedIds.size > 1 && (() => {
              const activeBlock = filteredBlocks.find(b => b.id === activeId);
              if (!activeBlock) return null;
              return (
                <DragOverlay>
                  <div className="drag-overlay-wrapper">
                    <div className="ocr-card selected">
                      <div className="ocr-card-header">
                        <span>#{activeBlock.order + 1}</span>
                        <span className="mode-badge">{activeBlock.writingMode === 'vertical' ? '縦書き' : '横書き'}</span>
                      </div>
                      <div className="ocr-card-content">{activeBlock.text}</div>
                    </div>
                    <div className="drag-selection-badge">{selectedIds.size}</div>
                  </div>
                </DragOverlay>
              );
            })()}
          </DndContext>
        )}
      </div>
    </aside>
  );
}
