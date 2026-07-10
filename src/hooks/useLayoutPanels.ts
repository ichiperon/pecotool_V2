import { useState, useEffect, useRef, useCallback } from 'react';

export const LEFT_PANEL_MIN_WIDTH = 150;
export const LEFT_PANEL_MAX_WIDTH = 400;
export const RIGHT_PANEL_MIN_WIDTH = 200;
export const RIGHT_PANEL_MAX_WIDTH = 800;
const KEYBOARD_RESIZE_STEP = 10;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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
      setLeftWidth(clamp(startWidth + (moveEvent.clientX - startX), LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH));
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
      setRightWidth(clamp(startWidth - (moveEvent.clientX - startX), RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH));
    const onMouseUp = () => detachActiveListeners();
    activeListenersRef.current = { move: onMouseMove, up: onMouseUp };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // unmount 時にリスナが残ったままにならないよう保険として全解除。
  useEffect(() => {
    return () => detachActiveListeners();
  }, []);

  const handleResizeLeftKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP;
      setLeftWidth((width) => clamp(width + delta, LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setLeftWidth(e.key === 'Home' ? LEFT_PANEL_MIN_WIDTH : LEFT_PANEL_MAX_WIDTH);
    }
  }, []);

  const handleResizeRightKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      // The right panel grows when its separator moves left.
      const delta = e.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      setRightWidth((width) => clamp(width + delta, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setRightWidth(e.key === 'Home' ? RIGHT_PANEL_MIN_WIDTH : RIGHT_PANEL_MAX_WIDTH);
    }
  }, []);

  return {
    leftWidth,
    rightWidth,
    startResizeLeft,
    startResizeRight,
    handleResizeLeftKeyDown,
    handleResizeRightKeyDown,
  };
}
