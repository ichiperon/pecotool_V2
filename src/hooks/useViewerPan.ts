import React, { useEffect, useState } from 'react';

// Space+ドラッグでPDFビューをパンする挙動を担当
export function useViewerPan(viewerRef: React.RefObject<HTMLDivElement | null>) {
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollX: 0, scrollY: 0 });

  useEffect(() => {
    // フォーカスが INPUT/TEXTAREA/contentEditable に加えて BUTTON / A / role=button のときも
    // Space をパン用に奪わない（#49: ボタン focus 中の Space を preventDefault してしまうと
    // ボタンクリックが発火しなくなるため）。closest で内側要素にも対応する。
    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
      if (typeof el.closest === 'function' && el.closest('button, a, [role="button"]')) return true;
      return false;
    };

    const handleKeyDownGlob = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isInteractiveTarget(e.target)) {
        e.preventDefault();
        setIsSpacePressed(true);
      }
    };
    const handleKeyUpGlob = (e: KeyboardEvent) => {
      // keydown と非対称に無条件で state を更新すると、編集中などフォーカスが
      // インタラクティブ要素にある状態の Space 連打で毎回再レンダを誘発する (#19)。
      // keydown と同じ抑止条件を適用し、さらに prev===false の場合は同一参照を返して
      // 余計な setState を回避する。
      if (e.code !== 'Space' || isInteractiveTarget(e.target)) return;
      setIsSpacePressed((prev) => (prev ? false : prev));
      setIsPanning((prev) => (prev ? false : prev));
    };
    window.addEventListener('keydown', handleKeyDownGlob);
    window.addEventListener('keyup', handleKeyUpGlob);
    return () => {
      window.removeEventListener('keydown', handleKeyDownGlob);
      window.removeEventListener('keyup', handleKeyUpGlob);
    };
  }, []);

  const handleViewerMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed) {
      e.stopPropagation();
      e.preventDefault();
      setIsPanning(true);
      const container = viewerRef.current;
      if (container)
        setPanStart({
          x: e.clientX,
          y: e.clientY,
          scrollX: container.scrollLeft,
          scrollY: container.scrollTop,
        });
    }
  };

  const handleViewerMouseMove = (e: React.MouseEvent) => {
    if (isPanning && isSpacePressed) {
      e.preventDefault();
      const container = viewerRef.current;
      if (container) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        container.scrollLeft = panStart.scrollX - dx;
        container.scrollTop = panStart.scrollY - dy;
      }
    }
  };

  const stopPanning = () => setIsPanning(false);

  return {
    isSpacePressed,
    isPanning,
    handleViewerMouseDown,
    handleViewerMouseMove,
    stopPanning,
  };
}
