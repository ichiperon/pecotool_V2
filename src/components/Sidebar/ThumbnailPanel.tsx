import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PecoDocument } from '../../types';

// ─── コンテキストメニュー状態 ──────────────────────────────────

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetDisplayIndex: number;
}

const CONTEXT_MENU_INITIAL: ContextMenuState = {
  visible: false,
  x: 0,
  y: 0,
  targetDisplayIndex: -1,
};

// ─── ソータブルアイテムラッパー ────────────────────────────────

interface SortableThumbnailWrapperProps {
  displayIndex: number;
  children: React.ReactNode;
}

const SortableThumbnailWrapper: React.FC<SortableThumbnailWrapperProps> = ({ displayIndex, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: displayIndex });

  // transform / transition は動的値のため style prop が必要 (CSS クラスでは表現不可)
  const transformStyle = CSS.Transform.toString(transform);
  const dynamicStyle = {
    transform: transformStyle,
    transition,
  } as React.CSSProperties;

  return (
    <div
      ref={setNodeRef}
      style={dynamicStyle}
      className={`thumbnail-sortable-wrapper thumbnail-grab-handle${isDragging ? ' thumbnail-sortable-wrapper--dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

// ─── サムネイルアイテム ───────────────────────────────────────

interface ThumbnailItemProps {
  index: number;
  loadEpoch: number;
  onSelect: (index: number) => void;
  onRequest: (index: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
  onSubscribeActivePage: (index: number, cb: () => void) => () => void;
  onGetIsActivePage: (index: number) => boolean;
  onSubscribeDirtyPage: (index: number, cb: () => void) => () => void;
  onGetIsDirtyPage: (index: number) => boolean;
  onContextMenu: (e: React.MouseEvent, displayIndex: number) => void;
}

export const ThumbnailItemNode = React.memo(({
  index, loadEpoch,
  onSelect, onRequest, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
  onContextMenu,
}: ThumbnailItemProps) => {
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  useEffect(() => {
    return onSubscribeThumbnail(index, forceUpdate);
  }, [index, onSubscribeThumbnail]);

  useEffect(() => {
    return onSubscribeActivePage(index, forceUpdate);
  }, [index, onSubscribeActivePage]);

  useEffect(() => {
    return onSubscribeDirtyPage(index, forceUpdate);
  }, [index, onSubscribeDirtyPage]);

  const thumbnailData = onGetThumbnail(index);
  const isActive = onGetIsActivePage(index);
  const isDirty = onGetIsDirtyPage(index);

  useEffect(() => {
    if (!thumbnailData) onRequest(index);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, thumbnailData, onRequest, loadEpoch]);

  const ariaLabel = `ページ ${index + 1}${isDirty ? ' (未保存)' : ''}`;
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e, index);
    },
    [index, onContextMenu],
  );

  const body = (
    <>
      <div className="thumbnail-box">
        {thumbnailData ? (
          <img className="thumbnail-img" src={thumbnailData} alt={`Page ${index + 1}`} />
        ) : (
          <span>{index + 1}</span>
        )}
      </div>
      <div className="thumbnail-label">{index + 1} ページ {isDirty && "●"}</div>
    </>
  );

  if (isActive) {
    return (
      <button
        type="button"
        className="thumbnail-item active"
        onClick={() => onSelect(index)}
        onContextMenu={handleContextMenu}
        aria-current="page"
        aria-label={ariaLabel}
      >
        {body}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="thumbnail-item"
      onClick={() => onSelect(index)}
      onContextMenu={handleContextMenu}
      aria-label={ariaLabel}
    >
      {body}
    </button>
  );
});

// ─── メインパネル ─────────────────────────────────────────────

interface ThumbnailPanelProps {
  width: number;
  document: Pick<PecoDocument, 'totalPages' | 'pages'> | null;
  currentPageIndex: number;
  loadEpoch: number;
  isOcrRunning: boolean;
  onSelectPage: (index: number) => void;
  onRequestThumbnail: (index: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
  onSubscribeActivePage: (index: number, cb: () => void) => () => void;
  onGetIsActivePage: (index: number) => boolean;
  onSubscribeDirtyPage: (index: number, cb: () => void) => () => void;
  onGetIsDirtyPage: (index: number) => boolean;
  // issue #193: ページ操作コールバック
  onDeletePages: (displayIndices: number[]) => void;
  onMovePage: (fromDisplayIndex: number, toDisplayIndex: number) => void;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({
  width, document, currentPageIndex, loadEpoch, isOcrRunning,
  onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
  onDeletePages, onMovePage,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(CONTEXT_MENU_INITIAL);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  // DnD センサー: マウスドラッグで 5px 動いたら開始 (クリックと区別)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    virtuosoRef.current?.scrollIntoView({ index: currentPageIndex, behavior: 'smooth', done: () => {} });
  }, [currentPageIndex]);

  // コンテキストメニューを閉じるグローバルハンドラ
  useEffect(() => {
    if (!contextMenu.visible) return;
    const close = () => setContextMenu(CONTEXT_MENU_INITIAL);
    window.addEventListener('click', close, { capture: true });
    window.addEventListener('contextmenu', close, { capture: true });
    return () => {
      window.removeEventListener('click', close, { capture: true });
      window.removeEventListener('contextmenu', close, { capture: true });
    };
  }, [contextMenu.visible]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, displayIndex: number) => {
      e.preventDefault();
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, targetDisplayIndex: displayIndex });
    },
    [],
  );

  const handleDeleteSingle = useCallback(() => {
    if (contextMenu.targetDisplayIndex < 0) return;
    setContextMenu(CONTEXT_MENU_INITIAL);
    if (!document || document.totalPages <= 1) {
      alert('最後のページは削除できません。');
      return;
    }
    const ok = window.confirm(`ページ ${contextMenu.targetDisplayIndex + 1} を削除しますか？`);
    if (ok) onDeletePages([contextMenu.targetDisplayIndex]);
  }, [contextMenu, document, onDeletePages]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as number);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = active.id as number;
      const toIndex = over.id as number;
      onMovePage(fromIndex, toIndex);
    },
    [onMovePage],
  );

  const totalCount = document?.totalPages ?? 0;
  const sortableItems = Array.from({ length: totalCount }, (_, i) => i);

  const itemContent = useCallback(
    (i: number) => (
      <SortableThumbnailWrapper key={i} displayIndex={i}>
        <ThumbnailItemNode
          index={i}
          loadEpoch={loadEpoch}
          onSelect={onSelectPage}
          onRequest={onRequestThumbnail}
          onSubscribeThumbnail={onSubscribeThumbnail}
          onGetThumbnail={onGetThumbnail}
          onSubscribeActivePage={onSubscribeActivePage}
          onGetIsActivePage={onGetIsActivePage}
          onSubscribeDirtyPage={onSubscribeDirtyPage}
          onGetIsDirtyPage={onGetIsDirtyPage}
          onContextMenu={handleContextMenu}
        />
      </SortableThumbnailWrapper>
    ),
    [
      loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
      onSubscribeActivePage, onGetIsActivePage, onSubscribeDirtyPage, onGetIsDirtyPage,
      handleContextMenu,
    ],
  );

  const activeDragThumbnail = activeDragId !== null ? onGetThumbnail(activeDragId) : undefined;

  // コンテキストメニューの表示位置は clientX/Y の動的値のため style prop が必要
  const contextMenuStyle = {
    position: 'fixed' as const,
    left: contextMenu.x,
    top: contextMenu.y,
  };

  // パネル幅は CSS custom property 経由で渡す (inline style で width を直書きしない)
  const panelStyle = { '--panel-width': `${width}px` } as React.CSSProperties;

  return (
    <aside className="thumbnails-panel" style={panelStyle}>
      {isOcrRunning && (
        <div className="ocr-processing-overlay">
          <div className="loading-spinner" />
          <div className="loading-message">OCR処理中...</div>
        </div>
      )}
      <div className="panel-header">サムネイル</div>
      <div className="scroll-content" tabIndex={0} onKeyDown={(e) => {
        if (!document) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (currentPageIndex < document.totalPages - 1) onSelectPage(currentPageIndex + 1);
        }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (currentPageIndex > 0) onSelectPage(currentPageIndex - 1);
        }
      }}>
        {document ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              <Virtuoso
                ref={virtuosoRef}
                className="thumbnail-virtuoso"
                totalCount={totalCount}
                itemContent={itemContent}
              />
            </SortableContext>
            <DragOverlay>
              {activeDragId !== null && (
                <div className="thumbnail-item thumbnail-drag-overlay">
                  <div className="thumbnail-box">
                    {activeDragThumbnail ? (
                      <img className="thumbnail-img" src={activeDragThumbnail} alt="" />
                    ) : (
                      <span>{activeDragId + 1}</span>
                    )}
                  </div>
                  <div className="thumbnail-label">{activeDragId + 1} ページ</div>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        ) : <div className="placeholder">なし</div>}
      </div>

      {contextMenu.visible && (
        <div
          className="thumbnail-context-menu"
          style={contextMenuStyle}
          role="menu"
          aria-label="ページ操作メニュー"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="thumbnail-context-menu-item thumbnail-context-menu-item--danger"
            onClick={handleDeleteSingle}
          >
            このページを削除
          </button>
        </div>
      )}
    </aside>
  );
};
