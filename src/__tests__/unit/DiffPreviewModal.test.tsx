/**
 * DiffPreviewModal — 基本表示テスト (issue #201)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

// lucide-react: 明示的にモックして importOriginal() 呼び出しを回避
vi.mock('lucide-react', () => ({
  X: () => null,
}));

// Modal は内部実装をスキップしてコンテンツのみレンダリング
vi.mock('../../components/ui/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useModalTitleId: () => 'mock-title-id',
}));

import { DiffPreviewModal } from '../../components/DiffPreviewModal';
import type { SaveDiffSummary } from '../../utils/saveDiffSummary';

afterEach(() => cleanup());

function makeSummary(overrides?: Partial<SaveDiffSummary>): SaveDiffSummary {
  return {
    entries: [],
    totalPages: 0,
    changedPages: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DiffPreviewModal', () => {
  it('エントリが 0 件のとき「変更はありません。」が表示される', () => {
    render(
      <DiffPreviewModal
        summary={makeSummary()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('変更はありません。')).toBeTruthy();
  });

  it('modified エントリが表示される', () => {
    const summary = makeSummary({
      entries: [
        { pageIndex: 0, blockId: 'b1', before: '変更前テキスト', after: '変更後テキスト', changeType: 'modified' },
      ],
      changedPages: [0],
      totalPages: 1,
    });
    render(
      <DiffPreviewModal
        summary={summary}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('変更前テキスト')).toBeTruthy();
    expect(screen.getByText('変更後テキスト')).toBeTruthy();
    expect(screen.getByText('変更')).toBeTruthy();
  });

  it('added エントリは「追加」と表示される', () => {
    const summary = makeSummary({
      entries: [
        { pageIndex: 1, blockId: 'b2', before: '', after: '新しいブロック', changeType: 'added' },
      ],
      changedPages: [1],
      totalPages: 1,
    });
    render(
      <DiffPreviewModal
        summary={summary}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('追加')).toBeTruthy();
  });

  it('removed エントリは「削除」と表示される', () => {
    const summary = makeSummary({
      entries: [
        { pageIndex: 2, blockId: 'b3', before: '消えるテキスト', after: '', changeType: 'removed' },
      ],
      changedPages: [2],
      totalPages: 1,
    });
    render(
      <DiffPreviewModal
        summary={summary}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('削除')).toBeTruthy();
    expect(screen.getByText('消えるテキスト')).toBeTruthy();
  });

  it('「保存する」ボタンクリックで onConfirm が呼ばれる', () => {
    const onConfirm = vi.fn();
    render(
      <DiffPreviewModal
        summary={makeSummary()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('保存する'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('「キャンセル」ボタンクリックで onCancel が呼ばれる', () => {
    const onCancel = vi.fn();
    render(
      <DiffPreviewModal
        summary={makeSummary()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByText('キャンセル'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('変更ページ数とブロック数のサマリが表示される', () => {
    const summary = makeSummary({
      entries: [
        { pageIndex: 0, blockId: 'b1', before: '前', after: '後', changeType: 'modified' },
        { pageIndex: 2, blockId: 'b2', before: '前2', after: '後2', changeType: 'modified' },
      ],
      changedPages: [0, 2],
      totalPages: 2,
    });
    render(
      <DiffPreviewModal
        summary={summary}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    // 変更ページ数: 2, 変更ブロック数: 2 が強調表示されることを確認
    const allStrong = screen.getAllByText(/\d+/);
    const texts = allStrong.map((el) => el.textContent);
    expect(texts).toContain('2');
  });

  it('80 文字を超えるテキストは切り詰められる', () => {
    const longText = 'あ'.repeat(100);
    const summary = makeSummary({
      entries: [
        { pageIndex: 0, blockId: 'b1', before: longText, after: 'after', changeType: 'modified' },
      ],
      changedPages: [0],
      totalPages: 1,
    });
    render(
      <DiffPreviewModal
        summary={summary}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    // truncate(text, 80) = 80文字 + '…'
    const truncated = 'あ'.repeat(80) + '…';
    expect(screen.getByText(truncated)).toBeTruthy();
  });
});
