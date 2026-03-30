import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OcrCard } from './OcrCard';
import { TextBlock } from '../types';

interface SortableOcrCardProps {
  block: TextBlock;
  pageIndex: number;
}

export function SortableOcrCard({ block, pageIndex }: SortableOcrCardProps) {
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
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <OcrCard block={block} pageIndex={pageIndex} />
    </div>
  );
}
