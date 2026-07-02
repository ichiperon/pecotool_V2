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
import { usePecoStore, selectCurrentPage, selectHasDocument } from '../store/pecoStore';
import { useViewerStore } from '../store/viewerStore';
import { useSearchStore, selectSearchTerm, selectSearchHitIndex } from '../store/searchStore';
import { SortableOcrCard } from './SortableOcrCard';
import { OcrCardHandle } from './OcrCard';
import { Search } from 'lucide-react';
import { perf } from '../utils/perfLogger';
import { getProblematicBlockIds } from '../utils/blockQuality';
import { useOcrSettingsStore } from '../store/ocrSettingsStore';

interface OcrEditorProps {
  width: number;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function OcrEditor({
  width,
  searchInputRef,
}: OcrEditorProps) {
  // issue #134: 旧 `const document = usePecoStore(s => s.document)` は
  // 別ページの updatePageData でも document 参照が変わって OcrEditor 全体が
  // 再レンダされていた。currentPage selector に切り替えると textBlocks 配列が
  // 同参照のままなら再レンダされない。
  const currentPageIndex = usePecoStore(s => s.currentPageIndex);
  const currentPage = usePecoStore(selectCurrentPage);
  const hasDocument = usePecoStore(selectHasDocument);
  const selectedIds = usePecoStore(s => s.selectedIds);
  const lastSelectedId = usePecoStore(s => s.lastSelectedId);
  const updatePageData = usePecoStore(s => s.updatePageData);
  const toggleSelection = usePecoStore(s => s.toggleSelection);
  const setSelectedIds = usePecoStore(s => s.setSelectedIds);
  // issue #196: searchTerm を store で共有 (PdfCanvas もハイライトに使う)
  const searchTerm = useSearchStore(selectSearchTerm);
  const searchHitIndex = useSearchStore(selectSearchHitIndex);
  const setSearchTerm = useSearchStore(s => s.setSearchTerm);
  const nextSearchHit = useSearchStore(s => s.nextSearchHit);
  const prevSearchHit = useSearchStore(s => s.prevSearchHit);
  const clampSearchHitIndex = useSearchStore(s => s.clampSearchHitIndex);
  const [activeId, setActiveId] = useState<string | null>(null);

  // PCT-048: トグル状態を購読して problematicIds の useMemo に含める
  const showLowConfidenceHighlight = useOcrSettingsStore(s => s.showLowConfidenceHighlight);

  // PCT-048: Compute problematic block IDs for the current page once per
  // textBlocks change, so each OcrCard can look up membership in O(1).
  // Guard with showLowConfidenceHighlight so we skip the O(N^2) overlap scan
  // when the feature is disabled.
  const problematicIds = useMemo(() => {
    if (!showLowConfidenceHighlight || !currentPage?.textBlocks?.length) {
      return new Set<string>();
    }
    return getProblematicBlockIds(currentPage.textBlocks);
  }, [showLowConfidenceHighlight, currentPage?.textBlocks]);

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

  // issue #196: 現在ページの全ブロックのうち searchTerm にヒットするものを順番に収集。
  // filteredBlocks とは異なり、全 textBlocks を対象にする（フィルタ前）。
  // この配列のインデックスが searchHitIndex に対応する。
  const searchHitBlocks = useMemo(() => {
    if (!searchTerm || !currentPage?.textBlocks) return [];
    const lower = searchTerm.toLowerCase();
    return currentPage.textBlocks.filter(b => b.text.toLowerCase().includes(lower));
  }, [searchTerm, currentPage?.textBlocks]);

  const totalHits = searchHitBlocks.length;

  // issue #196: 現在の active ヒットブロックを画面中央にスクロールする。
  // PdfCanvas の selectedIds スクロールと同パターン。
  const scrollToHitBlock = useCallback((hitIndex: number, blocks: typeof searchHitBlocks) => {
    const block = blocks[hitIndex];
    if (!block) return;
    const container = window.document.querySelector('.pdf-viewer-panel');
    if (!container) return;
    // zoom は viewerStore から直接読む
    const zoom = useViewerStore.getState().zoom;
    const scale = zoom / 100;
    const x = block.bbox.x * scale;
    const y = block.bbox.y * scale;
    const w = block.bbox.width * scale;
    const h = block.bbox.height * scale;
    const containerRect = container.getBoundingClientRect();
    const targetX = x - containerRect.width / 2 + w / 2;
    const targetY = y - containerRect.height / 2 + h / 2;
    container.scrollTo({
      left: Math.max(0, targetX),
      top: Math.max(0, targetY),
      behavior: 'smooth',
    });
  }, []);

  // searchHitBlocks を ref で持って scrollToHitBlock から最新を参照する
  const searchHitBlocksRef = useRef(searchHitBlocks);
  searchHitBlocksRef.current = searchHitBlocks;

  // issue #214: searchHitIndex 変化を useEffect で購読してスクロール発火。
  // handleSearchKeyDown 内で即時 scrollToHitBlock を呼ぶと zustand set() 後の
  // コンポーネント側 searchHitIndex が次 render まで前回値のまま (stale) になるため、
  // store 更新 → effect → scroll の順序で React の render cycle と整合させる。
  useEffect(() => {
    if (searchHitIndex < 0) return;
    if (searchHitBlocksRef.current.length === 0) return;
    scrollToHitBlock(searchHitIndex, searchHitBlocksRef.current);
  }, [searchHitIndex, scrollToHitBlock]);

  // SH-7 (#431 / PCT-200): ページ切替等で totalHits (現在ページのヒット数) が
  // searchHitIndex を下回ると「8/3」のような不正なバッジ表示になる。
  // totalHits 変化を検知して範囲内にクランプする。
  useEffect(() => {
    if (!searchTerm) return;
    clampSearchHitIndex(totalHits);
  }, [searchTerm, totalHits, clampSearchHitIndex]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (totalHits === 0) return;
    e.preventDefault();
    if (e.shiftKey) prevSearchHit(totalHits);
    else nextSearchHit(totalHits);
  }, [totalHits, nextSearchHit, prevSearchHit]);

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
  // PCT-048: problematicIds changes with each page edit; keep a ref so that
  // the stable renderItem callback can access the latest value without being
  // recreated (which would invalidate Virtuoso's itemContent memoisation).
  const problematicIdsRef = useRef(problematicIds);
  filteredBlocksRef.current = filteredBlocks;
  currentPageIndexRef.current = currentPageIndex;
  handleSelectRef.current = handleSelect;
  problematicIdsRef.current = problematicIds;

  // issue #116: BB クリックで lastSelectedId が変わったら、仮想化リストを
  // そのブロックまでスクロールさせる。OcrCard 側の per-card scrollIntoView は
  // アンマウント済みカードでは動かないため、エディタ側で Virtuoso を駆動する。
  // - 単一選択時のみ発火 (複数選択ドラッグ等で勝手にジャンプしないように)。
  // - filteredBlocks / selectedIds は ref 経由で読み、依存を lastSelectedId のみにして
  //   1 文字編集ごとにこの effect が再実行されるのを防ぐ (focusBlockByIndex と同方針)。
  // issue #291: scroll 完了後に対象 OcrCard の contentEditable へ自動フォーカスする。
  // - 既に contentEditable 内で編集中の場合はフォーカスを奪わない (race 防止)。
  useEffect(() => {
    if (!lastSelectedId) return;
    if (selectedIdsRef.current.size !== 1) return;
    const index = filteredBlocksRef.current.findIndex(b => b.id === lastSelectedId);
    if (index === -1) return;
    const targetId = lastSelectedId;
    virtuosoRef.current?.scrollIntoView({
      index,
      behavior: 'auto',
      align: 'center',
      done: () => {
        // 既に contentEditable 内を編集中なら focus を奪わない
        const active = window.document.activeElement;
        if (active && active.closest('[contenteditable="true"]')) return;
        const card = window.document.querySelector(
          `[data-block-id="${targetId}"].ocr-card-content`
        ) as HTMLElement | null;
        card?.focus();
      },
    });
  }, [lastSelectedId]);

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
          problematicIds={problematicIdsRef.current}
        />
      );
    },
    []
  );

  return (
    <aside className="editor-panel" style={{ width: `${width}px` }}>
      <div className="panel-header">
        <div className="search-container">
          <Search size={14} className="search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="検索..."
            aria-label="OCRテキストを検索"
            className="search-box"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            title={searchTerm ? '検索フィルタ中は並び替え (DnD) できません' : undefined}
          />
          {searchTerm && (
            <span className="search-hit-badge" aria-live="polite" aria-label={`${totalHits > 0 ? searchHitIndex + 1 : 0} / ${totalHits}`}>
              {totalHits > 0 ? `${searchHitIndex + 1}/${totalHits}` : '0/0'}
            </span>
          )}
        </div>
        {/* Issue #168: 検索フィルタ適用中は DnD が無効化される旨をユーザーに伝える */}
        {searchTerm && (
          <div className="search-filter-hint" role="status">
            検索フィルタ中は並び替えできません
          </div>
        )}
      </div>
      <div className="scroll-content">
        {!hasDocument ? (
          <div className="placeholder">データなし</div>
        ) : !currentPage ? (
          <div className="placeholder">読み込み中...</div>
        ) : isExtracting ? (
          <div className="ocr-loading-placeholder">
            <div className="loading-spinner" />
            <div className="loading-message">テキスト抽出中...</div>
          </div>
        ) : currentPage.textBlocks.length === 0 ? (
          // PCT-058: 初見ユーザーが次の操作に迷わないよう、OCR 実行への導線を表示する
          <div className="placeholder placeholder--no-ocr">
            <div>このページにOCRテキストがありません</div>
            <div className="placeholder--no-ocr-hint">リボンの「OCR実行」でテキストを読み取れます</div>
          </div>
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
