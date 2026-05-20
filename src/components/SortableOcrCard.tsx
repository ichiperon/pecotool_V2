import { forwardRef, memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OcrCard, OcrCardHandle } from './OcrCard';
import { TextBlock } from '../types';

interface SortableOcrCardProps {
  block: TextBlock;
  pageIndex: number;
  onNavigate?: (direction: 'up' | 'down') => void;
  onExtendSelection?: (direction: 'up' | 'down') => void;
  onSelect?: (id: string, ctrl: boolean, shift: boolean) => void;
}

// 仮想化リスト内で大量カードがマウントされてもムダな再レンダリングを避けるため memo 化。
// 親からのコールバックは useCallback で安定化されている前提。
export const SortableOcrCard = memo(forwardRef<OcrCardHandle, SortableOcrCardProps>(
  function SortableOcrCard({ block, pageIndex, onNavigate, onExtendSelection, onSelect }, ref) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: block.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 'auto',
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <OcrCard
        ref={ref}
        block={block}
        pageIndex={pageIndex}
        dragListeners={listeners}
        onNavigate={onNavigate}
        onExtendSelection={onExtendSelection}
        onSelect={onSelect}
      />
    </div>
  );
}));
