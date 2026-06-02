/**
 * Unit tests for src/utils/ocrCardCommit.ts (issue #270, wave 8)
 *
 * commitActiveOcrCardEdit は:
 *   - usePecoStore.getState() から updatePageData / document を取得する
 *   - flushActiveOcrCardText(updatePageData, document) を呼ぶ
 *   - その戻り値 (boolean) をそのまま返す
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// pecoStore と ocrEditFlush をモック化する (実装本体は触らない)
vi.mock('../../store/pecoStore', () => ({
  usePecoStore: {
    getState: vi.fn(),
  },
}));

vi.mock('../../utils/ocrEditFlush', () => ({
  flushActiveOcrCardText: vi.fn(),
}));

import { usePecoStore } from '../../store/pecoStore';
import { flushActiveOcrCardText } from '../../utils/ocrEditFlush';
import { commitActiveOcrCardEdit } from '../../utils/ocrCardCommit';

const getStateMock = usePecoStore.getState as unknown as ReturnType<typeof vi.fn>;
const flushMock = flushActiveOcrCardText as unknown as ReturnType<typeof vi.fn>;

// ── ヘルパー ──────────────────────────────────────────────────

function makeStoreState(overrides: {
  updatePageData?: ReturnType<typeof vi.fn>;
  document?: object | null;
} = {}) {
  return {
    updatePageData: overrides.updatePageData ?? vi.fn(),
    document: overrides.document ?? null,
  };
}

// ── tests ────────────────────────────────────────────────────

describe('commitActiveOcrCardEdit', () => {
  beforeEach(() => {
    getStateMock.mockReset();
    flushMock.mockReset();
  });

  it('flush が true を返す場合 commitActiveOcrCardEdit も true を返す (commit 成功)', () => {
    const state = makeStoreState();
    getStateMock.mockReturnValue(state);
    flushMock.mockReturnValue(true);

    const result = commitActiveOcrCardEdit();

    expect(result).toBe(true);
  });

  it('flush が false を返す場合 commitActiveOcrCardEdit も false を返す (変更なし)', () => {
    const state = makeStoreState();
    getStateMock.mockReturnValue(state);
    flushMock.mockReturnValue(false);

    const result = commitActiveOcrCardEdit();

    expect(result).toBe(false);
  });

  it('flushActiveOcrCardText に updatePageData と document が渡される', () => {
    const updatePageData = vi.fn();
    const document = { pages: new Map() };
    getStateMock.mockReturnValue({ updatePageData, document });
    flushMock.mockReturnValue(false);

    commitActiveOcrCardEdit();

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(flushMock).toHaveBeenCalledWith(updatePageData, document);
  });

  it('document が null の場合でも flushActiveOcrCardText が呼ばれる', () => {
    const updatePageData = vi.fn();
    getStateMock.mockReturnValue({ updatePageData, document: null });
    flushMock.mockReturnValue(false);

    commitActiveOcrCardEdit();

    expect(flushMock).toHaveBeenCalledWith(updatePageData, null);
  });

  it('usePecoStore.getState が 1 回だけ呼ばれる', () => {
    getStateMock.mockReturnValue(makeStoreState());
    flushMock.mockReturnValue(false);

    commitActiveOcrCardEdit();

    expect(getStateMock).toHaveBeenCalledTimes(1);
  });

  it('連続して 2 回呼んだとき毎回 getState が呼ばれる', () => {
    getStateMock.mockReturnValue(makeStoreState());
    flushMock.mockReturnValue(false);

    commitActiveOcrCardEdit();
    commitActiveOcrCardEdit();

    expect(getStateMock).toHaveBeenCalledTimes(2);
    expect(flushMock).toHaveBeenCalledTimes(2);
  });
});
