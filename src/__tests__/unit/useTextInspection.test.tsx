import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageData, PecoDocument, TextBlock } from '../../types';

const getAllTemporaryPageDataMock = vi.fn();
const getSharedPdfProxyMock = vi.fn();
const loadPageMock = vi.fn();
const loadPecoToolBBoxMetaMock = vi.fn();
const runTextInspectionMock = vi.fn();

vi.mock('../../utils/pdfLoader', () => ({
  getAllTemporaryPageData: (...args: unknown[]) => getAllTemporaryPageDataMock(...args),
  getSharedPdfProxy: (...args: unknown[]) => getSharedPdfProxyMock(...args),
  loadPage: (...args: unknown[]) => loadPageMock(...args),
  loadPecoToolBBoxMeta: (...args: unknown[]) => loadPecoToolBBoxMetaMock(...args),
}));

vi.mock('../../utils/textInspection', () => ({
  runTextInspection: (...args: unknown[]) => runTextInspectionMock(...args),
}));

import { useTextInspection } from '../../hooks/useTextInspection';
import { useInspectionStore, type InspectionIssue } from '../../store/inspectionStore';
import { usePecoStore } from '../../store/pecoStore';

function makeBlock(id: string, text: string, order: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: order * 20, y: 0, width: 18, height: 20 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  };
}

function makePage(pageIndex: number, text: string, isTextExtracted = true): PageData {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: [makeBlock(`b${pageIndex}`, text, 0)],
    isDirty: false,
    thumbnail: null,
    isTextExtracted,
  };
}

function makeIssue(pageIndex: number): InspectionIssue {
  return {
    id: `issue-${pageIndex}`,
    pageIndex,
    category: 'bbox_anomaly',
    severity: 'warning',
    title: 'BBサイズの確認が必要です',
    message: 'BBサイズが不自然です',
    blockIds: [`b${pageIndex}`],
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: `page-${pageIndex}`,
    ignored: false,
  };
}

beforeEach(() => {
  getAllTemporaryPageDataMock.mockReset();
  getSharedPdfProxyMock.mockReset();
  loadPageMock.mockReset();
  loadPecoToolBBoxMetaMock.mockReset();
  runTextInspectionMock.mockReset();
  useInspectionStore.getState().resetInspection();
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
  } as any);
});

describe('useTextInspection', () => {
  it('inspectAllPages は未ロードページと一時保存ページも含めて totalPages 全件を検査する', async () => {
    const loadedPage = makePage(0, 'loaded-page');
    const dirtyPage = makePage(2, 'dirty-page');
    const doc: PecoDocument = {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: 3,
      metadata: {},
      pages: new Map([[0, loadedPage]]),
    };

    usePecoStore.setState({ document: doc, currentPageIndex: 0 } as any);
    getAllTemporaryPageDataMock.mockResolvedValue(new Map([[2, dirtyPage]]));
    getSharedPdfProxyMock.mockResolvedValue({ id: 'pdf' });
    loadPecoToolBBoxMetaMock.mockResolvedValue({});
    loadPageMock.mockResolvedValue(makePage(1, 'pdf-page', false));
    runTextInspectionMock.mockImplementation(async (page: PageData) => ({
      pageIndex: page.pageIndex,
      issues: [makeIssue(page.pageIndex)],
    }));

    const { result } = renderHook(() => useTextInspection());
    let issues: InspectionIssue[] = [];

    await act(async () => {
      issues = await result.current.inspectAllPages();
    });

    expect(getAllTemporaryPageDataMock).toHaveBeenCalledWith('test.pdf');
    expect(loadPageMock).toHaveBeenCalledTimes(1);
    expect(loadPageMock.mock.calls[0][1]).toBe(1);
    expect(runTextInspectionMock).toHaveBeenCalledTimes(3);
    expect(runTextInspectionMock.mock.calls.map(([page]) => (page as PageData).pageIndex)).toEqual([0, 1, 2]);
    expect((runTextInspectionMock.mock.calls[1][0] as PageData).isTextExtracted).toBe(true);
    expect(issues.map(issue => issue.pageIndex)).toEqual([0, 1, 2]);
    expect(useInspectionStore.getState().issuesByPage.has(0)).toBe(true);
    expect(useInspectionStore.getState().issuesByPage.has(1)).toBe(true);
    expect(useInspectionStore.getState().issuesByPage.has(2)).toBe(true);
  });
});
