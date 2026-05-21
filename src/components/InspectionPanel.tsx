import { useMemo, useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import {
  countInspectionIssues,
  useInspectionStore,
  type InspectionIssue,
  type InspectionSeverity,
} from '../store/inspectionStore';

interface InspectionPanelProps {
  width?: number;
  embedded?: boolean;
  onRunInspection?: () => void | Promise<void>;
  onIssueFocus?: (issue: InspectionIssue) => void;
}

const CATEGORY_LABELS = {
  character_fragmentation: '文字分断',
  reading_order_anomaly: '読み順構造',
  sentence_fragmentation: '結合候補',
  symbol_structure: '記号構造',
  isolated_block: '孤立ブロック',
  duplicate_block: '重複ブロック',
  bbox_anomaly: 'BB構造',
} as const;

type InspectionCategoryFilter = keyof typeof CATEGORY_LABELS;

const INSPECTION_CATEGORIES: InspectionCategoryFilter[] = [
  'character_fragmentation',
  'reading_order_anomaly',
  'sentence_fragmentation',
  'symbol_structure',
  'isolated_block',
  'duplicate_block',
  'bbox_anomaly',
];

const SEVERITY_LABELS: Record<InspectionSeverity, string> = {
  error: 'エラー',
  warning: '警告',
  info: '確認',
};

function formatBlockRefs(blockIds: string[], blockNumberById: Map<string, number>) {
  return blockIds
    .map((id) => {
      const blockNumber = blockNumberById.get(id);
      return blockNumber ? `#${blockNumber}` : id;
    })
    .join(', ');
}

function getCategoryLabel(category: string) {
  return CATEGORY_LABELS[category as InspectionCategoryFilter] ?? category;
}

export function InspectionPanel({ width, embedded = false, onRunInspection, onIssueFocus }: InspectionPanelProps) {
  const [selectedCategory, setSelectedCategory] = useState<InspectionCategoryFilter | 'all'>('all');
  const pecoDocument = usePecoStore((state) => state.document);
  const currentPageIndex = usePecoStore((state) => state.currentPageIndex);
  const setSelectedIds = usePecoStore((state) => state.setSelectedIds);
  const issuesByPage = useInspectionStore((state) => state.issuesByPage);
  const activeIssueId = useInspectionStore((state) => state.activeIssueId);
  const isInspecting = useInspectionStore((state) => state.isInspecting);
  const lastError = useInspectionStore((state) => state.lastError);
  const setActiveIssue = useInspectionStore((state) => state.setActiveIssue);
  const ignoreIssue = useInspectionStore((state) => state.ignoreIssue);
  const currentPage = pecoDocument?.pages.get(currentPageIndex) ?? null;
  const hasCurrentPageInspection = issuesByPage.has(currentPageIndex);
  const visibleIssues = (issuesByPage.get(currentPageIndex) ?? []).filter((issue) => !issue.ignored);
  const categoryCounts = useMemo(() => visibleIssues.reduce<Record<string, number>>((nextCounts, issue) => {
    nextCounts[issue.category] = (nextCounts[issue.category] ?? 0) + 1;
    return nextCounts;
  }, {}), [visibleIssues]);
  const filteredIssues = selectedCategory === 'all'
    ? visibleIssues
    : visibleIssues.filter((issue) => issue.category === selectedCategory);
  const counts = countInspectionIssues(visibleIssues);
  const blockNumberById = useMemo(() => new Map(
    currentPage?.textBlocks.map((block) => [block.id, block.order + 1]) ?? [],
  ), [currentPage]);
  const panelStyle = width ? { width: `${width}px` } : undefined;
  const canRunInspection = !!currentPage
    && (currentPage.isTextExtracted === true || currentPage.ocrCleared === true)
    && !isInspecting;

  const focusIssue = (issue: InspectionIssue) => {
    setActiveIssue(issue.id);
    setSelectedIds(issue.blockIds);
    onIssueFocus?.(issue);
  };

  const handleIssueKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, issue: InspectionIssue) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    focusIssue(issue);
  };

  const renderBody = () => {
    if (!pecoDocument) return <div className="placeholder">データなし</div>;
    if (!currentPage) return <div className="placeholder">読み込み中...</div>;
    if (currentPage.isTextExtracted !== true && currentPage.ocrCleared !== true) {
      return <div className="placeholder">テキスト抽出後に検査できます</div>;
    }
    if (isInspecting) {
      return (
        <div className="ocr-loading-placeholder">
          <div className="loading-spinner" />
          <div className="loading-message">検査中...</div>
        </div>
      );
    }
    if (!hasCurrentPageInspection) {
      return <div className="placeholder">検査を実行してください</div>;
    }
    if (currentPage.textBlocks.length === 0) {
      return <div className="placeholder placeholder--no-ocr">検査対象の OCR テキストがありません</div>;
    }
    if (visibleIssues.length === 0) {
      return <div className="placeholder">検査結果なし</div>;
    }

    return (
      <>
        <div className="inspection-category-filters" aria-label="検査カテゴリ">
          <button
            type="button"
            className={`inspection-filter-button ${selectedCategory === 'all' ? 'active' : ''}`}
            aria-pressed={selectedCategory === 'all'}
            onClick={() => setSelectedCategory('all')}
          >
            すべて {visibleIssues.length}
          </button>
          {INSPECTION_CATEGORIES.map((category) => {
            const count = categoryCounts[category] ?? 0;
            return (
              <button
                key={category}
                type="button"
                className={`inspection-filter-button ${selectedCategory === category ? 'active' : ''}`}
                aria-pressed={selectedCategory === category}
                disabled={count === 0}
                onClick={() => setSelectedCategory(category)}
              >
                {CATEGORY_LABELS[category]} {count}
              </button>
            );
          })}
        </div>
        {filteredIssues.length === 0 ? (
          <div className="placeholder">該当する検査結果なし</div>
        ) : (
          <div className="inspection-issue-list">
            {filteredIssues.map((issue) => (
              <div
                key={issue.id}
                role="button"
                tabIndex={0}
                className={`inspection-issue ${issue.id === activeIssueId ? 'active' : ''}`}
                data-category={issue.category}
                data-severity={issue.severity}
                onClick={() => focusIssue(issue)}
                onKeyDown={(event) => handleIssueKeyDown(event, issue)}
              >
                <div className="inspection-issue-header">
                  <span className="inspection-category">{getCategoryLabel(issue.category)}</span>
                  <span className="inspection-severity">{SEVERITY_LABELS[issue.severity]}</span>
                </div>
                <div className="inspection-issue-title">{issue.title}</div>
                <div className="inspection-issue-text">{issue.text}</div>
                <div className="inspection-issue-message">{issue.message}</div>
                {issue.suggestion && (
                  <div className="inspection-issue-suggestion">{issue.suggestion}</div>
                )}
                <div className="inspection-issue-footer">
                  <span className="inspection-block-refs">
                    {formatBlockRefs(issue.blockIds, blockNumberById)}
                  </span>
                  <div className="inspection-issue-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        ignoreIssue(issue.pageIndex, issue.id);
                      }}
                    >
                      確認済み
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  const body = (
    <div className="scroll-content">
      {lastError && <div className="inspection-error">{lastError}</div>}
      {renderBody()}
    </div>
  );

  if (embedded) return body;

  return (
    <aside className="editor-panel inspection-panel" style={panelStyle}>
      <div className="panel-header">
        <span>検査結果</span>
        <div className="inspection-count-badges" aria-label="検査件数">
          <span className="inspection-count-badge error">エラー {counts.error}</span>
          <span className="inspection-count-badge warning">警告 {counts.warning}</span>
          <span className="inspection-count-badge info">確認 {counts.info}</span>
        </div>
        {onRunInspection && (
          <button
            type="button"
            disabled={!canRunInspection}
            onClick={() => void onRunInspection()}
          >
            検査
          </button>
        )}
      </div>
      {body}
    </aside>
  );
}
