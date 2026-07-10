import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLayoutPanels } from '../../hooks/useLayoutPanels';

const keyboardEvent = (key: string) => ({
  key,
  preventDefault: () => {},
}) as React.KeyboardEvent;

describe('useLayoutPanels keyboard separators (#457)', () => {
  it('左右矢印で左パネル幅を10pxずつ変更する', () => {
    const { result } = renderHook(() => useLayoutPanels());

    act(() => result.current.handleResizeLeftKeyDown(keyboardEvent('ArrowRight')));
    expect(result.current.leftWidth).toBe(230);
    act(() => result.current.handleResizeLeftKeyDown(keyboardEvent('ArrowLeft')));
    expect(result.current.leftWidth).toBe(220);
  });

  it('右セパレーターは左矢印で右パネルを広げ、Home/Endで境界へ移動する', () => {
    const { result } = renderHook(() => useLayoutPanels());

    act(() => result.current.handleResizeRightKeyDown(keyboardEvent('ArrowLeft')));
    expect(result.current.rightWidth).toBe(410);
    act(() => result.current.handleResizeRightKeyDown(keyboardEvent('Home')));
    expect(result.current.rightWidth).toBe(200);
    act(() => result.current.handleResizeRightKeyDown(keyboardEvent('End')));
    expect(result.current.rightWidth).toBe(800);
  });

  it('Home/Endで左パネルの最小・最大値に収める', () => {
    const { result } = renderHook(() => useLayoutPanels());

    act(() => result.current.handleResizeLeftKeyDown(keyboardEvent('Home')));
    expect(result.current.leftWidth).toBe(150);
    act(() => result.current.handleResizeLeftKeyDown(keyboardEvent('End')));
    expect(result.current.leftWidth).toBe(400);
  });
});
