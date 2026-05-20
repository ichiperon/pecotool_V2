import { useEffect, useRef } from 'react';
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
import { perf } from '../utils/perfLogger';
import { InspectionPanel } from './InspectionPanel';
import { countInspectionIssues, useInspectionStore } from '../store/inspectionStore';
import type { TextInspectionScope } from '../hooks/useTextInspection';

export type OcrEditorTab = 'ocr' | 'inspection';

interface OcrEditorProps {
  width: number;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  activeTab: OcrEditorTab;
  onActiveTabChange: (tab: OcrEditorTab) => void;
  onRunInspection: (scope?: TextInspectionScope) => void | Promise<void>;
}

export function OcrEditor({
  width,
  searchInputRef,
  activeTab,
  onActiveTabChange,
  onRunInspection,
}: OcrEditorProps) {
  const document = usePecoStore(s => s.document);
  const currentPageIndex = usePecoStore(s => s.currentPageIndex);
  const selectedIds = usePecoStore(s => s.selectedIds);
  const lastSelectedId = usePecoStore(s => s.lastSelectedId);
  const updatePageData = usePecoStore(s => s.updatePageData);
  const toggleSelection = usePecoStore(s => s.toggleSelection);
  const setSelectedIds = usePecoStore(s => s.setSelectedIds);
  const currentPage = document?.pages.get(currentPageIndex);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const inspectionIssues = useInspectionStore(s => s.issuesByPage.get(currentPageIndex));
  const visibleInspectionIssues = (inspectionIssues ?? []).filter(issue => !issue.ignored);
  const inspectionCounts = countInspectionIssues(visibleInspectionIssues);

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
    // 検索フィルタ適用中はDnDを無効化（フィルタ外ブロックの順序破壊を防ぐ）
    if (searchTerm) return;

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

      perf.mark('ui.cardReorderMulti', { page: currentPageIndex, count: selected.length });
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
      perf.mark('ui.cardReorderSingle', { page: currentPageIndex, from: oldIndex, to: newIndex });
      updatePageData(currentPageIndex, { textBlocks: newBlocks, isDirty: true });
    }
  };

  // 抽出完了前 (isTextExtracted !== true) は textBlocks がプレースホルダの空配列か
   // 古いデータの可能性があるため、検索 filter を走らせない。
  const isExtracting = !!currentPage && currentPage.isTextExtracted !== true;
  const filteredBlocks = (!isExtracting && currentPage?.textBlocks
    ? currentPage.textBlocks.filter(b =>
        b.text.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : []);

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

  const handleExtendSelection = (currentBlockId: string, direction: 'up' | 'down') => {
    const currentIndex = filteredBlocks.findIndex(b => b.id === currentBlockId);
    if (currentIndex === -1) return;

    const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= filteredBlocks.length) return;

    const currentBlock = filteredBlocks[currentIndex];
    const nextBlock = filteredBlocks[nextIndex];
    const newSet = new Set(selectedIds);
    if (selectedIds.has(currentBlock.id) && selectedIds.has(nextBlock.id) && selectedIds.size > 1) {
      newSet.delete(currentBlock.id);
    } else {
      newSet.add(currentBlock.id);
      newSet.add(nextBlock.id);
    }
    const newIds = Array.from(newSet).filter(id => id !== nextBlock.id);
    setSelectedIds([...newIds, nextBlock.id]);

    setTimeout(() => {
      cardRefs.current[nextIndex]?.focusContent();
    }, 50);
  };

  useEffect(() => {
    const getAnchorId = () => {
      if (lastSelectedId) return lastSelectedId;
      if (selectedIds.size === 1) return Array.from(selectedIds)[0];
      return null;
    };

    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
        || !!target.closest('[contenteditable="true"]');
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (!event.ctrlKey && !event.shiftKey) return;
      if (isEditableTarget(event.target)) return;

      const anchorId = getAnchorId();
      if (!anchorId) return;

      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 'down' : 'up';

      if (event.shiftKey) {
        handleExtendSelection(anchorId, direction);
      } else {
        handleNavigate(anchorId, direction);
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [handleNavigate, handleExtendSelection, lastSelectedId, selectedIds]);

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
        <div className="editor-tabs" role="tablist" aria-label="右ペイン表示">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ocr'}
            className={`editor-tab ${activeTab === 'ocr' ? 'active' : ''}`}
            onClick={() => onActiveTabChange('ocr')}
          >
            OCRテキスト
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'inspection'}
            className={`editor-tab ${activeTab === 'inspection' ? 'active' : ''}`}
            onClick={() => onActiveTabChange('inspection')}
          >
            検査結果
          </button>
        </div>
        {activeTab === 'ocr' ? (
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
        ) : (
          <div className="inspection-header-actions">
            <div className="inspection-count-badges" aria-label="検査件数">
              <span className="inspection-count-badge error">エラー {inspectionCounts.error}</span>
              <span className="inspection-count-badge warning">警告 {inspectionCounts.warning}</span>
              <span className="inspection-count-badge info">確認 {inspectionCounts.info}</span>
            </div>
          </div>
        )}
      </div>
      {activeTab === 'inspection' ? (
        <InspectionPanel embedded onRunInspection={onRunInspection} />
      ) : (
        <div className="scroll-content">
        {!document ? (
          <div className="placeholder">データなし</div>
        ) : !currentPage ? (
          <div className="placeholder">読み込み中...</div>
        ) : isExtracting ? (
          <div className="ocr-loading-placeholder">
            <div className="loading-spinner" />
            <div className="loading-message">テキスト抽出中...</div>
          </div>
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
                    onExtendSelection={(dir) => handleExtendSelection(block.id, dir)}
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
      )}
    </aside>
  );
}
