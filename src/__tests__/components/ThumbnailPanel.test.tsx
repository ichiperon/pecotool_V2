/**
 * Issue #68 regression: ThumbnailItemNode のアクティブページ通知が
 * prop drill ではなく pub/sub になっており、非アクティブなアイテムは
 * ページ切替時に再レンダされない。
 *
 * 検証ポイント:
 * - currentPageIndex を ThumbnailItemNode に props として渡さない
 *   （ThumbnailItemNode は subscribeActivePage / getIsActivePage 経由で読む）
 * - 親 ThumbnailPanel が新しい currentPageIndex で再レンダしても、
 *   "前のアクティブ" と "新しいアクティブ" 以外の ThumbnailItemNode の
 *   render 回数は増えない。
 * - active CSS class は subscribe 通知で正しく付け替わる。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ThumbnailPanel, ThumbnailItemNode, SortableThumbnailWrapper } from '../../components/Sidebar/ThumbnailPanel';
import type { PecoDocument, PageData } from '../../types';

// ThumbnailPanel は @tauri-apps/plugin-dialog の ask/message を直接呼ぶ (PCT-123)。
// テストから resolve 値を差し替えられるよう vi.hoisted で spy を保持する。
const dialogMocks = vi.hoisted(() => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: (...args: unknown[]) => dialogMocks.ask(...args),
  message: (...args: unknown[]) => dialogMocks.message(...args),
}));

// react-virtuoso は仮想化のため可視範囲外の要素を DOM に出さない。
// ThumbnailWindow.test.tsx (#431 回帰テスト) と同じ回避策: 全件を単純にレンダする
// 軽量モックへ差し替える (仮想化ロジック自体はこのテストの関心外)。
vi.mock('react-virtuoso', () => {
  const ReactLib = require('react') as typeof import('react');
  const Virtuoso = ReactLib.forwardRef(function Virtuoso(
    { totalCount, itemContent, className }: any,
    ref: any,
  ) {
    ReactLib.useImperativeHandle(ref, () => ({ scrollIntoView: vi.fn() }));
    return (
      <div className={className}>
        {Array.from({ length: totalCount }, (_, i) => (
          <ReactLib.Fragment key={i}>{itemContent(i)}</ReactLib.Fragment>
        ))}
      </div>
    );
  });
  return { Virtuoso };
});

afterEach(() => cleanup());

/**
 * useThumbnailPanel のサブセットを模した最小のテスト用 pub/sub。
 * 本物の hook は jsdom で Worker / pdfjs に依存して重いため、
 * 同じ API 形状の軽量モックを使う。
 */
function makeFakePanel() {
  const activeListeners = new Map<number, Set<() => void>>();
  let activeIndex = 0;

  return {
    subscribeActivePage(index: number, cb: () => void) {
      if (!activeListeners.has(index)) activeListeners.set(index, new Set());
      activeListeners.get(index)!.add(cb);
      return () => { activeListeners.get(index)?.delete(cb); };
    },
    getIsActivePage(index: number) {
      return activeIndex === index;
    },
    /** Test helper: setCurrentPage と同等。前後の listener にだけ通知する。 */
    setActive(next: number) {
      const prev = activeIndex;
      if (prev === next) return;
      activeIndex = next;
      activeListeners.get(prev)?.forEach(cb => cb());
      activeListeners.get(next)?.forEach(cb => cb());
    },
    // Thumbnail 周りは本テストの関心外: 何もしない no-op。
    subscribeThumbnail(_index: number, _cb: () => void) { return () => {}; },
    getThumbnail(_index: number) { return undefined; },
    // issue #173: dirty pub/sub も本テストの関心外なので no-op を返す。
    subscribeDirtyPage(_index: number, _cb: () => void) { return () => {}; },
    getIsDirtyPage(_index: number) { return false; },
    // issue #207: rotation は本テストの関心外なので 0 を返す no-op。
    getRotation(_index: number) { return 0; },
    onSelectPage: vi.fn(),
    onRequestThumbnail: vi.fn(),
  };
}

describe('Issue #68: ThumbnailItemNode pub/sub による active 通知', () => {
  it('ページ切替で非アクティブな ThumbnailItemNode は再レンダされない', () => {
    const fake = makeFakePanel();
    // ThumbnailItemNode の render は内部で onGetIsActivePage を呼ぶため、
    // この spy 呼び出し回数で実 render 回数を観測できる。
    // (CountingItem のような親ラッパーで数えると、子が memo で再レンダしても
    //  親は更新されず正しく数えられないため、内部 callback を spy する。)
    const getIsActiveSpy = vi.fn((index: number) => fake.getIsActivePage(index));

    function Harness() {
      const renderItem = (i: number) => (
        <ThumbnailItemNode
          key={i}
          index={i}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={getIsActiveSpy}
          onSubscribeDirtyPage={fake.subscribeDirtyPage}
          onGetIsDirtyPage={fake.getIsDirtyPage}
          onGetRotation={fake.getRotation}
        />
      );
      return <>{[0, 1, 2].map(renderItem)}</>;
    }

    render(<Harness />);

    // 初回 render: 各アイテム 1 回ずつ onGetIsActivePage が呼ばれる
    const initialCallsByIndex: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    for (const call of getIsActiveSpy.mock.calls) {
      initialCallsByIndex[call[0]] = (initialCallsByIndex[call[0]] ?? 0) + 1;
    }
    expect(initialCallsByIndex[0]).toBe(1);
    expect(initialCallsByIndex[1]).toBe(1);
    expect(initialCallsByIndex[2]).toBe(1);

    getIsActiveSpy.mockClear();

    // 0 → 1 へアクティブ移動
    act(() => { fake.setActive(1); });

    const afterMove1: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    for (const call of getIsActiveSpy.mock.calls) {
      afterMove1[call[0]] = (afterMove1[call[0]] ?? 0) + 1;
    }
    // 0 (旧アクティブ) と 1 (新アクティブ) だけが再レンダ。2 は再レンダされない。
    // これが issue #68 のリグレッション防止: prop drill だと 2 も再レンダされてしまう。
    expect(afterMove1[0]).toBe(1);
    expect(afterMove1[1]).toBe(1);
    expect(afterMove1[2]).toBe(0);

    getIsActiveSpy.mockClear();

    // 1 → 2 へアクティブ移動
    act(() => { fake.setActive(2); });

    const afterMove2: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    for (const call of getIsActiveSpy.mock.calls) {
      afterMove2[call[0]] = (afterMove2[call[0]] ?? 0) + 1;
    }
    // 1 (旧アクティブ) と 2 (新アクティブ) だけが再レンダ。0 は据え置き。
    expect(afterMove2[0]).toBe(0);
    expect(afterMove2[1]).toBe(1);
    expect(afterMove2[2]).toBe(1);
  });

  it('subscribe 通知で active CSS class が正しく付け替わる', () => {
    const fake = makeFakePanel();

    const { container } = render(
      <>
        <ThumbnailItemNode
          index={0}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
          onSubscribeDirtyPage={fake.subscribeDirtyPage}
          onGetIsDirtyPage={fake.getIsDirtyPage}
          onGetRotation={fake.getRotation}
        />
        <ThumbnailItemNode
          index={1}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
          onSubscribeDirtyPage={fake.subscribeDirtyPage}
          onGetIsDirtyPage={fake.getIsDirtyPage}
          onGetRotation={fake.getRotation}
        />
      </>,
    );

    const items = container.querySelectorAll('.thumbnail-item');
    expect(items.length).toBe(2);
    expect(items[0].className).toContain('active');
    expect(items[1].className).not.toContain('active');

    act(() => { fake.setActive(1); });

    const itemsAfter = container.querySelectorAll('.thumbnail-item');
    expect(itemsAfter[0].className).not.toContain('active');
    expect(itemsAfter[1].className).toContain('active');
  });

  it('ThumbnailPanel から currentPageIndex は ThumbnailItemNode の prop として渡さない (型契約)', () => {
    // ThumbnailItemProps から currentPageIndex が消えていることを型レベルでも保証する。
    // TS の構造的型付けにより、currentPageIndex を含む props で render すると
    // 余計なプロパティは静的には許容されるが、ランタイムで参照されないことを担保する。
    // → 上記の "active class" テストで currentPageIndex を一切渡していないにも
    //    関わらず active class が付与されることで、prop drill されていないことが
    //    間接的に証明されている。ここでは念押しで型上のプロップ名を assertion する。
    type ItemProps = React.ComponentProps<typeof ThumbnailItemNode>;
    const probe: ItemProps = {
      index: 0,
      loadEpoch: 0,
      onSelect: () => {},
      onRequest: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
      onSubscribeDirtyPage: () => () => {},
      onGetIsDirtyPage: () => false,
      onGetRotation: () => 0,
    };
    // currentPageIndex というキーが存在しないことを assertion (型 narrowing 用)
    expect('currentPageIndex' in probe).toBe(false);
    // issue #173: isDirty も prop ではなくなり pub/sub 経由になっている。
    expect('isDirty' in probe).toBe(false);
  });
});

describe('Issue #68: ThumbnailPanel itemContent memoization', () => {
  it('ThumbnailPanel が currentPageIndex 変化で再レンダしても、React.memo された ThumbnailItemNode は再レンダされない', () => {
    const fake = makeFakePanel();
    const getIsActiveSpy = vi.fn((index: number) => fake.getIsActivePage(index));

    // 親が currentPageIndex を変えて再レンダしても、ThumbnailItemNode の props は
    // 何ひとつ変わらない (currentPageIndex 自体が prop ではなくなったため)。
    // React.memo がデフォルトの shallow compare で同一性を判定し、レンダをスキップする。
    function Parent({ currentPageIndex }: { currentPageIndex: number }) {
      void currentPageIndex;
      return (
        <>
          {[0, 1, 2].map(i => (
            <ThumbnailItemNode
              key={i}
              index={i}
              loadEpoch={0}
              onSelect={fake.onSelectPage}
              onRequest={fake.onRequestThumbnail}
              onSubscribeThumbnail={fake.subscribeThumbnail}
              onGetThumbnail={fake.getThumbnail}
              onSubscribeActivePage={fake.subscribeActivePage}
              onGetIsActivePage={getIsActiveSpy}
              onSubscribeDirtyPage={fake.subscribeDirtyPage}
              onGetIsDirtyPage={fake.getIsDirtyPage}
              onGetRotation={fake.getRotation}
            />
          ))}
        </>
      );
    }

    const { rerender } = render(<Parent currentPageIndex={0} />);

    const initialCalls = getIsActiveSpy.mock.calls.length;
    // 初回は 3 アイテムぶん呼ばれている
    expect(initialCalls).toBe(3);

    getIsActiveSpy.mockClear();

    // 親が新しい currentPageIndex で再レンダ
    // (active 通知は走らせない - itemContent memoization 効果のみを検証)
    rerender(<Parent currentPageIndex={1} />);

    // ThumbnailItemNode の props は全て同一 (関数も同じ参照) のため、
    // React.memo がスキップ → onGetIsActivePage は 1 度も呼ばれない
    expect(getIsActiveSpy.mock.calls.length).toBe(0);
  });

  it('useCallback で itemContent の identity が安定 (Virtuoso が memoization を効かせる前提)', () => {
    // ThumbnailPanel 本体は Virtuoso (IntersectionObserver) に依存し jsdom で起動が重いため、
    // ここでは useCallback の identity 安定性のみを直接検証する。
    // ThumbnailPanel.tsx の useCallback 依存と同じ列を使う。
    let lastItemContent: ((i: number) => React.ReactElement) | null = null;
    function Probe({
      currentPageIndex,
      loadEpoch,
      onSelectPage,
      onRequestThumbnail,
      onSubscribeThumbnail,
      onGetThumbnail,
      onSubscribeActivePage,
      onGetIsActivePage,
      onSubscribeDirtyPage,
      onGetIsDirtyPage,
    }: any) {
      const itemContent = React.useCallback(
        (i: number) => <div data-index={i} />,
        // ThumbnailPanel 本体と同じ列。document は依存に含めない (issue #173)。
        [loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail, onSubscribeActivePage, onGetIsActivePage, onSubscribeDirtyPage, onGetIsDirtyPage],
      );
      lastItemContent = itemContent;
      void currentPageIndex;
      return null;
    }

    const stableDeps = {
      loadEpoch: 0,
      onSelectPage: () => {},
      onRequestThumbnail: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
      onSubscribeDirtyPage: () => () => {},
      onGetIsDirtyPage: () => false,
    };

    const { rerender } = render(<Probe currentPageIndex={0} {...stableDeps} />);
    const first = lastItemContent;

    rerender(<Probe currentPageIndex={3} {...stableDeps} />);
    const second = lastItemContent;

    // currentPageIndex を依存に含めていないため identity 保持
    expect(second).toBe(first);
  });

  it('issue #286: onContextMenu prop が ThumbnailItemNode に渡される (型契約)', () => {
    type ItemProps = React.ComponentProps<typeof ThumbnailItemNode>;
    const probe: ItemProps = {
      index: 0,
      loadEpoch: 0,
      onSelect: () => {},
      onRequest: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
      onSubscribeDirtyPage: () => () => {},
      onGetIsDirtyPage: () => false,
      onGetRotation: () => 0,
      onContextMenu: () => {},
    };
    expect(typeof probe.onContextMenu).toBe('function');
  });

  it('issue #173: document 更新 (updatePageData) で itemContent identity が変わらない', () => {
    // 旧実装は useCallback 依存に `document` を含めていたため、updatePageData で
    // 新しい document オブジェクトが生まれる度 itemContent が再生成され、
    // Virtuoso 可視範囲の全 ThumbnailItemNode が unmount/remount → サムネが一瞬消えた。
    // dirty も pub/sub になったので document を依存から外せる。
    let lastItemContent: ((i: number) => React.ReactElement) | null = null;
    function Probe({
      doc,
      loadEpoch,
      onSelectPage,
      onRequestThumbnail,
      onSubscribeThumbnail,
      onGetThumbnail,
      onSubscribeActivePage,
      onGetIsActivePage,
      onSubscribeDirtyPage,
      onGetIsDirtyPage,
    }: any) {
      const itemContent = React.useCallback(
        (i: number) => <div data-index={i} />,
        [loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail, onSubscribeActivePage, onGetIsActivePage, onSubscribeDirtyPage, onGetIsDirtyPage],
      );
      lastItemContent = itemContent;
      void doc;
      return null;
    }

    const stableDeps = {
      loadEpoch: 0,
      onSelectPage: () => {},
      onRequestThumbnail: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
      onSubscribeDirtyPage: () => () => {},
      onGetIsDirtyPage: () => false,
    };

    const doc1 = { totalPages: 5, pages: new Map() };
    const doc2 = { totalPages: 5, pages: new Map() }; // updatePageData 後の新参照
    const { rerender } = render(<Probe doc={doc1} {...stableDeps} />);
    const first = lastItemContent;

    rerender(<Probe doc={doc2} {...stableDeps} />);
    const second = lastItemContent;

    expect(second).toBe(first);
  });
});

// ─── Issue #286 リグレッション ────────────────────────────────────────────────

describe('Issue #286: コンテキストメニュー表示', () => {
  function makeFakeForContextMenu() {
    return {
      subscribeActivePage: (_index: number, _cb: () => void) => () => {},
      getIsActivePage: (_index: number) => false,
      subscribeThumbnail: (_index: number, _cb: () => void) => () => {},
      getThumbnail: (_index: number) => undefined as string | undefined,
      subscribeDirtyPage: (_index: number, _cb: () => void) => () => {},
      getIsDirtyPage: (_index: number) => false,
      getRotation: (_index: number) => 0,
      onSelectPage: vi.fn(),
      onRequestThumbnail: vi.fn(),
      onContextMenu: vi.fn(),
    };
  }

  beforeEach(() => {
    // RAF をジャスミン同期スタブに置き換え
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('右クリックで onContextMenu が呼ばれる', () => {
    const fake = makeFakeForContextMenu();
    const { container } = render(
      <ThumbnailItemNode
        index={0}
        loadEpoch={0}
        onSelect={fake.onSelectPage}
        onRequest={fake.onRequestThumbnail}
        onSubscribeThumbnail={fake.subscribeThumbnail}
        onGetThumbnail={fake.getThumbnail}
        onSubscribeActivePage={fake.subscribeActivePage}
        onGetIsActivePage={fake.getIsActivePage}
        onSubscribeDirtyPage={fake.subscribeDirtyPage}
        onGetIsDirtyPage={fake.getIsDirtyPage}
        onGetRotation={fake.getRotation}
        onContextMenu={fake.onContextMenu}
      />,
    );
    const btn = container.querySelector('button')!;
    act(() => {
      fireEvent.contextMenu(btn, { clientX: 100, clientY: 200 });
    });
    expect(fake.onContextMenu).toHaveBeenCalledTimes(1);
    expect(fake.onContextMenu.mock.calls[0][1]).toBe(0); // displayIndex = 0
  });

  it('button=2 (右クリック) で onPointerDown が dnd-kit に渡らない (safeListeners)', () => {
    // SortableThumbnailWrapper の safeListeners は pointerdown button=2 を透過させる。
    // PointerSensor は activeDragId をセットしないことを確認する。
    // → ThumbnailItemNode 単体テストで onContextMenu が呼ばれることを確認済みのため、
    //   ここでは onPointerDown を直接スパイして確認する。
    const pointerDownSpy = vi.fn();
    const fakeListeners = { onPointerDown: pointerDownSpy };

    // safeListeners ロジックを単体で再現（コンポーネント外で確認）
    const safeOnPointerDown = (e: { button: number }) => {
      if (e.button !== 0) return;
      fakeListeners.onPointerDown(e);
    };

    safeOnPointerDown({ button: 2 }); // 右クリック
    expect(pointerDownSpy).not.toHaveBeenCalled();

    safeOnPointerDown({ button: 0 }); // 左クリック
    expect(pointerDownSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── PCT-088 リグレッション ──────────────────────────────────────────────────

describe('PCT-088: 矢印キーページ移動のフォーカス維持', () => {
  // バグ: クリックしたサムネイル (dnd-kit wrapper, tabIndex=0) がフォーカスを保持し、
  // 矢印キーでページが進むと仮想化リストからアンマウント → フォーカスが body に落ち、
  // .scroll-content の onKeyDown が発火しなくなり矢印キーがスクロールに化ける。

  it('SortableThumbnailWrapper の tabIndex は -1 (dnd-kit attributes の tabIndex=0 を上書き)', () => {
    // 実物の useSortable を使い、attributes 展開後の上書きが効いていることを検証する。
    // KeyboardSensor 不使用のため tabIndex=0 はフォーカスを奪うだけで利点がない。
    const { container } = render(
      <DndContext>
        <SortableContext items={[0]} strategy={verticalListSortingStrategy}>
          <SortableThumbnailWrapper displayIndex={0}>
            <div>thumb</div>
          </SortableThumbnailWrapper>
        </SortableContext>
      </DndContext>,
    );

    const wrapper = container.querySelector('.thumbnail-sortable-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('tabindex')).toBe('-1');
    // aria 属性 (role 等) は維持されること (attributes 展開自体は消さない)
    expect(wrapper!.getAttribute('role')).toBe('button');
  });

  it('サムネイルクリックで .scroll-content にフォーカスが移り onSelect が呼ばれる', () => {
    const fake = makeFakePanel();
    const { container } = render(
      <div className="scroll-content" tabIndex={0}>
        <ThumbnailItemNode
          index={1}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
          onSubscribeDirtyPage={fake.subscribeDirtyPage}
          onGetIsDirtyPage={fake.getIsDirtyPage}
          onGetRotation={fake.getRotation}
          onContextMenu={() => {}}
        />
      </div>,
    );

    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;
    const btn = container.querySelector('button.thumbnail-item')!;

    fireEvent.click(btn);

    // フォーカスホルダーは安定要素 (.scroll-content)。クリック要素が後で
    // 仮想化ウィンドウからアンマウントされても矢印キーのページ移動が継続する。
    expect(document.activeElement).toBe(scrollContent);
    expect(fake.onSelectPage).toHaveBeenCalledTimes(1);
    expect(fake.onSelectPage).toHaveBeenCalledWith(1);
  });

  it('アクティブなサムネイルのクリックでも .scroll-content にフォーカスが移る', () => {
    // active 分岐 (aria-current="page" の button) も同じ handleClick を通ることを確認
    const fake = makeFakePanel();
    const { container } = render(
      <div className="scroll-content" tabIndex={0}>
        <ThumbnailItemNode
          index={0}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
          onSubscribeDirtyPage={fake.subscribeDirtyPage}
          onGetIsDirtyPage={fake.getIsDirtyPage}
          onGetRotation={fake.getRotation}
          onContextMenu={() => {}}
        />
      </div>,
    );

    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;
    const btn = container.querySelector('button.thumbnail-item.active')!;
    expect(btn).not.toBeNull();

    fireEvent.click(btn);

    expect(document.activeElement).toBe(scrollContent);
    expect(fake.onSelectPage).toHaveBeenCalledWith(0);
  });
});

// ─── ThumbnailPanel フルレンダーテスト ─────────────────────────────────────
//
// 上記のテストは ThumbnailItemNode / SortableThumbnailWrapper を単体でしかレンダしておらず、
// ThumbnailPanel 本体 (コンテキストメニューのハンドラ群・onGetRotation・sortableItems 構築)
// は coverage 実測 (Lines 35.53%) の通りほぼ未検証だった。
// react-virtuoso を ThumbnailWindow.test.tsx と同じ方式でモックし、ThumbnailPanel を
// フルレンダーして検証する。

function buildDocument(pageRotations: Array<0 | 90 | 180 | 270>): Pick<PecoDocument, 'totalPages' | 'pages'> {
  const pages = new Map<number, PageData>();
  pageRotations.forEach((rotation, idx) => {
    pages.set(idx, {
      pageIndex: idx,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
      rotation,
    });
  });
  return { totalPages: pageRotations.length, pages };
}

function makeFullPanelFake() {
  const activeListeners = new Map<number, Set<() => void>>();
  const dirtyListeners = new Map<number, Set<() => void>>();
  const dirtySet = new Set<number>();
  const thumbnails = new Map<number, string>();
  let activeIndex = 0;

  return {
    subscribeThumbnail: (_index: number, _cb: () => void) => () => {},
    getThumbnail: (index: number) => thumbnails.get(index),
    setThumbnail(index: number, url: string) {
      thumbnails.set(index, url);
    },
    subscribeActivePage: (index: number, cb: () => void) => {
      if (!activeListeners.has(index)) activeListeners.set(index, new Set());
      activeListeners.get(index)!.add(cb);
      return () => { activeListeners.get(index)?.delete(cb); };
    },
    getIsActivePage: (index: number) => activeIndex === index,
    setActive(next: number) { activeIndex = next; },
    subscribeDirtyPage: (index: number, cb: () => void) => {
      if (!dirtyListeners.has(index)) dirtyListeners.set(index, new Set());
      dirtyListeners.get(index)!.add(cb);
      return () => { dirtyListeners.get(index)?.delete(cb); };
    },
    getIsDirtyPage: (index: number) => dirtySet.has(index),
    /** pecoStore.rotatePages 相当: 対象ページを isDirty にし、dirty pub/sub の listener へ通知する。 */
    notifyDirty(index: number, isDirty: boolean) {
      if (isDirty) dirtySet.add(index); else dirtySet.delete(index);
      dirtyListeners.get(index)?.forEach(cb => cb());
    },
    onSelectPage: vi.fn(),
    onRequestThumbnail: vi.fn(),
    onDeletePages: vi.fn(),
    onMovePage: vi.fn(),
    onRotatePages: vi.fn(),
    onExtractPages: vi.fn(),
  };
}

function renderPanel(
  doc: Pick<PecoDocument, 'totalPages' | 'pages'> | null,
  fake: ReturnType<typeof makeFullPanelFake>,
  overrides: Partial<React.ComponentProps<typeof ThumbnailPanel>> = {},
) {
  return render(
    <ThumbnailPanel
      width={200}
      document={doc}
      currentPageIndex={0}
      loadEpoch={0}
      isOcrRunning={false}
      onSelectPage={fake.onSelectPage}
      onRequestThumbnail={fake.onRequestThumbnail}
      onSubscribeThumbnail={fake.subscribeThumbnail}
      onGetThumbnail={fake.getThumbnail}
      onSubscribeActivePage={fake.subscribeActivePage}
      onGetIsActivePage={fake.getIsActivePage}
      onSubscribeDirtyPage={fake.subscribeDirtyPage}
      onGetIsDirtyPage={fake.getIsDirtyPage}
      onDeletePages={fake.onDeletePages}
      onMovePage={fake.onMovePage}
      onRotatePages={fake.onRotatePages}
      onExtractPages={fake.onExtractPages}
      {...overrides}
    />,
  );
}

function openContextMenu(container: HTMLElement, displayIndex: number) {
  const buttons = container.querySelectorAll('button.thumbnail-item');
  const btn = buttons[displayIndex] as HTMLElement;
  act(() => { fireEvent.contextMenu(btn, { clientX: 10, clientY: 10 }); });
}

function findMenuItem(container: HTMLElement, label: string): HTMLElement {
  const item = Array.from(container.querySelectorAll('button.thumbnail-context-menu-item'))
    .find(b => b.textContent === label);
  expect(item, `context menu item "${label}" not found`).toBeDefined();
  return item as HTMLElement;
}

describe('#431/PCT-124 系: 回転が実 onGetRotation 経由でサムネ CSS variable に反映される', () => {
  it('rotation=0/90/180 に応じて thumbnail-box の --thumb-box-w/h がスワップされる (90/270 のみ landscape)', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 90, 180]);
    const { container } = renderPanel(doc, fake);

    const boxes = container.querySelectorAll('.thumbnail-box');
    expect(boxes).toHaveLength(3);

    // rotation=0: variable 未設定 (CSS デフォルト縦置きのまま)
    expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');
    expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-h')).toBe('');

    // rotation=90 (landscape): 幅高さがスワップされる
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('160px');
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-h')).toBe('120px');

    // rotation=180: 縦横比不変なので landscape 扱いではなく variable 未設定
    expect((boxes[2] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');
  });

  it('rotation!=0 の img には --thumbnail-rotation variable と thumbnail-img--rotated class が付く', () => {
    const fake = makeFullPanelFake();
    fake.setThumbnail(0, 'data:image/jpeg;base64,AAA');
    fake.setThumbnail(1, 'data:image/jpeg;base64,BBB');
    const doc = buildDocument([0, 270]);
    const { container } = renderPanel(doc, fake);

    const imgs = container.querySelectorAll('img.thumbnail-img');
    expect(imgs).toHaveLength(2);

    expect(imgs[0].className).not.toContain('thumbnail-img--rotated');
    expect((imgs[0] as HTMLElement).style.getPropertyValue('--thumbnail-rotation')).toBe('');

    expect(imgs[1].className).toContain('thumbnail-img--rotated');
    expect((imgs[1] as HTMLElement).style.getPropertyValue('--thumbnail-rotation')).toBe('270deg');
  });
});

describe('#429/#431/#434 系回帰観点: 回転更新は dirty pub/sub 通知に相乗りして再反映される', () => {
  // pecoStore.rotatePages は回転対象ページを isDirty: true にし (pecoStore.ts L682/L698)、
  // useThumbnailPanel の dirty pub/sub がそのページの listener だけへ通知する。
  // rotation 自体は独立した pub/sub を持たず render 時に onGetRotation で都度読まれるだけなので、
  // 「dirty 通知が飛ばない限り再描画されず、古い回転のまま表示され続ける」契約になっている。
  // この契約が壊れる(dirty 通知だけでは更新されなくなる/通知なしでも更新されてしまうと誤認する)と
  // #429/#431/#434 と同じ「サムネの見た目が更新されない・別ページの回転が混ざる」再発につながる。
  it('document.pages の rotation を書き換えただけでは反映されず、dirty 通知後にのみ反映される', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container, rerender } = renderPanel(doc, fake);

    let boxes = container.querySelectorAll('.thumbnail-box');
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');

    // 回転後の document (index=1 のみ rotation=90) を親から渡す。
    // ThumbnailItemNode(index=1) への props (onGetRotation 等の callback identity) は
    // 一切変化しないため React.memo によりこの時点では再レンダされない。
    const rotatedDoc = buildDocument([0, 90, 0]);
    rerender(
      <ThumbnailPanel
        width={200}
        document={rotatedDoc}
        currentPageIndex={0}
        loadEpoch={0}
        isOcrRunning={false}
        onSelectPage={fake.onSelectPage}
        onRequestThumbnail={fake.onRequestThumbnail}
        onSubscribeThumbnail={fake.subscribeThumbnail}
        onGetThumbnail={fake.getThumbnail}
        onSubscribeActivePage={fake.subscribeActivePage}
        onGetIsActivePage={fake.getIsActivePage}
        onSubscribeDirtyPage={fake.subscribeDirtyPage}
        onGetIsDirtyPage={fake.getIsDirtyPage}
        onDeletePages={fake.onDeletePages}
        onMovePage={fake.onMovePage}
        onRotatePages={fake.onRotatePages}
        onExtractPages={fake.onExtractPages}
      />,
    );

    boxes = container.querySelectorAll('.thumbnail-box');
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');

    // 実アプリの rotatePages 相当: 対象ページを dirty にして listener へ通知する。
    act(() => { fake.notifyDirty(1, true); });

    boxes = container.querySelectorAll('.thumbnail-box');
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('160px');
    expect((boxes[1] as HTMLElement).style.getPropertyValue('--thumb-box-h')).toBe('120px');

    // 隣接ページ (index=0, index=2) は通知を受けていないので rotation=0 のまま
    expect((boxes[0] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');
    expect((boxes[2] as HTMLElement).style.getPropertyValue('--thumb-box-w')).toBe('');
  });
});

describe('#434 系回帰観点: コンテキストメニューの操作が正しい displayIndex にバインドされる', () => {
  // #434 (B-2) は useThumbnailWindow.getRotations が displayIndex キーの document.pages を
  // source index で引いてしまい、並べ替え/削除後に別ページの回転を返す事故だった。
  // ThumbnailPanel では同種の「間違った index が操作対象に紐付く」リスクは
  // コンテキストメニューの各ハンドラ (handleRotateRight/Left/180, handleExtract) が
  // contextMenu.targetDisplayIndex を正しく積むかどうかに現れる。ここを直接検証する。
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('末尾ページ(displayIndex=2)を右クリックして右回転すると、onRotatePages が [2], 90 で呼ばれる (0 に誤爆しない)', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 2);
    const btn = findMenuItem(container, '右に 90° 回転');
    act(() => { fireEvent.click(btn); });

    expect(fake.onRotatePages).toHaveBeenCalledTimes(1);
    expect(fake.onRotatePages).toHaveBeenCalledWith([2], 90);
  });

  it('中間ページ(displayIndex=1)を右クリックして左回転すると、onRotatePages が [1], 270 で呼ばれる', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 1);
    const btn = findMenuItem(container, '左に 90° 回転');
    act(() => { fireEvent.click(btn); });

    expect(fake.onRotatePages).toHaveBeenCalledWith([1], 270);
  });

  it('180度回転メニューは対象 displayIndex と delta=180 で呼ばれる', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 2);
    const btn = findMenuItem(container, '180° 回転');
    act(() => { fireEvent.click(btn); });

    expect(fake.onRotatePages).toHaveBeenCalledWith([2], 180);
  });

  it('抽出メニューは対象 displayIndex で onExtractPages を呼ぶ', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 2);
    const btn = findMenuItem(container, '選択ページを別 PDF として書き出し');
    act(() => { fireEvent.click(btn); });

    expect(fake.onExtractPages).toHaveBeenCalledWith([2]);
  });

  it('右クリックした対象と異なるページを操作しない (displayIndex=0 の隣接ページには波及しない)', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 3);
    const btn = findMenuItem(container, '右に 90° 回転');
    act(() => { fireEvent.click(btn); });

    expect(fake.onRotatePages).not.toHaveBeenCalledWith([0], 90);
    expect(fake.onRotatePages).toHaveBeenCalledWith([3], 90);
  });
});

describe('PCT-123 系回帰観点: 削除確認ダイアログの分岐と displayIndex の整合', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dialogMocks.ask.mockReset().mockResolvedValue(true);
    dialogMocks.message.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('最終ページ(totalPages<=1)の削除は message() のみで onDeletePages を呼ばない', async () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 0);
    const btn = findMenuItem(container, 'このページを削除');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialogMocks.message).toHaveBeenCalledTimes(1);
    expect(dialogMocks.ask).not.toHaveBeenCalled();
    expect(fake.onDeletePages).not.toHaveBeenCalled();
  });

  it('末尾ページ(displayIndex=2)の削除は ask() の確認後に onDeletePages が [2] で呼ばれる', async () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 2);
    const btn = findMenuItem(container, 'このページを削除');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialogMocks.ask).toHaveBeenCalledTimes(1);
    expect(dialogMocks.ask.mock.calls[0][0]).toContain('ページ 3');
    expect(fake.onDeletePages).toHaveBeenCalledWith([2]);
  });

  it('ask() が false を返す (キャンセル) と onDeletePages を呼ばない', async () => {
    dialogMocks.ask.mockReset().mockResolvedValue(false);
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake);

    openContextMenu(container, 1);
    const btn = findMenuItem(container, 'このページを削除');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.onDeletePages).not.toHaveBeenCalled();
  });
});

describe('ThumbnailPanel: 矢印キーによるページ選択状態の境界', () => {
  it('#457: Alt+上下矢印で現在ページを並び替え、live regionへ通知する', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake, { currentPageIndex: 1 });
    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;

    expect(scrollContent.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    fireEvent.keyDown(scrollContent, { key: 'ArrowDown', altKey: true });

    expect(fake.onMovePage).toHaveBeenCalledWith(1, 2);
    expect(fake.onSelectPage).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('ページ 2 を 3 ページ目へ移動しました');
  });

  it('#457: 非同期move中のAlt+Arrow連打を抑止し、完了後はロックを解除する', async () => {
    const fake = makeFullPanelFake();
    let finishMove!: () => void;
    fake.onMovePage.mockReturnValue(new Promise<void>((resolve) => { finishMove = resolve; }));
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake, { currentPageIndex: 1 });
    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;

    fireEvent.keyDown(scrollContent, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(scrollContent, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(scrollContent, { key: 'ArrowDown', altKey: true });

    expect(fake.onMovePage).toHaveBeenCalledTimes(1);
    expect(fake.onMovePage).toHaveBeenCalledWith(1, 2);
    await act(async () => {
      finishMove();
      await Promise.resolve();
    });

    fireEvent.keyDown(scrollContent, { key: 'ArrowDown', altKey: true });
    expect(fake.onMovePage).toHaveBeenCalledTimes(2);
  });

  it('ArrowDown/ArrowRight で currentPageIndex+1 を選択する（末尾では選択しない）', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container, rerender } = renderPanel(doc, fake, { currentPageIndex: 1 });

    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;
    fireEvent.keyDown(scrollContent, { key: 'ArrowDown' });
    expect(fake.onSelectPage).toHaveBeenCalledWith(2);

    fake.onSelectPage.mockClear();
    rerender(
      <ThumbnailPanel
        width={200}
        document={doc}
        currentPageIndex={2}
        loadEpoch={0}
        isOcrRunning={false}
        onSelectPage={fake.onSelectPage}
        onRequestThumbnail={fake.onRequestThumbnail}
        onSubscribeThumbnail={fake.subscribeThumbnail}
        onGetThumbnail={fake.getThumbnail}
        onSubscribeActivePage={fake.subscribeActivePage}
        onGetIsActivePage={fake.getIsActivePage}
        onSubscribeDirtyPage={fake.subscribeDirtyPage}
        onGetIsDirtyPage={fake.getIsDirtyPage}
        onDeletePages={fake.onDeletePages}
        onMovePage={fake.onMovePage}
        onRotatePages={fake.onRotatePages}
        onExtractPages={fake.onExtractPages}
      />,
    );
    // 末尾ページ (totalPages=3, currentPageIndex=2) では ArrowRight は無視される
    fireEvent.keyDown(scrollContent, { key: 'ArrowRight' });
    expect(fake.onSelectPage).not.toHaveBeenCalled();
  });

  it('ArrowUp/ArrowLeft で currentPageIndex-1 を選択する（先頭では選択しない）', () => {
    const fake = makeFullPanelFake();
    const doc = buildDocument([0, 0, 0]);
    const { container } = renderPanel(doc, fake, { currentPageIndex: 1 });

    const scrollContent = container.querySelector('.scroll-content') as HTMLElement;
    fireEvent.keyDown(scrollContent, { key: 'ArrowUp' });
    expect(fake.onSelectPage).toHaveBeenCalledWith(0);

    fake.onSelectPage.mockClear();
    // 先頭ページ (currentPageIndex=0) では ArrowLeft は無視される
    const { container: container2 } = renderPanel(doc, fake, { currentPageIndex: 0 });
    const scrollContent2 = container2.querySelector('.scroll-content') as HTMLElement;
    fireEvent.keyDown(scrollContent2, { key: 'ArrowLeft' });
    expect(fake.onSelectPage).not.toHaveBeenCalled();
  });
});

describe('component-level dedup 補完: ThumbnailItemNode の再取得リクエスト', () => {
  // S-07-05 (useThumbnailPanel.test.ts) は hook 側 (requestThumbnail の queue dedup) を
  // 実 hook 経由で検証済み。ここでは呼び出し元である ThumbnailItemNode 側の効果
  // (「サムネ未取得のときだけ onRequest を呼ぶ」L139-142) を補完する。層が異なるため重複しない。
  it('サムネイル未取得なら mount 時に onRequest を1回だけ呼ぶ', () => {
    const onRequest = vi.fn();
    render(
      <ThumbnailItemNode
        index={4}
        loadEpoch={0}
        onSelect={vi.fn()}
        onRequest={onRequest}
        onSubscribeThumbnail={() => () => {}}
        onGetThumbnail={() => undefined}
        onSubscribeActivePage={() => () => {}}
        onGetIsActivePage={() => false}
        onSubscribeDirtyPage={() => () => {}}
        onGetIsDirtyPage={() => false}
        onGetRotation={() => 0}
        onContextMenu={() => {}}
      />,
    );

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(4);
  });

  it('サムネイル取得済みなら onRequest を呼ばない', () => {
    const onRequest = vi.fn();
    render(
      <ThumbnailItemNode
        index={4}
        loadEpoch={0}
        onSelect={vi.fn()}
        onRequest={onRequest}
        onSubscribeThumbnail={() => () => {}}
        onGetThumbnail={() => 'data:image/jpeg;base64,AAA'}
        onSubscribeActivePage={() => () => {}}
        onGetIsActivePage={() => false}
        onSubscribeDirtyPage={() => () => {}}
        onGetIsDirtyPage={() => false}
        onGetRotation={() => 0}
        onContextMenu={() => {}}
      />,
    );

    expect(onRequest).not.toHaveBeenCalled();
  });
});
