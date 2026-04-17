import { useCallback, useEffect, useRef, useState } from 'react';
import { usePecoStore, selectZoom } from '../store/pecoStore';
import type { PecoDocument } from '../types';

// ズーム倍率・自動フィット・ResizeObserver をまとめて管理する
export function usePdfViewerState(document: PecoDocument | null | undefined, currentPageIndex: number) {
  const zoom = usePecoStore(selectZoom);
  const setZoom = usePecoStore((s) => s.setZoom);

  const [isAutoFit, setIsAutoFit] = useState(true);
  const viewerRef = useRef<HTMLDivElement>(null);

  const fitToScreen = useCallback((keepAutoFitState = false) => {
    if (!keepAutoFitState) setIsAutoFit(true);
    const container = viewerRef.current;
    const pageData = document?.pages.get(currentPageIndex);
    if (container && pageData) {
      // padding: 24px (上下左右計48px) + 余裕 12px = 60px
      // さらにスクロールバー出現によるガタつきを防ぐため少し余裕(buffer)を持たせる
      const margin = 64;
      const ratioH = (container.clientHeight - margin) / pageData.height;
      const ratioW = (container.clientWidth - margin) / pageData.width;
      const newZoom = Math.floor(Math.min(ratioH, ratioW) * 100);
      setZoom(Math.max(25, newZoom));
    }
  }, [document, currentPageIndex, setZoom]);

  useEffect(() => {
    if (!isAutoFit || !document) return;
    const container = viewerRef.current;
    if (!container) return;
    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (isAutoFit) fitToScreen(true);
      });
    });
    observer.observe(container);
    return () => { observer.disconnect(); cancelAnimationFrame(rafId); };
  }, [document, currentPageIndex, isAutoFit, fitToScreen]);

  return {
    zoom,
    setZoom,
    isAutoFit,
    setIsAutoFit,
    viewerRef,
    fitToScreen,
  };
}
