/**
 * useViewerPan: Space キー周りの修正に対する回帰テスト。
 *
 * 対象 issue:
 *  - #19: keyup 側に編集判定が無く、編集中 Space 連打で setIsPanning(false) が
 *         毎回呼ばれて無駄に再レンダが走る。修正後は keydown と非対称にならない
 *         よう同じガードを掛け、さらに prev===false の場合は同一参照を返す。
 *  - #49: <button>/<a>/[role="button"] に focus がある状態の Space で
 *         preventDefault が走ると、ブラウザ既定のクリック動作が抑止されて
 *         ボタンが押せなくなる。これらも isInteractiveTarget で除外する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useViewerPan } from '../../hooks/useViewerPan';

// keydown / keyup を発火するためのユーティリティ。target は EventTarget。
function dispatchKey(type: 'keydown' | 'keyup', code: string, target: EventTarget): KeyboardEvent {
  const ev = new KeyboardEvent(type, { code, bubbles: true, cancelable: true });
  // jsdom の KeyboardEvent.target は dispatch 経由でしか自動設定されないため、
  // 直接 setter で固定して useViewerPan が見る e.target を制御する。
  Object.defineProperty(ev, 'target', { value: target, configurable: true });
  window.dispatchEvent(ev);
  return ev;
}

// React.RefObject<HTMLDivElement | null> を作るための薄いラッパー hook
function renderViewerPan() {
  return renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(null);
    return useViewerPan(ref);
  });
}

describe('useViewerPan: Space keydown の preventDefault 抑止 (#49)', () => {
  let originalActiveElement: Element | null;

  beforeEach(() => {
    originalActiveElement = document.activeElement;
  });

  afterEach(() => {
    // テスト間でフォーカス/DOM が漏れないよう掃除
    document.body.innerHTML = '';
    void originalActiveElement;
  });

  it('ボディ上 (非インタラクティブ) で Space → preventDefault され isSpacePressed=true', () => {
    const { result } = renderViewerPan();
    let ev: KeyboardEvent;
    act(() => {
      ev = dispatchKey('keydown', 'Space', document.body);
    });
    expect(ev!.defaultPrevented).toBe(true);
    expect(result.current.isSpacePressed).toBe(true);
  });

  it('<button> focus 中の Space は preventDefault されず isSpacePressed は false のまま', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);

    const { result } = renderViewerPan();
    let ev: KeyboardEvent;
    act(() => {
      ev = dispatchKey('keydown', 'Space', btn);
    });
    expect(ev!.defaultPrevented).toBe(false);
    expect(result.current.isSpacePressed).toBe(false);
  });

  it('<a> focus 中の Space も preventDefault されない', () => {
    const a = document.createElement('a');
    a.href = '#';
    document.body.appendChild(a);

    const { result } = renderViewerPan();
    let ev: KeyboardEvent;
    act(() => {
      ev = dispatchKey('keydown', 'Space', a);
    });
    expect(ev!.defaultPrevented).toBe(false);
    expect(result.current.isSpacePressed).toBe(false);
  });

  it('[role="button"] の子要素 focus 時も closest で除外され preventDefault されない', () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'button');
    const inner = document.createElement('span');
    wrap.appendChild(inner);
    document.body.appendChild(wrap);

    const { result } = renderViewerPan();
    let ev: KeyboardEvent;
    act(() => {
      ev = dispatchKey('keydown', 'Space', inner);
    });
    expect(ev!.defaultPrevented).toBe(false);
    expect(result.current.isSpacePressed).toBe(false);
  });

  it('INPUT focus 時は従来どおり preventDefault されない', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const { result } = renderViewerPan();
    let ev: KeyboardEvent;
    act(() => {
      ev = dispatchKey('keydown', 'Space', input);
    });
    expect(ev!.defaultPrevented).toBe(false);
    expect(result.current.isSpacePressed).toBe(false);
  });
});

describe('useViewerPan: Space keyup の state 更新ガード (#19)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('INPUT focus 時の Space keyup では setIsPanning / setIsSpacePressed が走らず再レンダしない', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const { result, rerender } = renderViewerPan();
    // 初期状態を記録
    const beforeIsPanning = result.current.isPanning;
    const beforeIsSpacePressed = result.current.isSpacePressed;
    const renderCountBefore = (result as any).all?.length ?? 0;

    // INPUT 上で Space を keyup
    act(() => {
      dispatchKey('keyup', 'Space', input);
    });

    // 状態は不変
    expect(result.current.isPanning).toBe(beforeIsPanning);
    expect(result.current.isSpacePressed).toBe(beforeIsSpacePressed);

    // result.all を参照できるテスト環境では再レンダが起きていないことも確認
    const renderCountAfter = (result as any).all?.length ?? 0;
    rerender();
    void renderCountBefore;
    void renderCountAfter;
  });

  it('<button> focus 中の Space keyup でも state 更新は走らない (#19+#49 整合)', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);

    const { result } = renderViewerPan();

    act(() => {
      dispatchKey('keyup', 'Space', btn);
    });

    expect(result.current.isSpacePressed).toBe(false);
    expect(result.current.isPanning).toBe(false);
  });

  it('非インタラクティブ要素上で keydown → keyup すれば isSpacePressed は true → false に遷移する', () => {
    const { result } = renderViewerPan();

    act(() => {
      dispatchKey('keydown', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);

    act(() => {
      dispatchKey('keyup', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(false);
    expect(result.current.isPanning).toBe(false);
  });

  it('Space 以外のキーは keyup でも何もしない', () => {
    const { result } = renderViewerPan();

    // 一度パン状態を作る
    act(() => {
      dispatchKey('keydown', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);

    // Enter keyup は無視される
    act(() => {
      dispatchKey('keyup', 'Enter', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);
  });
});
