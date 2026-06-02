import { useState, useEffect, useRef } from 'react';

// 左右サイドパネルの幅と、マウスドラッグによるリサイズ処理
export function useLayoutPanels() {
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(400);
  // 現在登録中のリスナを保持し、unmount cleanup や次の drag 開始時に確実に解除する。
  const activeListenersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detachActiveListeners = () => {
    if (!activeListenersRef.current) return;
    window.removeEventListener('mousemove', activeListenersRef.current.move);
    window.removeEventListener('mouseup', activeListenersRef.current.up);
    activeListenersRef.current = null;
  };

  const startResizeLeft = (e: React.MouseEvent) => {
    detachActiveListeners();
    const startX = e.clientX;
    const startWidth = leftWidth;
    const onMouseMove = (moveEvent: MouseEvent) =>
      setLeftWidth(Math.max(150, Math.min(400, startWidth + (moveEvent.clientX - startX))));
    const onMouseUp = () => detachActiveListeners();
    activeListenersRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const startResizeRight = (e: React.MouseEvent) => {
    detachActiveListeners();
    const startX = e.clientX;
    const startWidth = rightWidth;
    const onMouseMove = (moveEvent: MouseEvent) =>
      setRightWidth(Math.max(200, Math.min(800, startWidth - (moveEvent.clientX - startX))));
    const onMouseUp = () => detachActiveListeners();
    activeListenersRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // unmount 時にリスナが残ったままにならないよう保険として全解除。
  useEffect(() => {
    return () => detachActiveListeners();
  }, []);

  return { leftWidth, rightWidth, startResizeLeft, startResizeRight };
}
