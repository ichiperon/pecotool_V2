import React, { useState } from 'react';
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
import { usePecoStore } from '../store/pecoStore';
import { SortableOcrCard } from './SortableOcrCard';
import { Search } from 'lucide-react';

export function OcrEditor() {
  const { document, currentPageIndex, updatePageData } = usePecoStore();
  const currentPage = document?.pages.get(currentPageIndex);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Avoid triggering drag on click/edit
      },
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

  return (
    <aside className="editor-panel">
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
                {filteredBlocks.map(block => (
                  <SortableOcrCard 
                    key={block.id} 
                    block={block} 
                    pageIndex={currentPageIndex} 
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
