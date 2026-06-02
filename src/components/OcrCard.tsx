import { useRef, useEffect, useImperativeHandle, forwardRef, memo } from "react";
import type React from "react";
import { GripVertical } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { TextBlock, WritingMode } from "../types";
import { usePecoStore } from "../store/pecoStore";
import { useOcrSettingsStore } from "../store/ocrSettingsStore";
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
  // #192: 低信頼ハイライト設定
  const ocrConfidenceThreshold = useOcrSettingsStore((s) => s.ocrConfidenceThreshold);
  const showLowConfidenceHighlight = useOcrSettingsStore((s) => s.showLowConfidenceHighlight);
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
  // issue #115: 最新の編集テキストを keystroke ごとにミラーする ref。
  // react-virtuoso は画面外カードをアンマウントするが、React 19 はその際 onBlur を
  // 発火しないため、blur 待ちでは編集が失われる。onInput でここに同期し、
  // アンマウント時の cleanup で store にコミットする。
  const pendingTextRef = useRef<string | null>(null);
  // unmount cleanup の closure は stale props を捕まえるため、コミット先 (block.id /
  // pageIndex) を ref に保持して常に最新のターゲットを参照できるようにする。
  const blockIdRef = useRef(block.id);
  const pageIndexRef = useRef(pageIndex);
  blockIdRef.current = block.id;
  pageIndexRef.current = pageIndex;

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

  // 編集テキストを store にコミットする共通ヘルパー (blur / unmount 双方から呼ぶ)。
  // subscribe せず getState() で最新ページを取る: 編集時に他カードが再評価されない。
  // ターゲットは ref 経由で読み、unmount cleanup の stale closure でも正しい
  // block / page を指すようにする (issue #115)。
  const commitText = (newText: string) => {
    const targetBlockId = blockIdRef.current;
    const targetPageIndex = pageIndexRef.current;
    const page = usePecoStore.getState().document?.pages.get(targetPageIndex);
    if (!page) return;
    const current = page.textBlocks.find(b => b.id === targetBlockId);
    // ストア上の現在値と一致していれば何もしない（不要な再レンダリングを防ぐ）。
    if (!current || current.text === newText) return;
    const newBlocks = page.textBlocks.map(b =>
      b.id === targetBlockId ? { ...b, text: newText, isDirty: true } : b
    );
    updatePageData(targetPageIndex, { textBlocks: newBlocks, isDirty: true });
  };

  // issue #115: keystroke ごとに textContent を ref へミラーする。
  // ここでは store に書かない（毎打鍵の store write は再レンダリングを誘発するため、
  // blur-commit 設計は意図的に維持する）。アンマウント時の cleanup がこの ref を使う。
  const handleInput = () => {
    // IME 変換中も最新の（未確定を含む）textContent を捕捉しておく。
    // compositionend 後に確定テキストで再度 onInput が走り上書きされる。
    pendingTextRef.current = contentRef.current?.textContent ?? "";
  };

  const handleBlur = () => {
    if (perf.enabled) perf.mark('edit.blur', { page: pageIndex, blockId: block.id });
    // キャレット位置を保存（次回 focus 時に復元する）
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && contentRef.current?.contains(sel.anchorNode)) {
      savedOffsetRef.current = sel.anchorOffset;
    }
    // 読み書きを textContent に統一（innerText は改行扱いが環境依存）
    const newText = contentRef.current?.textContent ?? "";
    commitText(newText);
    // コミット済みなので unmount 時の二重コミットを防ぐためミラーをクリア。
    pendingTextRef.current = null;
  };

  // issue #115: アンマウント時コミット。react-virtuoso が画面外カードを
  // アンマウントする際 React 19 は onBlur を発火しないため、blur を経ずに
  // 失われる編集をここで救済する。pendingTextRef が store の現在値と異なる
  // ときのみコミットする (commitText 内で差分判定)。
  useEffect(() => {
    return () => {
      const pending = pendingTextRef.current;
      if (pending !== null) {
        commitText(pending);
      }
    };
    // 空依存: マウント時に登録し、アンマウント時に 1 回だけ cleanup を走らせる。
    // commitText / ターゲットは ref 経由で最新値を読むため依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    // compositionend では onInput より先にこのハンドラが走る環境があるため、
    // 確定後の textContent を明示的にミラーへ反映しておく (取りこぼし防止)。
    pendingTextRef.current = contentRef.current?.textContent ?? "";
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
      // issue #117: App.tsx の Find & Replace 前処理が編集中ブロックを特定するため、
      // contentEditable から closest('[data-block-id]') で辿れるよう root に付与する。
      data-block-id={block.id}
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
        {/* #192: 低信頼バッジ */}
        {showLowConfidenceHighlight &&
          block.confidence !== undefined &&
          block.confidence <= ocrConfidenceThreshold && (
          <span
            className="ocr-confidence-badge"
            aria-label={`信頼度 ${Math.round(block.confidence * 100)}%`}
            title={`OCR 信頼度: ${Math.round(block.confidence * 100)}% (閾値: ${Math.round(ocrConfidenceThreshold * 100)}%)`}
          >
            !
          </span>
        )}
      </div>
      {/* Issue #161: SR/支援技術向けに role="textbox" + aria-multiline + aria-label を付与。
          aria-label は literal 要求 linter 回避のため縦/横で 2 分岐し、ブロック番号のみ expression。 */}
      {block.writingMode === 'vertical' ? (
        <div
          ref={contentRef}
          className="ocr-card-content"
          data-page-index={pageIndex}
          data-block-id={block.id}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={`ブロック ${block.order + 1} (縦書き)`}
          onInput={handleInput}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          suppressContentEditableWarning
        />
      ) : (
        <div
          ref={contentRef}
          className="ocr-card-content"
          data-page-index={pageIndex}
          data-block-id={block.id}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={`ブロック ${block.order + 1} (横書き)`}
          onInput={handleInput}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          suppressContentEditableWarning
        />
      )}
    </div>
  );
}));
