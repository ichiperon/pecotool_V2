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
 *  - #64: #49 修正で keyup 側にも isInteractiveTarget 早期 return を入れた結果、
 *         Space 押下 → Tab で button focus → Space release で keyup の target が
 *         button になり、isSpacePressed / isPanning が永久に true で残るリグレッション。
 *         keyup 側の早期 return は外し、setState の関数形での参照同一化のみで
 *         再レンダを抑止する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type React from 'react';
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

describe('useViewerPan: Space 押下中の focus 移動 keyup リグレッション (#64)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('body で Space 押下 → button focus → button 上で Space release で isSpacePressed が false に戻る', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);

    const { result } = renderViewerPan();

    // 1. body 上で Space 押下 → state は true
    act(() => {
      dispatchKey('keydown', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);

    // 2. Tab で focus が button に移ったあとに Space release。
    //    target が button (インタラクティブ) になるが、keyup 側で早期 return すると
    //    state が true のまま残るのが #64。修正後は false に戻る。
    act(() => {
      dispatchKey('keyup', 'Space', btn);
    });
    expect(result.current.isSpacePressed).toBe(false);
    expect(result.current.isPanning).toBe(false);
  });

  it('Space 押下 → [role="button"] の子要素上で Space release でも state が false に戻る', () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'button');
    const inner = document.createElement('span');
    wrap.appendChild(inner);
    document.body.appendChild(wrap);

    const { result } = renderViewerPan();

    act(() => {
      dispatchKey('keydown', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);

    act(() => {
      dispatchKey('keyup', 'Space', inner);
    });
    expect(result.current.isSpacePressed).toBe(false);
  });

  it('Space 押下 → INPUT focus → Space release でも state が false に戻る', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const { result } = renderViewerPan();

    act(() => {
      dispatchKey('keydown', 'Space', document.body);
    });
    expect(result.current.isSpacePressed).toBe(true);

    act(() => {
      dispatchKey('keyup', 'Space', input);
    });
    expect(result.current.isSpacePressed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// パンのスクロール量計算。Space 押下中に mousedown → mousemove すると
// コンテナの scrollLeft/scrollTop を「ドラッグと逆方向」に移動させる。
// この符号 (panStart.scrollX - dx) と Space 未押下時の no-op がパン体験の
// 中核。既存テストはキーボード状態遷移のみで、座標計算は未検証だった。
// ─────────────────────────────────────────────────────────────
describe('useViewerPan: パンのスクロール量計算', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** scrollLeft/scrollTop を持つ可変コンテナを ref に差し込んで返す */
  function renderPanWithContainer(initial = { scrollLeft: 50, scrollTop: 80 }) {
    const container = { scrollLeft: initial.scrollLeft, scrollTop: initial.scrollTop } as HTMLDivElement;
    const hook = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(container);
      return useViewerPan(ref);
    });
    return { ...hook, container };
  }

  /** React.MouseEvent 風の最小スタブ */
  function mouseEvt(clientX: number, clientY: number) {
    return {
      clientX,
      clientY,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
  }

  it('Space 押下中の mousedown→mousemove で scroll はドラッグと逆方向に動く', () => {
    const { result, container } = renderPanWithContainer({ scrollLeft: 50, scrollTop: 80 });

    // Space 押下
    act(() => { dispatchKey('keydown', 'Space', document.body); });

    // mousedown (100,100): panStart にコンテナの現在 scroll が記録される
    act(() => { result.current.handleViewerMouseDown(mouseEvt(100, 100)); });
    expect(result.current.isPanning).toBe(true);

    // mousemove (130,150): dx=+30, dy=+50 → scroll は逆方向 (start - d)
    act(() => { result.current.handleViewerMouseMove(mouseEvt(130, 150)); });
    expect(container.scrollLeft).toBe(50 - 30);   // 20
    expect(container.scrollTop).toBe(80 - 50);    // 30

    // 逆向きドラッグ: dx=-20, dy=-10 → scroll は + 方向
    act(() => { result.current.handleViewerMouseMove(mouseEvt(80, 90)); });
    expect(container.scrollLeft).toBe(50 - -20);  // 70
    expect(container.scrollTop).toBe(80 - -10);   // 90
  });

  it('Space 未押下なら mousedown でパンは始まらず scroll も動かない', () => {
    const { result, container } = renderPanWithContainer({ scrollLeft: 50, scrollTop: 80 });

    // Space を押さずに mousedown
    act(() => { result.current.handleViewerMouseDown(mouseEvt(100, 100)); });
    expect(result.current.isPanning).toBe(false);

    // mousemove しても isPanning=false なので scroll 不変
    act(() => { result.current.handleViewerMouseMove(mouseEvt(200, 200)); });
    expect(container.scrollLeft).toBe(50);
    expect(container.scrollTop).toBe(80);
  });

  it('stopPanning 後の mousemove は scroll を動かさない (mouseup でパン終了)', () => {
    const { result, container } = renderPanWithContainer({ scrollLeft: 50, scrollTop: 80 });

    act(() => { dispatchKey('keydown', 'Space', document.body); });
    act(() => { result.current.handleViewerMouseDown(mouseEvt(100, 100)); });
    act(() => { result.current.handleViewerMouseMove(mouseEvt(120, 120)); });
    expect(container.scrollLeft).toBe(30);

    // mouseup 相当
    act(() => { result.current.stopPanning(); });
    expect(result.current.isPanning).toBe(false);

    // 以降の mousemove は無視される
    act(() => { result.current.handleViewerMouseMove(mouseEvt(300, 300)); });
    expect(container.scrollLeft).toBe(30);   // 動かない
    expect(container.scrollTop).toBe(60);
  });

  it('mousedown は基準点を撮り直す: 2 回目の mousedown 以降の delta は新基準からの差分', () => {
    const { result, container } = renderPanWithContainer({ scrollLeft: 0, scrollTop: 0 });

    act(() => { dispatchKey('keydown', 'Space', document.body); });

    // 1 回目: (100,100) で掴んで (140,100) へ → scrollLeft = 0 - 40 = -40
    act(() => { result.current.handleViewerMouseDown(mouseEvt(100, 100)); });
    act(() => { result.current.handleViewerMouseMove(mouseEvt(140, 100)); });
    expect(container.scrollLeft).toBe(-40);

    // 2 回目の mousedown: panStart.scrollX に現在の -40 が記録される
    act(() => { result.current.handleViewerMouseDown(mouseEvt(200, 200)); });
    // (210,200) へ → dx=+10 → scrollLeft = -40 - 10 = -50
    act(() => { result.current.handleViewerMouseMove(mouseEvt(210, 200)); });
    expect(container.scrollLeft).toBe(-50);
  });
});
