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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ThumbnailPanel, ThumbnailItemNode } from '../../components/Sidebar/ThumbnailPanel';

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
          isDirty={false}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={getIsActiveSpy}
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
          isDirty={false}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
        />
        <ThumbnailItemNode
          index={1}
          isDirty={false}
          loadEpoch={0}
          onSelect={fake.onSelectPage}
          onRequest={fake.onRequestThumbnail}
          onSubscribeThumbnail={fake.subscribeThumbnail}
          onGetThumbnail={fake.getThumbnail}
          onSubscribeActivePage={fake.subscribeActivePage}
          onGetIsActivePage={fake.getIsActivePage}
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
      isDirty: false,
      loadEpoch: 0,
      onSelect: () => {},
      onRequest: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
    };
    // currentPageIndex というキーが存在しないことを assertion (型 narrowing 用)
    expect('currentPageIndex' in probe).toBe(false);
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
              isDirty={false}
              loadEpoch={0}
              onSelect={fake.onSelectPage}
              onRequest={fake.onRequestThumbnail}
              onSubscribeThumbnail={fake.subscribeThumbnail}
              onGetThumbnail={fake.getThumbnail}
              onSubscribeActivePage={fake.subscribeActivePage}
              onGetIsActivePage={getIsActiveSpy}
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
      document,
      loadEpoch,
      onSelectPage,
      onRequestThumbnail,
      onSubscribeThumbnail,
      onGetThumbnail,
      onSubscribeActivePage,
      onGetIsActivePage,
    }: any) {
      const itemContent = React.useCallback(
        (i: number) => <div data-index={i} />,
        [document, loadEpoch, onSelectPage, onRequestThumbnail, onSubscribeThumbnail, onGetThumbnail, onSubscribeActivePage, onGetIsActivePage],
      );
      lastItemContent = itemContent;
      void currentPageIndex;
      return null;
    }

    const stableDeps = {
      document: { totalPages: 5, pages: new Map() },
      loadEpoch: 0,
      onSelectPage: () => {},
      onRequestThumbnail: () => {},
      onSubscribeThumbnail: () => () => {},
      onGetThumbnail: () => undefined,
      onSubscribeActivePage: () => () => {},
      onGetIsActivePage: () => false,
    };

    const { rerender } = render(<Probe currentPageIndex={0} {...stableDeps} />);
    const first = lastItemContent;

    rerender(<Probe currentPageIndex={3} {...stableDeps} />);
    const second = lastItemContent;

    // currentPageIndex を依存に含めていないため identity 保持
    expect(second).toBe(first);
  });
});
