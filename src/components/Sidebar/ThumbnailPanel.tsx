import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { PecoDocument } from '../../types';

interface ThumbnailItemProps {
  index: number;
  loadEpoch: number;
  onSelect: (index: number) => void;
  onRequest: (index: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
  // issue #68: active 状態を prop drill せず、index 単位で pub/sub する。
  // currentPageIndex を prop で受けると、ページ切替で Virtuoso 可視範囲の
  // 全 ThumbnailItemNode が再レンダされてしまう。
  onSubscribeActivePage: (index: number, cb: () => void) => () => void;
  onGetIsActivePage: (index: number) => boolean;
  // issue #173: dirty 状態も同様に pub/sub。document を依存に持たないことで
  // updatePageData による itemContent 再生成 → 全件 unmount/remount を防ぐ。
  onSubscribeDirtyPage: (index: number, cb: () => void) => () => void;
  onGetIsDirtyPage: (index: number) => boolean;
}

export const ThumbnailItemNode = React.memo(({
  index, loadEpoch,
  onSelect, onRequest, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
}: ThumbnailItemProps) => {
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  // このアイテム専用のサムネイル更新を購読（アンマウント時に自動解除）
  useEffect(() => {
    return onSubscribeThumbnail(index, forceUpdate);
  }, [index, onSubscribeThumbnail]);

  // issue #68: このアイテム専用の active 状態変化を購読する。
  // 旧アクティブ / 新アクティブの 2 件のみ通知されるため、他のアイテムは再レンダされない。
  useEffect(() => {
    return onSubscribeActivePage(index, forceUpdate);
  }, [index, onSubscribeActivePage]);

  // issue #173: このアイテム専用の dirty 状態変化を購読する。
  useEffect(() => {
    return onSubscribeDirtyPage(index, forceUpdate);
  }, [index, onSubscribeDirtyPage]);

  const thumbnailData = onGetThumbnail(index);
  const isActive = onGetIsActivePage(index);
  const isDirty = onGetIsDirtyPage(index);

  // サムネイルが未取得 or ファイル切替後に再リクエスト
  useEffect(() => {
    if (!thumbnailData) onRequest(index);
  // loadEpoch が変化したとき（ファイル切り替え後）に再リクエストを強制する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, thumbnailData, onRequest, loadEpoch]);

  return (
    <div className={`thumbnail-item ${isActive ? 'active' : ''}`} onClick={() => onSelect(index)}>
      <div className="thumbnail-box">
        {thumbnailData ? (
          <img src={thumbnailData} alt={`Page ${index + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ color: '#d1d5db', fontSize: 24 }}>{index + 1}</span>
        )}
      </div>
      <div className="thumbnail-label">{index + 1} ページ {isDirty && "●"}</div>
    </div>
  );
});

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
  // issue #68: active 状態は prop drill せず subscribe で配る。
  onSubscribeActivePage: (index: number, cb: () => void) => () => void;
  onGetIsActivePage: (index: number) => boolean;
  // issue #173: dirty 状態も subscribe で配る (document 依存を排除)。
  onSubscribeDirtyPage: (index: number, cb: () => void) => () => void;
  onGetIsDirtyPage: (index: number) => boolean;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({
  width, document, currentPageIndex, loadEpoch, isOcrRunning,
  onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
  onSubscribeActivePage, onGetIsActivePage,
  onSubscribeDirtyPage, onGetIsDirtyPage,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    virtuosoRef.current?.scrollIntoView({ index: currentPageIndex, behavior: 'smooth', done: () => {} });
  }, [currentPageIndex]);

  // issue #68 / #173: itemContent を毎レンダで新規生成すると Virtuoso の
  // memoization が効かず、親 (ThumbnailPanel) が再レンダされる度に可視範囲の
  // 全アイテムが再レンダされる。currentPageIndex / document に依存させない
  // (active / dirty 状態は subscribe で配るため) ことで、ページ切替・編集では
  // itemContent identity を保つ。
  const itemContent = useCallback(
    (i: number) => (
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
      />
    ),
    [loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail, onSubscribeActivePage, onGetIsActivePage, onSubscribeDirtyPage, onGetIsDirtyPage],
  );

  return (
    <aside className="thumbnails-panel" style={{ width: `${width}px` }}>
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
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            totalCount={document.totalPages}
            itemContent={itemContent}
          />
        ) : <div className="placeholder">なし</div>}
      </div>
    </aside>
  );
};
