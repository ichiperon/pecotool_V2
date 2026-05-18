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
      // keyup では isInteractiveTarget で早期 return しない (#64):
      // Space 押下 (body) → Tab で button へ focus 移動 → Space release だと
      // release 時の target が button になるため、isInteractiveTarget で弾くと
      // isSpacePressed / isPanning が永久に true で残ってしまう。
      // 不要な setState は setState の関数形 (prev ? false : prev) が
      // 同一参照を返すことで抑止し、再レンダを防ぐ (#19)。
      if (e.code !== 'Space') return;
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
