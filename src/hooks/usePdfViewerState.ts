import { useCallback, useEffect, useRef, useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { useViewerStore, selectZoom } from '../store/viewerStore';

// ズーム倍率・自動フィット・ResizeObserver をまとめて管理する。
// document 全体ではなく primitive (isFileLoaded/pageWidth/pageHeight) のみ購読することで、
// updatePageData による document 参照差し替えで毎回この hook が再実行されないようにする。
export function usePdfViewerState(currentPageIndex: number) {
  const zoom = useViewerStore(selectZoom);
  const setZoom = useViewerStore((s) => s.setZoom);
  const isFileLoaded = usePecoStore((s) => s.document !== null);
  // 現在ページの width/height のみ購読（他ページ/他フィールド編集では再レンダしない）
  const pageWidth = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.width);
  const pageHeight = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.height);
  // UI rotation を購読: 90/270 回転時は fitToScreen の縦横比計算を swap する。
  // page.width/height は BB 座標空間のベース（rotation 前の生寸法）なので変更しない。
  const pageRotation = usePecoStore((s) => s.document?.pages.get(currentPageIndex)?.rotation ?? 0);

  const [isAutoFit, setIsAutoFit] = useState(true);
  const viewerRef = useRef<HTMLDivElement>(null);

  const fitToScreen = useCallback((keepAutoFitState = false) => {
    if (!keepAutoFitState) setIsAutoFit(true);
    const container = viewerRef.current;
    if (container && pageWidth && pageHeight) {
      // padding: 24px (上下左右計48px) + 余裕 12px = 60px
      // さらにスクロールバー出現によるガタつきを防ぐため少し余裕(buffer)を持たせる
      const margin = 64;
      // 90/270 度回転時は表示上の縦横が入れ替わる。fit 計算に使う寸法も swap する。
      const isLandscapeRotation = pageRotation === 90 || pageRotation === 270;
      const fitW = isLandscapeRotation ? pageHeight : pageWidth;
      const fitH = isLandscapeRotation ? pageWidth : pageHeight;
      const ratioH = (container.clientHeight - margin) / fitH;
      const ratioW = (container.clientWidth - margin) / fitW;
      const newZoom = Math.floor(Math.min(ratioH, ratioW) * 100);
      // PCT-095: フィット計算経由では 25% フロアを適用しない（0除けのみ）。
      // 下限クランプは viewerStore.setZoom 側（10%）で一元管理する。
      setZoom(Math.max(1, newZoom));
    }
  }, [pageWidth, pageHeight, pageRotation, setZoom]);

  // ResizeObserver は ref ベースで一度だけ生成し、内部から常に最新の fitToScreen / isAutoFit を呼ぶ。
  // 以前は依存に fitToScreen / currentPageIndex / isAutoFit が入っており、
  // ページ切替の都度 disconnect → 再生成されてブラウザ内部の Observer スロットを浪費していた。
  // (issue #26)
  const fitToScreenRef = useRef(fitToScreen);
  const isAutoFitRef = useRef(isAutoFit);
  useEffect(() => { fitToScreenRef.current = fitToScreen; }, [fitToScreen]);
  useEffect(() => { isAutoFitRef.current = isAutoFit; }, [isAutoFit]);

  useEffect(() => {
    if (isAutoFit && isFileLoaded && viewerRef.current && pageWidth && pageHeight) {
      fitToScreen(true);
    }
  }, [isAutoFit, isFileLoaded, pageWidth, pageHeight, pageRotation, fitToScreen]);

  useEffect(() => {
    if (!isFileLoaded) return;
    const container = viewerRef.current;
    if (!container) return;
    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (isAutoFitRef.current) fitToScreenRef.current(true);
      });
    });
    observer.observe(container);
    return () => { observer.disconnect(); cancelAnimationFrame(rafId); };
  }, [isFileLoaded]);

  return {
    zoom,
    setZoom,
    isAutoFit,
    setIsAutoFit,
    viewerRef,
    fitToScreen,
  };
}
