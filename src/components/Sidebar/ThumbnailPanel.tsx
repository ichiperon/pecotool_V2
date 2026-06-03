import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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

  // 修正 A (issue #286): 右クリック / 中クリックの pointerdown を dnd-kit に渡さない。
  // listeners がそのまま展開されると button=2 (右クリック) でも PointerSensor が
  // pointerdown をキャプチャし、contextmenu イベントの発火と競合する。
  const safeListeners = useMemo(() => {
    if (!listeners) return undefined;
    return {
      ...listeners,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return; // 左クリック以外は dnd-kit に渡さない
        listeners.onPointerDown?.(e);
      },
    };
  }, [listeners]);

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
      {...safeListeners}
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
  onGetRotation: (index: number) => number;
  onContextMenu: (e: React.MouseEvent, displayIndex: number) => void;
}

export const ThumbnailItemNode = React.memo(({
  index, loadEpoch,
  onSelect, onRequest, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
  onGetRotation,
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
  const rotation = onGetRotation(index);

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

  // issue #207: CSS variable で回転を表示。thumbnail-box の aspect ratio を
  // 維持しつつ画像だけ回転させる (90/270 度では高さ/幅が入れ替わる視覚になる)。
  // inline style は CSS variable の設定のみに限定し、具体的な transform は CSS クラスで定義。
  const rotationVarStyle = rotation !== 0
    ? { '--thumbnail-rotation': `${rotation}deg` } as React.CSSProperties
    : undefined;
  const imgClassName = rotation !== 0 ? 'thumbnail-img thumbnail-img--rotated' : 'thumbnail-img';

  const body = (
    <>
      <div className="thumbnail-box">
        {thumbnailData ? (
          <img className={imgClassName} src={thumbnailData} alt={`Page ${index + 1}`} style={rotationVarStyle} />
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
  // issue #207: ページ回転コールバック
  onRotatePages: (pageIndices: number[], delta: 90 | 180 | 270) => void;
  // issue #208: 選択ページを別 PDF として書き出すコールバック
  onExtractPages: (displayIndices: number[]) => void;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({
  width, document, currentPageIndex, loadEpoch, isOcrRunning,
  onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
  onDeletePages, onMovePage, onRotatePages, onExtractPages,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(CONTEXT_MENU_INITIAL);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  // issue #207: document への最新参照を ref で保持し、stale closure を避ける。
  // itemContent の useCallback deps に document を入れると全アイテムが毎回再生成されるため、
  // ref 経由でアクセスする。
  const documentRef = useRef(document);
  documentRef.current = document;

  // DnD センサー: マウスドラッグで 5px 動いたら開始 (クリックと区別)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    virtuosoRef.current?.scrollIntoView({ index: currentPageIndex, behavior: 'smooth', done: () => {} });
  }, [currentPageIndex]);

  // コンテキストメニューを閉じるグローバルハンドラ
  // 修正 B (issue #286): capture フェーズをやめ RAF で遅延登録する。
  //   - capture: true のままだと、メニューを開いた同一 contextmenu イベントが
  //     bubble より先に close を発火させ、即閉じするケースがある。
  //   - RAF 遅延により「メニューを開いたイベント自体」が完全に処理された後で
  //     close リスナーが登録されるため、連続右クリックでも正しく動作する。
  useEffect(() => {
    if (!contextMenu.visible) return;
    let rafId: number;
    let close: (() => void) | null = null;
    rafId = requestAnimationFrame(() => {
      close = () => setContextMenu(CONTEXT_MENU_INITIAL);
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
    });
    return () => {
      cancelAnimationFrame(rafId);
      if (close) {
        window.removeEventListener('click', close);
        window.removeEventListener('contextmenu', close);
      }
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

  // issue #208: 抽出ハンドラ
  const handleExtract = useCallback(() => {
    if (contextMenu.targetDisplayIndex < 0) return;
    setContextMenu(CONTEXT_MENU_INITIAL);
    onExtractPages([contextMenu.targetDisplayIndex]);
  }, [contextMenu.targetDisplayIndex, onExtractPages]);

  // issue #207: 回転ハンドラ
  const handleRotateRight = useCallback(() => {
    if (contextMenu.targetDisplayIndex < 0) return;
    setContextMenu(CONTEXT_MENU_INITIAL);
    onRotatePages([contextMenu.targetDisplayIndex], 90);
  }, [contextMenu.targetDisplayIndex, onRotatePages]);

  const handleRotateLeft = useCallback(() => {
    if (contextMenu.targetDisplayIndex < 0) return;
    setContextMenu(CONTEXT_MENU_INITIAL);
    onRotatePages([contextMenu.targetDisplayIndex], 270);
  }, [contextMenu.targetDisplayIndex, onRotatePages]);

  const handleRotate180 = useCallback(() => {
    if (contextMenu.targetDisplayIndex < 0) return;
    setContextMenu(CONTEXT_MENU_INITIAL);
    onRotatePages([contextMenu.targetDisplayIndex], 180);
  }, [contextMenu.targetDisplayIndex, onRotatePages]);

  // issue #207: document ref から rotation を取得する安定参照関数
  const onGetRotation = useCallback((index: number): number => {
    return documentRef.current?.pages.get(index)?.rotation ?? 0;
  }, []);

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
          onGetRotation={onGetRotation}
          onContextMenu={handleContextMenu}
        />
      </SortableThumbnailWrapper>
    ),
    [
      loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
      onSubscribeActivePage, onGetIsActivePage, onSubscribeDirtyPage, onGetIsDirtyPage,
      onGetRotation, handleContextMenu,
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
          onContextMenu={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="thumbnail-context-menu-item"
            onClick={handleRotateRight}
          >
            右に 90° 回転
          </button>
          <button
            type="button"
            role="menuitem"
            className="thumbnail-context-menu-item"
            onClick={handleRotateLeft}
          >
            左に 90° 回転
          </button>
          <button
            type="button"
            role="menuitem"
            className="thumbnail-context-menu-item"
            onClick={handleRotate180}
          >
            180° 回転
          </button>
          <button
            type="button"
            role="menuitem"
            className="thumbnail-context-menu-item"
            onClick={handleExtract}
          >
            選択ページを別 PDF として書き出し
          </button>
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
