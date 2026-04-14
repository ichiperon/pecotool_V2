import React, { useEffect, useReducer, useRef } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface ThumbnailItemProps {
  index: number;
  currentPageIndex: number;
  isDirty?: boolean;
  loadEpoch: number;
  onSelect: (index: number) => void;
  onRequest: (index: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
}

export const ThumbnailItemNode = React.memo(({
  index, currentPageIndex, isDirty, loadEpoch,
  onSelect, onRequest, onSubscribeThumbnail, onGetThumbnail,
}: ThumbnailItemProps) => {
  const [, forceUpdate] = useReducer(x => x + 1, 0);

  // このアイテム専用のサムネイル更新を購読（アンマウント時に自動解除）
  useEffect(() => {
    return onSubscribeThumbnail(index, forceUpdate);
  }, [index, onSubscribeThumbnail]);

  const thumbnailData = onGetThumbnail(index);

  // サムネイルが未取得 or ファイル切替後に再リクエスト
  useEffect(() => {
    if (!thumbnailData) onRequest(index);
  // loadEpoch が変化したとき（ファイル切り替え後）に再リクエストを強制する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, thumbnailData, onRequest, loadEpoch]);

  return (
    <div className={`thumbnail-item ${index === currentPageIndex ? 'active' : ''}`} onClick={() => onSelect(index)}>
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
  document: any;
  currentPageIndex: number;
  loadEpoch: number;
  isOcrRunning: boolean;
  onSelectPage: (index: number) => void;
  onRequestThumbnail: (index: number) => void;
  onSubscribeThumbnail: (index: number, cb: () => void) => () => void;
  onGetThumbnail: (index: number) => string | undefined;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({
  width, document, currentPageIndex, loadEpoch, isOcrRunning,
  onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    virtuosoRef.current?.scrollIntoView({ index: currentPageIndex, behavior: 'smooth', done: () => {} });
  }, [currentPageIndex]);

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
            itemContent={(i) => (
              <ThumbnailItemNode
                index={i}
                currentPageIndex={currentPageIndex}
                isDirty={document.pages.get(i)?.isDirty}
                loadEpoch={loadEpoch}
                onSelect={onSelectPage}
                onRequest={onRequestThumbnail}
                onSubscribeThumbnail={onSubscribeThumbnail}
                onGetThumbnail={onGetThumbnail}
              />
            )}
          />
        ) : <div className="placeholder">なし</div>}
      </div>
    </aside>
  );
};
