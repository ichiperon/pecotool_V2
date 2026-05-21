import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_INSPECTION_OPTIONS,
  useInspectionStore,
  type InspectionIssue,
} from '../../store/inspectionStore';

function makeIssue(overrides: Partial<InspectionIssue> = {}): InspectionIssue {
  return {
    id: 'issue-1',
    pageIndex: 0,
    category: 'character_fragmentation',
    severity: 'warning',
    title: '文字が分断されています',
    message: '1文字単位の BB が連続しています',
    blockIds: ['b1', 'b2'],
    bbox: { x: 0, y: 0, width: 20, height: 20 },
    text: '検査',
    ignored: false,
    ...overrides,
  };
}

beforeEach(() => {
  useInspectionStore.getState().resetInspection();
});

describe('inspectionStore', () => {
  it('初期状態は空の検査結果と既定オプションを持つ', () => {
    const state = useInspectionStore.getState();

    expect(state.issuesByPage.size).toBe(0);
    expect(state.activeIssueId).toBeNull();
    expect(state.isInspecting).toBe(false);
    expect(state.lastInspectedPageIndex).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.options).toEqual(DEFAULT_TEXT_INSPECTION_OPTIONS);
    expect(state.options.checks).toEqual({
      character_fragmentation: true,
      reading_order_anomaly: true,
      sentence_fragmentation: true,
      symbol_structure: true,
      isolated_block: true,
      duplicate_block: true,
      bbox_anomaly: true,
    });
  });

  it('setIssuesForPage はページ別結果を保存して検査済みページを更新する', () => {
    const issue = makeIssue();
    useInspectionStore.getState().setLastError('old error');

    useInspectionStore.getState().setIssuesForPage(0, [issue]);

    const state = useInspectionStore.getState();
    expect(state.issuesByPage.get(0)).toEqual([issue]);
    expect(state.lastInspectedPageIndex).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('ignoreIssue は結果を ignored にし、アクティブなら解除する', () => {
    const issue = makeIssue();
    useInspectionStore.getState().setIssuesForPage(0, [issue]);
    useInspectionStore.getState().setActiveIssue(issue.id);

    useInspectionStore.getState().ignoreIssue(0, issue.id);

    const state = useInspectionStore.getState();
    expect(state.issuesByPage.get(0)?.[0].ignored).toBe(true);
    expect(state.activeIssueId).toBeNull();
  });

  it('clearIssuesForPage は対象ページだけを削除する', () => {
    const page0Issue = makeIssue({ id: 'page-0', pageIndex: 0 });
    const page1Issue = makeIssue({ id: 'page-1', pageIndex: 1 });
    useInspectionStore.getState().setIssuesForPage(0, [page0Issue]);
    useInspectionStore.getState().setIssuesForPage(1, [page1Issue]);
    useInspectionStore.getState().setActiveIssue(page0Issue.id);

    useInspectionStore.getState().clearIssuesForPage(0);

    const state = useInspectionStore.getState();
    expect(state.issuesByPage.has(0)).toBe(false);
    expect(state.issuesByPage.get(1)).toEqual([page1Issue]);
    expect(state.activeIssueId).toBeNull();
  });

  it('setOptions は指定された検査オプションだけを更新する', () => {
    useInspectionStore.getState().setOptions({
      checks: { reading_order_anomaly: false } as unknown as typeof DEFAULT_TEXT_INSPECTION_OPTIONS.checks,
    });

    expect(useInspectionStore.getState().options).toEqual({
      ...DEFAULT_TEXT_INSPECTION_OPTIONS,
      checks: {
        ...DEFAULT_TEXT_INSPECTION_OPTIONS.checks,
        reading_order_anomaly: false,
      },
    });
  });
});
