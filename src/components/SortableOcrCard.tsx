import { forwardRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OcrCard, OcrCardHandle } from './OcrCard';
import { TextBlock } from '../types';

interface SortableOcrCardProps {
  block: TextBlock;
  pageIndex: number;
  onNavigate?: (direction: 'up' | 'down') => void;
}

export const SortableOcrCard = forwardRef<OcrCardHandle, SortableOcrCardProps>(
  function SortableOcrCard({ block, pageIndex, onNavigate }, ref) {
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
      />
    </div>
  );
});
