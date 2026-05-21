import { create } from 'zustand';
import type { InspectionIssue, TextInspectionOptions } from '../utils/textInspection';

export type {
  InspectionCategory,
  InspectionIssue,
  InspectionSeverity,
  TextInspectionOptions,
} from '../utils/textInspection';

export const DEFAULT_TEXT_INSPECTION_OPTIONS: TextInspectionOptions = {
  checks: {
    character_fragmentation: true,
    reading_order_anomaly: true,
    sentence_fragmentation: true,
    symbol_structure: true,
    isolated_block: true,
    duplicate_block: true,
    bbox_anomaly: true,
  } as TextInspectionOptions['checks'],
};

interface InspectionState {
  issuesByPage: Map<number, InspectionIssue[]>;
  activeIssueId: string | null;
  isInspecting: boolean;
  lastInspectedPageIndex: number | null;
  lastError: string | null;
  options: TextInspectionOptions;

  setIssuesForPage: (pageIndex: number, issues: InspectionIssue[]) => void;
  clearIssuesForPage: (pageIndex: number) => void;
  clearAllIssues: () => void;
  setActiveIssue: (issueId: string | null) => void;
  ignoreIssue: (pageIndex: number, issueId: string) => void;
  setInspecting: (isInspecting: boolean) => void;
  setLastError: (error: string | null) => void;
  setOptions: (options: Partial<TextInspectionOptions>) => void;
  resetInspection: () => void;
}

export const useInspectionStore = create<InspectionState>((set) => ({
  issuesByPage: new Map(),
  activeIssueId: null,
  isInspecting: false,
  lastInspectedPageIndex: null,
  lastError: null,
  options: DEFAULT_TEXT_INSPECTION_OPTIONS,

  setIssuesForPage: (pageIndex, issues) => set((state) => {
    const nextIssuesByPage = new Map(state.issuesByPage);
    nextIssuesByPage.set(pageIndex, issues);
    const activeIssueStillVisible = state.activeIssueId
      ? issues.some((issue) => issue.id === state.activeIssueId && !issue.ignored)
      : false;

    return {
      issuesByPage: nextIssuesByPage,
      activeIssueId: activeIssueStillVisible ? state.activeIssueId : null,
      lastInspectedPageIndex: pageIndex,
      lastError: null,
    };
  }),

  clearIssuesForPage: (pageIndex) => set((state) => {
    const issues = state.issuesByPage.get(pageIndex) ?? [];
    const nextIssuesByPage = new Map(state.issuesByPage);
    nextIssuesByPage.delete(pageIndex);
    const clearedActiveIssue = issues.some((issue) => issue.id === state.activeIssueId);

    return {
      issuesByPage: nextIssuesByPage,
      activeIssueId: clearedActiveIssue ? null : state.activeIssueId,
      lastInspectedPageIndex: state.lastInspectedPageIndex === pageIndex
        ? null
        : state.lastInspectedPageIndex,
    };
  }),

  clearAllIssues: () => set({
    issuesByPage: new Map(),
    activeIssueId: null,
    lastInspectedPageIndex: null,
    lastError: null,
  }),

  setActiveIssue: (issueId) => set({ activeIssueId: issueId }),

  ignoreIssue: (pageIndex, issueId) => set((state) => {
    const issues = state.issuesByPage.get(pageIndex);
    if (!issues) return state;

    const nextIssuesByPage = new Map(state.issuesByPage);
    nextIssuesByPage.set(
      pageIndex,
      issues.map((issue) => (
        issue.id === issueId ? { ...issue, ignored: true } : issue
      )),
    );

    return {
      issuesByPage: nextIssuesByPage,
      activeIssueId: state.activeIssueId === issueId ? null : state.activeIssueId,
    };
  }),

  setInspecting: (isInspecting) => set({ isInspecting }),
  setLastError: (error) => set({ lastError: error }),
  setOptions: (options) => set((state) => ({
    options: {
      ...state.options,
      ...options,
      checks: {
        ...state.options.checks,
        ...options.checks,
      },
    },
  })),
  resetInspection: () => set({
    issuesByPage: new Map(),
    activeIssueId: null,
    isInspecting: false,
    lastInspectedPageIndex: null,
    lastError: null,
    options: DEFAULT_TEXT_INSPECTION_OPTIONS,
  }),
}));

export const selectIssuesForPage = (pageIndex: number) => (state: InspectionState) =>
  state.issuesByPage.get(pageIndex) ?? [];

export const selectVisibleIssuesForPage = (pageIndex: number) => (state: InspectionState) =>
  (state.issuesByPage.get(pageIndex) ?? []).filter((issue) => !issue.ignored);

export function countInspectionIssues(issues: InspectionIssue[]) {
  return issues.reduce(
    (counts, issue) => ({
      error: counts.error + (issue.severity === 'error' ? 1 : 0),
      warning: counts.warning + (issue.severity === 'warning' ? 1 : 0),
      info: counts.info + (issue.severity === 'info' ? 1 : 0),
    }),
    { error: 0, warning: 0, info: 0 },
  );
}
