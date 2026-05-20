import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectionPanel } from '../../components/InspectionPanel';
import { useInspectionStore, type InspectionIssue } from '../../store/inspectionStore';
import { usePecoStore } from '../../store/pecoStore';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
}));

function makeBlock(id: string, order: number): TextBlock {
  return {
    id,
    text: `text-${id}`,
    originalText: `text-${id}`,
    bbox: { x: 0, y: order * 20, width: 100, height: 20 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  };
}

function makeDoc(blocks: TextBlock[], isTextExtracted = true): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
    isTextExtracted,
  };

  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  };
}

function makeIssue(overrides: Partial<InspectionIssue> = {}): InspectionIssue {
  return {
    id: 'issue-1',
    pageIndex: 0,
    category: 'sentence_fragmentation',
    severity: 'info',
    title: '結合候補があります',
    message: '文が複数 BB に分かれている可能性があります',
    blockIds: ['b1', 'b2'],
    bbox: { x: 0, y: 0, width: 100, height: 40 },
    text: 'これは検査です',
    suggestion: '必要なら複数 BB を選択してグループ化してください',
    ignored: false,
    ...overrides,
  };
}

beforeEach(() => {
  useInspectionStore.getState().resetInspection();
  usePecoStore.setState({
    document: makeDoc([makeBlock('b1', 0), makeBlock('b2', 1)]),
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    lastSelectedId: null,
    isDirty: false,
  } as any);
});

afterEach(() => {
  cleanup();
});

describe('InspectionPanel', () => {
  it('現在ページの検査結果と件数を表示する', () => {
    useInspectionStore.getState().setIssuesForPage(0, [
      makeIssue(),
      makeIssue({
        id: 'issue-2',
        category: 'reading_order_anomaly' as unknown as InspectionIssue['category'],
        severity: 'warning',
        title: '読み順構造の確認が必要です',
      }),
    ]);

    render(<InspectionPanel width={350} />);

    expect(screen.getByText('エラー 0')).toBeTruthy();
    expect(screen.getByText('警告 1')).toBeTruthy();
    expect(screen.getByText('確認 1')).toBeTruthy();
    expect(screen.getByText('結合候補があります')).toBeTruthy();
    expect(screen.getByText('読み順構造の確認が必要です')).toBeTruthy();
    expect(screen.getByRole('button', { name: '読み順構造 1' })).toBeTruthy();
  });

  it('カテゴリフィルタで結果一覧を絞り込む', () => {
    useInspectionStore.getState().setIssuesForPage(0, [
      makeIssue(),
      makeIssue({
        id: 'issue-2',
        category: 'duplicate_block' as unknown as InspectionIssue['category'],
        severity: 'warning',
        title: '重複ブロックがあります',
      }),
    ]);

    render(<InspectionPanel width={350} />);
    fireEvent.click(screen.getByRole('button', { name: '重複ブロック 1' }));

    expect(screen.getByText('重複ブロックがあります')).toBeTruthy();
    expect(screen.queryByText('結合候補があります')).toBeNull();
  });

  it('結果クリックで activeIssueId と selectedIds を更新する', () => {
    const issue = makeIssue();
    useInspectionStore.getState().setIssuesForPage(0, [issue]);

    render(<InspectionPanel width={350} />);
    fireEvent.click(screen.getByText(issue.title));

    expect(useInspectionStore.getState().activeIssueId).toBe(issue.id);
    expect(usePecoStore.getState().selectedIds).toEqual(new Set(issue.blockIds));
    expect(usePecoStore.getState().isDirty).toBe(false);
  });

  it('確認済みにした結果は一覧から消える', () => {
    const issue = makeIssue();
    useInspectionStore.getState().setIssuesForPage(0, [issue]);

    render(<InspectionPanel width={350} />);
    expect(screen.queryByRole('button', { name: '表示' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '確認済み' }));

    expect(useInspectionStore.getState().issuesByPage.get(0)?.[0].ignored).toBe(true);
    expect(screen.queryByText(issue.title)).toBeNull();
    expect(screen.getByText('検査結果なし')).toBeTruthy();
  });

  it('テキスト抽出前は検査待ちメッセージを表示する', () => {
    usePecoStore.setState({
      document: makeDoc([makeBlock('b1', 0)], false),
      currentPageIndex: 0,
    } as any);

    render(<InspectionPanel width={350} />);

    expect(screen.getByText('テキスト抽出後に検査できます')).toBeTruthy();
  });
});
