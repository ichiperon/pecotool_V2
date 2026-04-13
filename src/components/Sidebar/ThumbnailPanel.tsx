import React, { useEffect, useRef } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface ThumbnailItemProps {
  index: number;
  currentPageIndex: number;
  thumbnailData?: string;
  isDirty?: boolean;
  onSelect: (index: number) => void;
  onRequest: (index: number) => void;
}

export const ThumbnailItemNode = React.memo(({ index, currentPageIndex, thumbnailData, isDirty, onSelect, onRequest }: ThumbnailItemProps) => {
  useEffect(() => {
    if (!thumbnailData) onRequest(index);
  }, [index, thumbnailData, onRequest]);

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
  thumbnails: Map<number, string>;
  onSelectPage: (index: number) => void;
  onRequestThumbnail: (index: number) => void;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({
  width, document, currentPageIndex, thumbnails, onSelectPage, onRequestThumbnail
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    virtuosoRef.current?.scrollIntoView({ index: currentPageIndex, behavior: 'smooth', done: () => {} });
  }, [currentPageIndex]);

  return (
    <aside className="thumbnails-panel" style={{ width: `${width}px`, height: '100%', flex: 1 }}>
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
                thumbnailData={thumbnails.get(i)}
                isDirty={document.pages.get(i)?.isDirty}
                onSelect={onSelectPage}
                onRequest={onRequestThumbnail}
              />
            )}
          />
        ) : <div className="placeholder">なし</div>}
      </div>
    </aside>
  );
};
