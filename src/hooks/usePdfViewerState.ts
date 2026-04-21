import { useCallback, useEffect, useRef, useState } from 'react';
import { usePecoStore, selectZoom } from '../store/pecoStore';

// ズーム倍率・自動フィット・ResizeObserver をまとめて管理する。
// document 全体ではなく primitive (isFileLoaded/pageWidth/pageHeight) のみ購読することで、
// updatePageData による document 参照差し替えで毎回この hook が再実行されないようにする。
export function usePdfViewerState(currentPageIndex: number) {
  const zoom = usePecoStore(selectZoom);
  const setZoom = usePecoStore((s) => s.setZoom);
  const isFileLoaded = usePecoStore((s) => s.document !== null);
  // 現在ページの width/height のみ購読（他ページ/他フィールド編集では再レンダしない）
  const pageWidth = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.width);
  const pageHeight = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.height);

  const [isAutoFit, setIsAutoFit] = useState(true);
  const viewerRef = useRef<HTMLDivElement>(null);

  const fitToScreen = useCallback((keepAutoFitState = false) => {
    if (!keepAutoFitState) setIsAutoFit(true);
    const container = viewerRef.current;
    if (container && pageWidth && pageHeight) {
      // padding: 24px (上下左右計48px) + 余裕 12px = 60px
      // さらにスクロールバー出現によるガタつきを防ぐため少し余裕(buffer)を持たせる
      const margin = 64;
      const ratioH = (container.clientHeight - margin) / pageHeight;
      const ratioW = (container.clientWidth - margin) / pageWidth;
      const newZoom = Math.floor(Math.min(ratioH, ratioW) * 100);
      setZoom(Math.max(25, newZoom));
    }
  }, [pageWidth, pageHeight, setZoom]);

  useEffect(() => {
    if (!isAutoFit || !isFileLoaded) return;
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
  }, [isFileLoaded, currentPageIndex, isAutoFit, fitToScreen]);

  return {
    zoom,
    setZoom,
    isAutoFit,
    setIsAutoFit,
    viewerRef,
    fitToScreen,
  };
}
