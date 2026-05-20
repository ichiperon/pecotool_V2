import { useCallback, useRef } from 'react';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
import {
  useInspectionStore,
  type InspectionIssue,
  type TextInspectionOptions,
} from '../store/inspectionStore';
import {
  getAllTemporaryPageData,
  getSharedPdfProxy,
  loadPage,
  loadPecoToolBBoxMeta,
} from '../utils/pdfLoader';
import { runTextInspection } from '../utils/textInspection';
import type { PageData, PecoDocument } from '../types';

export type TextInspectionScope = 'current' | 'all';

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function canInspectPage(page: Pick<PageData, 'isTextExtracted' | 'ocrCleared' | 'textBlocks'> | null | undefined) {
  return !!page
    && (
      page.isTextExtracted === true
      || page.ocrCleared === true
      || page.textBlocks.length > 0
    );
}

function toTemporaryPageData(pageIndex: number, data: Partial<PageData> | undefined): PageData | null {
  if (
    !data
    || typeof data.width !== 'number'
    || typeof data.height !== 'number'
    || !Array.isArray(data.textBlocks)
  ) {
    return null;
  }

  return {
    pageIndex,
    width: data.width,
    height: data.height,
    textBlocks: data.textBlocks,
    isDirty: data.isDirty ?? true,
    thumbnail: data.thumbnail ?? null,
    isTextExtracted: data.isTextExtracted ?? (data.textBlocks.length > 0 ? true : undefined),
    ocrCleared: data.ocrCleared,
  };
}

function toExtractedPageData(page: PageData): PageData {
  return page.isTextExtracted === true || page.ocrCleared === true
    ? page
    : { ...page, isTextExtracted: true };
}

function mergePageData(base: PageData, override: Partial<PageData> | undefined, pageIndex: number): PageData {
  if (!override) return base;
  return {
    ...base,
    ...override,
    pageIndex,
    width: override.width ?? base.width,
    height: override.height ?? base.height,
    textBlocks: override.textBlocks ?? base.textBlocks,
    thumbnail: override.thumbnail ?? base.thumbnail,
  };
}

async function loadInspectablePage(
  doc: PecoDocument,
  pageIndex: number,
  dirtyPages: Map<number, Partial<PageData>>,
  pdf: Awaited<ReturnType<typeof getSharedPdfProxy>>,
  bboxMeta: Awaited<ReturnType<typeof loadPecoToolBBoxMeta>> | null,
): Promise<PageData> {
  const inMemoryPage = usePecoStore.getState().document?.pages.get(pageIndex);
  const dirtyPage = dirtyPages.get(pageIndex);
  const dirtyPageData = toTemporaryPageData(pageIndex, dirtyPage);

  if (inMemoryPage && canInspectPage(inMemoryPage)) {
    return toExtractedPageData(mergePageData(inMemoryPage, dirtyPage, pageIndex));
  }

  if (dirtyPageData && canInspectPage(dirtyPageData)) {
    return toExtractedPageData(dirtyPageData);
  }

  const loadedPage = await loadPage(pdf, pageIndex, doc.filePath, bboxMeta, doc.mtime);
  return toExtractedPageData(mergePageData(loadedPage, dirtyPage, pageIndex));
}

function mergeInspectionOptions(
  options: TextInspectionOptions,
  overrideOptions: Partial<TextInspectionOptions>,
) {
  return {
    ...options,
    ...overrideOptions,
    checks: {
      ...options.checks,
      ...overrideOptions.checks,
    },
  };
}

export function useTextInspection() {
  const document = usePecoStore((state) => state.document);
  const currentPageIndex = usePecoStore((state) => state.currentPageIndex);
  const setSelectedIds = usePecoStore((state) => state.setSelectedIds);
  const issuesByPage = useInspectionStore((state) => state.issuesByPage);
  const activeIssueId = useInspectionStore((state) => state.activeIssueId);
  const isInspecting = useInspectionStore((state) => state.isInspecting);
  const lastInspectedPageIndex = useInspectionStore((state) => state.lastInspectedPageIndex);
  const lastError = useInspectionStore((state) => state.lastError);
  const options = useInspectionStore((state) => state.options);
  const setIssuesForPage = useInspectionStore((state) => state.setIssuesForPage);
  const setInspecting = useInspectionStore((state) => state.setInspecting);
  const setLastError = useInspectionStore((state) => state.setLastError);
  const setActiveIssue = useInspectionStore((state) => state.setActiveIssue);
  const ignoreIssueInStore = useInspectionStore((state) => state.ignoreIssue);
  const clearAllIssues = useInspectionStore((state) => state.clearAllIssues);
  const runIdRef = useRef(0);

  const currentPage = document?.pages.get(currentPageIndex) ?? null;
  const currentPageIssues = (issuesByPage.get(currentPageIndex) ?? []).filter((issue) => !issue.ignored);
  const canInspectCurrentPage = canInspectPage(currentPage) && !isInspecting;
  const canInspectAllPages = !!document && document.totalPages > 0 && !isInspecting;

  const inspectCurrentPage = useCallback(async (
    overrideOptions: Partial<TextInspectionOptions> = {},
  ): Promise<InspectionIssue[]> => {
    const pecoState = usePecoStore.getState();
    const inspectionState = useInspectionStore.getState();

    if (inspectionState.isInspecting) return [];

    const doc = pecoState.document;
    const pageIndex = pecoState.currentPageIndex;

    if (!doc) {
      setLastError('PDFを開いてから検査できます');
      return [];
    }

    const page = doc.pages.get(pageIndex);
    if (!page) {
      setLastError('ページ読み込み後に検査できます');
      return [];
    }

    if (!canInspectPage(page)) {
      setLastError('テキスト抽出後に検査できます');
      return [];
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setInspecting(true);
    setLastError(null);
    clearAllIssues();

    try {
      const mergedOptions = mergeInspectionOptions(inspectionState.options, overrideOptions);
      const inspectablePage = toExtractedPageData(page);
      const result = inspectablePage.textBlocks.length === 0
        ? { pageIndex, issues: [] }
        : await runTextInspection(inspectablePage, mergedOptions);
      const latestPecoState = usePecoStore.getState();
      const isCurrentRun = runIdRef.current === runId;
      const isSameDocument = latestPecoState.document?.filePath === doc.filePath;
      const isSamePage = latestPecoState.currentPageIndex === pageIndex;

      if (!isCurrentRun || !isSameDocument || !isSamePage) return [];

      setIssuesForPage(pageIndex, result.issues);
      return result.issues;
    } catch (error) {
      if (runIdRef.current === runId) {
        setLastError(toErrorMessage(error));
      }
      return [];
    } finally {
      if (runIdRef.current === runId) {
        setInspecting(false);
      }
    }
  }, [clearAllIssues, setInspecting, setIssuesForPage, setLastError]);

  const inspectAllPages = useCallback(async (
    overrideOptions: Partial<TextInspectionOptions> = {},
  ): Promise<InspectionIssue[]> => {
    const pecoState = usePecoStore.getState();
    const inspectionState = useInspectionStore.getState();

    if (inspectionState.isInspecting) return [];

    const doc = pecoState.document;
    if (!doc) {
      setLastError('PDFを開いてから検査できます');
      return [];
    }

    if (doc.totalPages <= 0) {
      setLastError('検査できるページがありません');
      return [];
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setInspecting(true);
    setLastError(null);
    clearAllIssues();

    const allIssues: InspectionIssue[] = [];

    try {
      const mergedOptions = mergeInspectionOptions(inspectionState.options, overrideOptions);
      await waitForPendingIdbSaves();
      const dirtyPages = await getAllTemporaryPageData(doc.filePath);
      const pdf = await getSharedPdfProxy(doc.filePath);
      const bboxMeta = await loadPecoToolBBoxMeta(pdf).catch(() => null);

      for (let pageIndex = 0; pageIndex < doc.totalPages; pageIndex++) {
        const latestBeforeRun = usePecoStore.getState();
        const isCurrentRunBeforeRun = runIdRef.current === runId;
        const isSameDocumentBeforeRun = latestBeforeRun.document?.filePath === doc.filePath;

        if (!isCurrentRunBeforeRun || !isSameDocumentBeforeRun) return [];

        const page = await loadInspectablePage(doc, pageIndex, dirtyPages, pdf, bboxMeta);
        const result = await runTextInspection(page, mergedOptions);
        const latestAfterRun = usePecoStore.getState();
        const isCurrentRunAfterRun = runIdRef.current === runId;
        const isSameDocumentAfterRun = latestAfterRun.document?.filePath === doc.filePath;

        if (!isCurrentRunAfterRun || !isSameDocumentAfterRun) return [];

        if (result.skippedReason === 'text_not_extracted') continue;

        setIssuesForPage(result.pageIndex, result.issues);
        allIssues.push(...result.issues);
      }

      return allIssues;
    } catch (error) {
      if (runIdRef.current === runId) {
        setLastError(toErrorMessage(error));
      }
      return [];
    } finally {
      if (runIdRef.current === runId) {
        setInspecting(false);
      }
    }
  }, [clearAllIssues, setInspecting, setIssuesForPage, setLastError]);

  const inspectPages = useCallback((
    scope: TextInspectionScope = 'current',
    overrideOptions: Partial<TextInspectionOptions> = {},
  ): Promise<InspectionIssue[]> => (
    scope === 'all'
      ? inspectAllPages(overrideOptions)
      : inspectCurrentPage(overrideOptions)
  ), [inspectAllPages, inspectCurrentPage]);

  const focusIssue = useCallback((issue: InspectionIssue) => {
    setActiveIssue(issue.id);
    setSelectedIds(issue.blockIds);
  }, [setActiveIssue, setSelectedIds]);

  const ignoreIssue = useCallback((issue: InspectionIssue) => {
    ignoreIssueInStore(issue.pageIndex, issue.id);
  }, [ignoreIssueInStore]);

  return {
    activeIssueId,
    canInspectAllPages,
    canInspectCurrentPage,
    currentPage,
    currentPageIndex,
    currentPageIssues,
    focusIssue,
    ignoreIssue,
    inspectAllPages,
    inspectCurrentPage,
    inspectPages,
    isInspecting,
    lastError,
    lastInspectedPageIndex,
    options,
  };
}
