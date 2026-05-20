import { useRef, useEffect, useImperativeHandle, forwardRef, memo, useCallback } from "react";
import type React from "react";
import { GripVertical } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { TextBlock, WritingMode } from "../types";
import { usePecoStore } from "../store/pecoStore";
import { perf } from "../utils/perfLogger";
import { flushActiveOcrCardText } from "../utils/ocrEditFlush";

export interface OcrCardHandle {
  focusContent: () => void;
}

export const commitActiveOcrCardEdit = flushActiveOcrCardText;

interface OcrCardProps {
  block: TextBlock;
  pageIndex: number;
  dragListeners?: DraggableSyntheticListeners;
  onNavigate?: (direction: 'up' | 'down') => void;
  onExtendSelection?: (direction: 'up' | 'down') => void;
  onSelect?: (id: string, ctrl: boolean, shift: boolean) => void;
}

export const OcrCard = memo(forwardRef<OcrCardHandle, OcrCardProps>(
  function OcrCard({ block, pageIndex, dragListeners, onNavigate, onExtendSelection, onSelect }, ref) {
  // selectedIds全体ではなく、このブロックのisSelectedのみ購読（200回の再レンダリングを防ぐ）
  const isSelected = usePecoStore(state => state.selectedIds.has(block.id));
  // 自カードが anchor (= lastSelectedId) かどうかのみを購読する。複数選択時に
  // 全カードが scrollIntoView を同時発火して N 個の smooth-scroll が衝突する
  // のを防ぐため、anchor だけが auto-scroll する (issue #70)。
  const isAnchor = usePecoStore(state => state.lastSelectedId === block.id);
  // 細粒度selectorで購読: action参照は不変。
  // document 全体は購読せず handleBlur/toggleWritingMode 内で getState() から直接読むことで、
  // どのページのどの編集でも全 200 枚の OcrCard が再評価されるのを防ぐ。
  const updatePageData = usePecoStore(s => s.updatePageData);
  const toggleSelection = usePecoStore(s => s.toggleSelection);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // IME 変換中フラグ: composition 中の state 同期を抑制する（変換テキスト消失防止）
  const isComposingRef = useRef(false);
  // blur 直前のキャレット位置（restore 用）
  const savedOffsetRef = useRef<number | null>(null);

  const commitDomText = useCallback(() => {
    const newText = contentRef.current?.textContent ?? "";
    const page = usePecoStore.getState().document?.pages.get(pageIndex);
    if (!page) return false;
    const currentBlock = page.textBlocks.find(b => b.id === block.id);
    if (currentBlock?.text === newText) return false;

    const newBlocks = page.textBlocks.map(b =>
      b.id === block.id ? { ...b, text: newText, isDirty: true } : b
    );
    updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true });
    return true;
  }, [block.id, pageIndex, updatePageData]);

  // キャレット位置を復元（保存位置 → なければ末尾）
  const restoreCaret = (el: HTMLDivElement) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = window.document.createRange();
    const textNode = el.firstChild;
    const saved = savedOffsetRef.current;
    if (textNode && textNode.nodeType === Node.TEXT_NODE && saved !== null) {
      const len = (textNode.textContent || "").length;
      const offset = Math.min(Math.max(0, saved), len);
      try {
        range.setStart(textNode, offset);
        range.setEnd(textNode, offset);
      } catch {
        range.selectNodeContents(el);
        range.collapse(false);
      }
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // 外部からテキストエリアにフォーカスできるようにする
  useImperativeHandle(ref, () => ({
    focusContent: () => {
      const el = contentRef.current;
      if (!el) return;
      el.focus();
      restoreCaret(el);
    }
  }));

  // 選択されたら自動スクロール (anchor のみ / behavior:'auto')。
  // - lastSelectedId 以外のカードはスクロールを起動しない。50+ 件一括選択時に
  //   N 個の smooth-scroll が同時発火してメインスレッドが詰まるのを防ぐ。
  // - 'smooth' から 'auto' に変更し、Virtuoso 側 scroll と二重発火しても
  //   アニメーションの競合が起きないようにする (issue #70)。
  useEffect(() => {
    if (isSelected && isAnchor && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }, [isSelected, isAnchor]);

  // contentEditable の内容は React children ではなく DOM API で同期する
  useEffect(() => {
    if (!contentRef.current) return;
    // フォーカス中は同期しない(キャレット位置と選択状態を維持するため)
    if (window.document.activeElement === contentRef.current) return;
    // IME 変換中は DOM を書き換えない（変換テキストが消えるため）
    if (isComposingRef.current) return;
    if (contentRef.current.textContent !== block.text) {
      contentRef.current.textContent = block.text;
    }
  }, [block.text]);

  const handleBlur = () => {
    if (perf.enabled) perf.mark('edit.blur', { page: pageIndex, blockId: block.id });
    // キャレット位置を保存（次回 focus 時に復元する）
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && contentRef.current?.contains(sel.anchorNode)) {
      savedOffsetRef.current = sel.anchorOffset;
    }
    commitDomText();
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
    if (contentRef.current?.contains(e.target as Node) && isSelected) return;
    if (onSelect) {
      onSelect(block.id, e.ctrlKey || e.metaKey, e.shiftKey);
    } else {
      toggleSelection(block.id, e.ctrlKey || e.metaKey || e.shiftKey);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // Issue #45: OcrCard 上の右クリックは App.tsx の onContextMenu に伝播させない
    // (背後の HelpMenu が開いてしまうのを防ぐ)
    e.stopPropagation();
    if (!isSelected) {
      toggleSelection(block.id, false);
    }
  };

  const toggleWritingMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newMode: WritingMode = block.writingMode === 'vertical' ? 'horizontal' : 'vertical';
    // subscribe せず getState() で最新ページを取る: 編集時に他カードが再評価されない
    const page = usePecoStore.getState().document?.pages.get(pageIndex);
    if (page) {
      const newBlocks = page.textBlocks.map(b =>
        b.id === block.id ? { ...b, writingMode: newMode, isDirty: true } : b
      );
      updatePageData(pageIndex, { textBlocks: newBlocks, isDirty: true });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      flushActiveOcrCardText();
    }

    const direction = e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : null;
    if (e.shiftKey && direction) {
      if (!isComposingRef.current && onExtendSelection) {
        e.preventDefault();
        onExtendSelection(direction);
      }
      return;
    }
    if (!onNavigate || !e.ctrlKey) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onNavigate('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onNavigate('up');
    }
  };

  return (
    <div
      ref={cardRef}
      className={`ocr-card ${block.isDirty ? 'dirty' : ''} ${isSelected ? 'selected' : ''}`}
      onMouseDown={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="ocr-card-header">
        <div {...dragListeners} className="ocr-card-drag-handle" title="ドラッグして並び替え">
          <GripVertical size={14} />
        </div>
        <span>#{block.order + 1}</span>
        <button
          type="button"
          className="mode-badge"
          onClick={toggleWritingMode}
          title="クリックで縦書き/横書きを切り替え"
        >
          {block.writingMode === 'vertical' ? '縦書き' : '横書き'}
        </button>
        {block.isDirty && <span className="dirty-dot">●</span>}
      </div>
      <div
        ref={contentRef}
        className="ocr-card-content"
        data-page-index={pageIndex}
        data-block-id={block.id}
        contentEditable
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        suppressContentEditableWarning
      />
    </div>
  );
}));
