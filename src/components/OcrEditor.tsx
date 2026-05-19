import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { usePecoStore } from '../store/pecoStore';
import { SortableOcrCard } from './SortableOcrCard';
import { OcrCardHandle } from './OcrCard';
import { Search } from 'lucide-react';
import { perf } from '../utils/perfLogger';

interface OcrEditorProps {
  width: number;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function OcrEditor({ width, searchInputRef }: OcrEditorProps) {
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

  // 仮想化対応: マウント/アンマウントされる各カードへの ref を id でひける Map に保持。
  // Virtuoso は可視範囲外のカードをアンマウントするので index ベースの配列は使えない。
  const cardRefs = useRef<Map<string, OcrCardHandle>>(new Map());
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const setCardRef = useCallback((id: string, handle: OcrCardHandle | null) => {
    if (handle) cardRefs.current.set(id, handle);
    else cardRefs.current.delete(id);
  }, []);

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
  const filteredBlocks = useMemo(
    () =>
      !isExtracting && currentPage?.textBlocks
        ? currentPage.textBlocks.filter(b =>
            b.text.toLowerCase().includes(searchTerm.toLowerCase())
          )
        : [],
    [isExtracting, currentPage?.textBlocks, searchTerm]
  );

  // SortableContext には全ての id を渡す必要があるため、フィルタ後 id 配列を memo 化。
  const filteredBlockIds = useMemo(
    () => filteredBlocks.map(b => b.id),
    [filteredBlocks]
  );

  // 仮想化中はカードがアンマウントされている可能性があるため、フォーカス先にスクロールしてから focus する。
  const focusBlockByIndex = useCallback((index: number) => {
    const targetId = filteredBlocks[index]?.id;
    if (!targetId) return;
    const existing = cardRefs.current.get(targetId);
    if (existing) {
      existing.focusContent();
      return;
    }
    // 可視範囲外: Virtuoso にスクロールさせてからマウント後に focus
    virtuosoRef.current?.scrollIntoView({
      index,
      behavior: 'auto',
      done: () => {
        // マウント完了を待ってから focus（scrollIntoView 直後はまだ DOM が無いことがある）
        setTimeout(() => {
          cardRefs.current.get(targetId)?.focusContent();
        }, 50);
      },
    });
  }, [filteredBlocks]);

  // ↑↓キーナビゲーション：選択 + フォーカス移動
  const handleNavigate = useCallback((currentBlockId: string, direction: 'up' | 'down') => {
    const currentIndex = filteredBlocks.findIndex(b => b.id === currentBlockId);
    if (currentIndex === -1) return;

    const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= filteredBlocks.length) return;

    const nextBlock = filteredBlocks[nextIndex];
    toggleSelection(nextBlock.id, false);

    // 少し待ってからフォーカスを移動（scrollIntoView と競合しないように）
    setTimeout(() => {
      focusBlockByIndex(nextIndex);
    }, 50);
  }, [filteredBlocks, toggleSelection, focusBlockByIndex]);

  const handleExtendSelection = useCallback((currentBlockId: string, direction: 'up' | 'down') => {
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
    // issue #15: Set の挿入順序ではなく nextBlock を明示的に anchor として store に渡す。
    // 旧実装は末尾再追加で順序を整えていたが、その結果次回の Shift+↑↓ の anchor 計算が
    // 末尾 id 依存になり、戻る操作で意図しないブロックに飛ぶケースがあった。
    setSelectedIds(Array.from(newSet), nextBlock.id);

    setTimeout(() => {
      focusBlockByIndex(nextIndex);
    }, 50);
  }, [filteredBlocks, selectedIds, setSelectedIds, focusBlockByIndex]);

  // window keydown listener は ref パターンで mount 時 1 回だけ登録する。
  // 以前は handleNavigate / handleExtendSelection / selectedIds / lastSelectedId 依存で
  // テキスト1文字編集ごとに addEventListener / removeEventListener が走り GC 圧/CPU コスト
  // が発生していた (issue #27)。
  const handleNavigateRef = useRef(handleNavigate);
  const handleExtendSelectionRef = useRef(handleExtendSelection);
  const selectedIdsRef = useRef(selectedIds);
  const lastSelectedIdRef = useRef(lastSelectedId);
  useEffect(() => { handleNavigateRef.current = handleNavigate; }, [handleNavigate]);
  useEffect(() => { handleExtendSelectionRef.current = handleExtendSelection; }, [handleExtendSelection]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { lastSelectedIdRef.current = lastSelectedId; }, [lastSelectedId]);

  useEffect(() => {
    const getAnchorId = () => {
      const lastId = lastSelectedIdRef.current;
      const ids = selectedIdsRef.current;
      if (lastId) return lastId;
      if (ids.size === 1) return Array.from(ids)[0];
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
      // Issue #84: モーダルが開いている間はグローバルキーハンドラを無効化する。
      // Modal は Tab/Esc のみキャプチャするので、Shift+Arrow 等が裏側に届いて
      // OCR カードの選択を巻き込んでしまう (= モーダル内 focus と OcrEditor 選択が
      // 二重で動く) のを防ぐ。
      // 注: スコープ内 `document` は store ステートで shadow されているので window.document を使う。
      if (typeof window !== 'undefined'
          && window.document?.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }

      const anchorId = getAnchorId();
      if (!anchorId) return;

      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 'down' : 'up';

      if (event.shiftKey) {
        handleExtendSelectionRef.current(anchorId, direction);
      } else {
        handleNavigateRef.current(anchorId, direction);
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, []);

  const handleSelect = useCallback((id: string, ctrl: boolean, shift: boolean) => {
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
  }, [filteredBlocks, lastSelectedId, selectedIds, setSelectedIds, toggleSelection]);

  // dnd-kit に必須: 仮想化中はカードがマウント/アンマウントされるため、
  // measuring を常時走らせて drop 計算に最新の rect を使わせる。
  const measuring = useMemo(
    () => ({ droppable: { strategy: MeasuringStrategy.Always } }),
    []
  );

  // Issue #92: renderItem を mount 1 回限りの stable callback にするため、
  // 毎レンダー変化する値 (filteredBlocks / currentPageIndex / handleSelect 等) を ref 経由で参照する。
  // これにより Virtuoso の itemContent identity が変化せず、SortableOcrCard 内 memo が機能して
  // 1 文字編集ごとに全 mounted カードが再評価される無駄を防ぐ (issue #27 / #68 と同パターン)。
  // 注: itemContent は render フェーズで Virtuoso 内部から呼ばれる可能性があるため、
  // useEffect ではなくレンダー中に直接代入して常に最新値が読めるようにする。
  const filteredBlocksRef = useRef(filteredBlocks);
  const currentPageIndexRef = useRef(currentPageIndex);
  const handleSelectRef = useRef(handleSelect);
  filteredBlocksRef.current = filteredBlocks;
  currentPageIndexRef.current = currentPageIndex;
  handleSelectRef.current = handleSelect;

  // Virtuoso の item レンダラ。memo化された SortableOcrCard へ stable な props を渡す。
  // setCardRef は空依存 useCallback で安定しているため、ここの依存配列は空にして
  // renderItem の identity を mount 中固定にする (Virtuoso itemContent の memoization 維持)。
  const renderItem = useCallback(
    (index: number) => {
      const block = filteredBlocksRef.current[index];
      if (!block) return null;
      return (
        <SortableOcrCard
          ref={(el) => setCardRef(block.id, el)}
          block={block}
          pageIndex={currentPageIndexRef.current}
          onNavigate={(dir) => handleNavigateRef.current(block.id, dir)}
          onExtendSelection={(dir) => handleExtendSelectionRef.current(block.id, dir)}
          onSelect={(id, ctrl, shift) => handleSelectRef.current(id, ctrl, shift)}
        />
      );
    },
    []
  );

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
            measuring={measuring}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={filteredBlockIds}
              strategy={verticalListSortingStrategy}
            >
              <Virtuoso
                ref={virtuosoRef}
                className="ocr-card-list"
                style={{ height: '100%' }}
                totalCount={filteredBlocks.length}
                itemContent={renderItem}
                overscan={400}
                increaseViewportBy={{ top: 400, bottom: 400 }}
              />
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
