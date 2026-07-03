/**
 * Find & Replace ダイアログ (issue #93 + issue #98 + issue #198).
 *
 *  - Modal (#40) を通じて Esc/role/aria を委譲。
 *  - 2 タブ構成: 「単発置換」/ 「ルールセット」
 *  - 単発置換タブ: 検索 / 置換 / スコープ / 大小区別 / 正規表現 を UI で受け取り、
 *    useFindReplace で計算したプレビュー件数をリアルタイム表示。
 *  - issue #98: 件数の下に before/after プレビュー (最大 20 ブロック) を <mark> 風ハイライト付きで表示。
 *  - [置換実行] で onConfirm を呼び出し、結果を親 (App.tsx) で toast 表示する。
 *  - 全ページスコープでヒット数 > 50 の場合は ask() で確認 (親側責務)。
 *  - issue #198: ルールセットタブで辞書管理・一括適用。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { Modal, useModalTitleId } from './ui/Modal';
import {
  useFindReplace,
  buildRegexOrError,
  type ReplaceScope,
  type MatchPreviewItem,
} from '../hooks/useFindReplace';
import {
  loadRuleSet,
  saveRuleSet,
  createRule,
  exportRuleSetToJson,
  importRuleSetFromJson,
  type ProofreadingRule,
  type ProofreadingRuleSet,
} from '../utils/proofreadingRules';
import { usePecoStore } from '../store/pecoStore';

interface ReplaceDialogProps {
  onClose: () => void;
  /**
   * 「置換実行」ボタン押下時に呼ばれる。
   * 親 (App.tsx) は ask() / toast を出してから store.replaceText を呼ぶ。
   * skipBlockIds は contentEditable 編集中 BB の id 集合を渡すために予約 (未指定なら空 set)。
   */
  onConfirm: (params: {
    scope: ReplaceScope;
    pattern: string;
    replacement: string;
    caseSensitive: boolean;
    useRegex: boolean;
    expectedHits: number;
  }) => void;
  /** 「現在選択中の BB が無い」状態 (selection scope を disable する用) */
  hasSelection: boolean;
}

type TabId = 'single' | 'ruleset';

const SCOPE_LABELS: Record<ReplaceScope, string> = {
  selection: '選択BB',
  current: '現ページ',
  all: '全ページ',
};

export function ReplaceDialog({ onClose, onConfirm, hasSelection }: ReplaceDialogProps) {
  const titleId = useModalTitleId();
  const [activeTab, setActiveTab] = useState<TabId>('single');

  return (
    <Modal
      onClose={onClose}
      titleId={titleId}
      backdropClassName="modal-backdrop"
      dialogClassName="modal replace-dialog"
    >
      <div className="modal-header">
        <span id={titleId}>検索と置換</span>
        <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
          <X size={16} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="replace-dialog-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'single' ? 'true' : 'false'}
          aria-controls="replace-tab-single"
          className={`replace-dialog-tab${activeTab === 'single' ? ' active' : ''}`}
          onClick={() => setActiveTab('single')}
        >
          単発置換
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ruleset' ? 'true' : 'false'}
          aria-controls="replace-tab-ruleset"
          className={`replace-dialog-tab${activeTab === 'ruleset' ? ' active' : ''}`}
          onClick={() => setActiveTab('ruleset')}
        >
          ルールセット
        </button>
      </div>

      {activeTab === 'single' && (
        <SingleReplaceTab
          id="replace-tab-single"
          onClose={onClose}
          onConfirm={onConfirm}
          hasSelection={hasSelection}
        />
      )}
      {activeTab === 'ruleset' && (
        <RuleSetTab id="replace-tab-ruleset" />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Single Replace Tab (extracted from original ReplaceDialog body)
// ---------------------------------------------------------------------------
interface SingleReplaceTabProps {
  id: string;
  onClose: () => void;
  onConfirm: ReplaceDialogProps['onConfirm'];
  hasSelection: boolean;
}

function SingleReplaceTab({ id, onClose, onConfirm, hasSelection }: SingleReplaceTabProps) {
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scope, setScope] = useState<ReplaceScope>(hasSelection ? 'selection' : 'current');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);

  // hasSelection が false のとき selection スコープに留まれない: current にフォールバック。
  useEffect(() => {
    if (!hasSelection && scope === 'selection') setScope('current');
  }, [hasSelection, scope]);

  const query = useMemo(
    () => ({ pattern, caseSensitive, useRegex }),
    [pattern, caseSensitive, useRegex],
  );

  const { counts, preview, regexError, isSearching } = useFindReplace(query, scope, replacement, 20);

  const patternInputRef = useRef<HTMLInputElement>(null);

  // PCT-187: isSearching 中 (debounce 窓・scope='all' のみ 300ms) は counts.hits/regexError が
  // 直前の検索条件のまま (stale)。ここで無効化しないと、debounce 完了前に実行すると
  // stale な hits が expectedHits として渡り「50件超確認ダイアログ」をすり抜ける。
  // 未検証の regex も同様にすり抜けて catch なしの経路へ流れうる。
  const isExecuteDisabled =
    pattern.length === 0 || regexError !== null || counts.hits === 0 || isSearching;

  const handleConfirm = () => {
    if (isExecuteDisabled) return;
    onConfirm({
      scope,
      pattern,
      replacement,
      caseSensitive,
      useRegex,
      expectedHits: counts.hits,
    });
  };

  return (
    <div role="tabpanel" id={id}>
      <div className="modal-body">
        <div className="replace-dialog-row">
          <label htmlFor="replace-find-input">検索文字列</label>
          <input
            id="replace-find-input"
            ref={patternInputRef}
            data-autofocus
            type="text"
            className={regexError ? 'regex-input-error' : undefined}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isExecuteDisabled) {
                e.preventDefault();
                handleConfirm();
              }
            }}
            aria-invalid={regexError !== null ? 'true' : 'false'}
            aria-describedby={regexError ? 'replace-regex-error' : undefined}
          />
        </div>
        <div className="replace-dialog-row">
          <label htmlFor="replace-replacement-input">置換文字列</label>
          <input
            id="replace-replacement-input"
            type="text"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isExecuteDisabled) {
                e.preventDefault();
                handleConfirm();
              }
            }}
          />
        </div>

        <div
          className="replace-dialog-row replace-dialog-scope"
          role="radiogroup"
          aria-label="置換対象スコープ"
        >
          {(['selection', 'current', 'all'] as ReplaceScope[]).map((s) => (
            <label key={s} className="replace-dialog-radio">
              <input
                type="radio"
                name="replace-scope"
                value={s}
                checked={scope === s}
                disabled={s === 'selection' && !hasSelection}
                onChange={() => setScope(s)}
              />
              <span>{SCOPE_LABELS[s]}</span>
            </label>
          ))}
        </div>
        {/* issue #139: 選択BB スコープは現在表示中ページの選択のみを対象とする旨を明示 */}
        {scope === 'selection' && (
          <div className="replace-dialog-row replace-dialog-scope-hint">
            <small>※ 現在ページの選択BBのみ対象です（他ページの選択は対象外）。</small>
          </div>
        )}

        <div className="replace-dialog-row replace-dialog-options">
          <label>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            <span>大小区別</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(e) => setUseRegex(e.target.checked)}
            />
            <span>正規表現</span>
          </label>
        </div>

        {regexError && (
          <div
            id="replace-regex-error"
            className="replace-dialog-error"
            role="alert"
            style={{
              color: '#dc2626',
              fontSize: 12,
              marginTop: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <AlertCircle size={14} aria-hidden="true" />
            <span>
              <strong>正規表現エラー:</strong> {regexError}
            </span>
          </div>
        )}

        <div className="replace-dialog-preview" aria-live="polite">
          {pattern.length === 0 ? (
            <span>検索文字列を入力してください</span>
          ) : isSearching ? (
            <span className="replace-dialog-searching">検索中...</span>
          ) : (
            <span>
              {counts.hits} 件 / {counts.blocks} ブロック / {counts.pages} ページ
            </span>
          )}
        </div>

        {/* issue #98: before/after プレビュー一覧 */}
        {pattern.length > 0 && regexError === null && preview.items.length > 0 && (
          <MatchPreviewList
            items={preview.items}
            totalBlocks={preview.totalBlocks}
            truncated={preview.truncated}
          />
        )}
      </div>
      <div className="modal-footer replace-dialog-footer">
        <button type="button" className="cancel-btn" onClick={onClose}>
          キャンセル
        </button>
        <button
          type="button"
          className="confirm-btn"
          onClick={handleConfirm}
          disabled={isExecuteDisabled}
        >
          置換実行
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleSet Tab (issue #198)
// ---------------------------------------------------------------------------

interface ApplyProgress {
  total: number;
  done: number;
  results: Array<{ pattern: string; hits: number; blocks: number; pages: number; failed?: boolean }>;
}

function RuleSetTab({ id }: { id: string }) {
  const replaceTextBatch = usePecoStore((s) => s.replaceTextBatch);

  const [ruleSet, setRuleSet] = useState<ProofreadingRuleSet>(() => loadRuleSet());
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist whenever ruleSet changes
  useEffect(() => {
    saveRuleSet(ruleSet);
  }, [ruleSet]);

  const handleAddRule = useCallback(() => {
    setRuleSet((prev) => ({
      ...prev,
      rules: [...prev.rules, createRule()],
    }));
  }, []);

  const handleDeleteRule = useCallback((id: string) => {
    setRuleSet((prev) => ({
      ...prev,
      rules: prev.rules.filter((r) => r.id !== id),
    }));
  }, []);

  const handleRuleChange = useCallback(
    (id: string, field: keyof Omit<ProofreadingRule, 'id'>, value: unknown) => {
      setRuleSet((prev) => ({
        ...prev,
        rules: prev.rules.map((r) =>
          r.id === id ? { ...r, [field]: value } : r,
        ),
      }));
    },
    [],
  );

  const handleExport = useCallback(() => {
    const json = exportRuleSetToJson(ruleSet);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pecotool-ruleset.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [ruleSet]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text !== 'string') return;
        const result = importRuleSetFromJson(text);
        if ('error' in result) {
          setImportError(result.error);
        } else {
          setImportError(null);
          setRuleSet(result);
        }
      };
      reader.readAsText(file, 'utf-8');
      // reset so the same file can be re-imported
      e.target.value = '';
    },
    [],
  );

  const enabledRules = useMemo(
    () => ruleSet.rules.filter((r) => r.enabled && r.pattern.length > 0),
    [ruleSet.rules],
  );

  // isRegex=true のルールは単発置換タブと同じ buildRegexOrError で構文検証する。
  // (isRegex=false は常にエスケープ後の literal なので構文エラーは起こらない)
  // rule.id -> エラーメッセージ の Map。
  const ruleErrors = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of ruleSet.rules) {
      if (!r.isRegex || r.pattern.length === 0) continue;
      const result = buildRegexOrError({ pattern: r.pattern, caseSensitive: r.caseSensitive, useRegex: true });
      if ('error' in result && result.error) {
        map.set(r.id, result.error);
      }
    }
    return map;
  }, [ruleSet.rules]);

  const hasInvalidEnabledRule = useMemo(
    () => enabledRules.some((r) => ruleErrors.has(r.id)),
    [enabledRules, ruleErrors],
  );

  const handleBatchApply = useCallback(async () => {
    if (enabledRules.length === 0 || hasInvalidEnabledRule) return;
    setApplyError(null);
    setProgress({ total: enabledRules.length, done: 0, results: [] });

    try {
      // issue #213: replaceTextBatch で 1-pass 適用 (IDB 読み込み 1 回 / undoStack 1 entry)
      const { perRuleHits, invalidRuleIndices } = await replaceTextBatch(
        enabledRules.map((r) => ({
          pattern: r.pattern,
          replacement: r.replacement,
          isRegex: r.isRegex,
          caseSensitive: r.caseSensitive,
        })),
        'all',
      );

      const invalidSet = new Set(invalidRuleIndices);
      const results: ApplyProgress['results'] = enabledRules.map((rule, i) => ({
        pattern: rule.pattern,
        hits: perRuleHits[i] ?? 0,
        blocks: 0,
        pages: 0,
        failed: invalidSet.has(i),
      }));
      setProgress({ total: enabledRules.length, done: enabledRules.length, results });

      if (invalidRuleIndices.length > 0) {
        setApplyError(
          `${invalidRuleIndices.length} 件のルールが不正な正規表現のため適用をスキップしました。`,
        );
      }
    } catch (e) {
      // ストア層は不正な正規表現を throw しない設計だが、IDB エラー等の予期しない
      // 失敗で reject されても進捗表示がハングし続けないよう、必ずここで拾う。
      setProgress(null);
      setApplyError(e instanceof Error ? e.message : String(e));
    }
  }, [enabledRules, hasInvalidEnabledRule, replaceTextBatch]);

  const totalApplied = progress
    ? progress.results.reduce((sum, r) => sum + r.hits, 0)
    : 0;
  const failedCount = progress
    ? progress.results.filter((r) => r.failed).length
    : 0;

  return (
    <div role="tabpanel" id={id}>
      <div className="modal-body">
        {/* Toolbar */}
        <div className="ruleset-toolbar">
          <button type="button" className="ruleset-toolbar-btn" onClick={handleAddRule}>
            + ルール追加
          </button>
          <button
            type="button"
            className="ruleset-toolbar-btn primary"
            onClick={handleBatchApply}
            disabled={
              enabledRules.length === 0 ||
              hasInvalidEnabledRule ||
              (progress !== null && progress.done < progress.total)
            }
          >
            一括適用
            {enabledRules.length > 0 && ` (${enabledRules.length} 件)`}
          </button>
          <button type="button" className="ruleset-toolbar-btn" onClick={handleExport}>
            JSONエクスポート
          </button>
          <button type="button" className="ruleset-toolbar-btn" onClick={handleImportClick}>
            JSONインポート
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="ruleset-file-input-hidden"
            onChange={handleFileChange}
            aria-label="JSONファイルを選択"
          />
        </div>

        {importError && (
          <div className="ruleset-error" role="alert">
            <AlertCircle size={13} aria-hidden="true" className="ruleset-error-icon" />
            {importError}
          </div>
        )}

        {applyError && (
          <div className="ruleset-error" role="alert">
            <AlertCircle size={13} aria-hidden="true" className="ruleset-error-icon" />
            {applyError}
          </div>
        )}

        {/* Progress */}
        {progress !== null && (
          <div className="ruleset-progress" aria-live="polite">
            {progress.done < progress.total
              ? `適用中… ${progress.done} / ${progress.total} ルール`
              : failedCount > 0
                ? `完了: ${totalApplied} 件置換 (${progress.total} ルール中 ${failedCount} 件失敗)`
                : `完了: ${totalApplied} 件置換 (${progress.total} ルール適用)`}
          </div>
        )}

        {/* Rule table */}
        <div className="ruleset-table-wrapper">
          {ruleSet.rules.length === 0 ? (
            <div className="ruleset-empty">ルールがありません。「+ ルール追加」から追加してください。</div>
          ) : (
            <table className="ruleset-table" aria-label="置換ルール一覧">
              <thead>
                <tr>
                  <th className="ruleset-col-enabled">有効</th>
                  <th>検索パターン</th>
                  <th>置換後</th>
                  <th className="ruleset-col-regex">正規表現</th>
                  <th className="ruleset-col-case">大小区別</th>
                  <th>メモ</th>
                  <th className="ruleset-col-delete"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {ruleSet.rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    regexError={ruleErrors.get(rule.id) ?? null}
                    onChange={handleRuleChange}
                    onDelete={handleDeleteRule}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="ruleset-footer-hint">
          ルールは上から順番に適用されます。一括適用後は Ctrl+Z で 1 ルールずつ元に戻せます。
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleRow
// ---------------------------------------------------------------------------
interface RuleRowProps {
  rule: ProofreadingRule;
  /** issue #198: isRegex=true のパターンが構文エラーの場合のメッセージ (buildRegexOrError 由来) */
  regexError: string | null;
  onChange: (id: string, field: keyof Omit<ProofreadingRule, 'id'>, value: unknown) => void;
  onDelete: (id: string) => void;
}

function RuleRow({ rule, regexError, onChange, onDelete }: RuleRowProps) {
  const patternErrorId = regexError ? `ruleset-pattern-error-${rule.id}` : undefined;
  return (
    <tr>
      <td className="ruleset-td-center">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onChange(rule.id, 'enabled', e.target.checked)}
          aria-label={`ルール "${rule.pattern}" を有効化`}
        />
      </td>
      <td>
        <input
          type="text"
          className={regexError ? 'regex-input-error' : undefined}
          value={rule.pattern}
          onChange={(e) => onChange(rule.id, 'pattern', e.target.value)}
          placeholder="検索文字列"
          aria-label="検索パターン"
          aria-invalid={regexError !== null ? 'true' : 'false'}
          aria-describedby={patternErrorId}
        />
        {regexError && (
          <div id={patternErrorId} className="ruleset-row-error" role="alert">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{regexError}</span>
          </div>
        )}
      </td>
      <td>
        <input
          type="text"
          value={rule.replacement}
          onChange={(e) => onChange(rule.id, 'replacement', e.target.value)}
          placeholder="置換後の文字列"
          aria-label="置換文字列"
        />
      </td>
      <td className="ruleset-td-center">
        <input
          type="checkbox"
          checked={rule.isRegex}
          onChange={(e) => onChange(rule.id, 'isRegex', e.target.checked)}
          aria-label="正規表現として扱う"
        />
      </td>
      <td className="ruleset-td-center">
        <input
          type="checkbox"
          checked={rule.caseSensitive}
          onChange={(e) => onChange(rule.id, 'caseSensitive', e.target.checked)}
          aria-label="大文字・小文字を区別する"
        />
      </td>
      <td>
        <input
          type="text"
          value={rule.note ?? ''}
          onChange={(e) => onChange(rule.id, 'note', e.target.value || undefined)}
          placeholder="メモ (任意)"
          aria-label="メモ"
          className="ruleset-note-input"
        />
      </td>
      <td>
        <button
          type="button"
          className="ruleset-row-delete"
          onClick={() => onDelete(rule.id)}
          aria-label={`ルール "${rule.pattern}" を削除`}
          title="削除"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// MatchPreviewList / MatchPreviewRow / renderWithHighlights
// (unchanged from original issue #98 implementation)
// ---------------------------------------------------------------------------

/**
 * issue #98: ブロック単位の before/after プレビュー一覧。
 *
 *  - 上限 (default 20) を超えた場合 "N 件中 20 件表示中" を表示
 *  - max-height + overflow-y で 200px までスクロール (CSS 側で制御)
 *  - 表示テキストは React の通常レンダリングを使うため XSS は心配ない
 *    (dangerouslySetInnerHTML は使わない)
 */
interface MatchPreviewListProps {
  items: MatchPreviewItem[];
  totalBlocks: number;
  truncated: boolean;
}

function MatchPreviewList({ items, totalBlocks, truncated }: MatchPreviewListProps) {
  return (
    <div className="replace-preview-list-wrapper">
      <div className="replace-preview-caption">
        プレビュー (最初の {items.length} 件)
        {truncated && (
          <span className="replace-preview-truncated">
            ／{totalBlocks} 件中 {items.length} 件表示中
          </span>
        )}
      </div>
      <ul className="replace-preview-list" role="list">
        {items.map((it) => (
          <MatchPreviewRow key={`${it.pageIndex}:${it.blockId}`} item={it} />
        ))}
      </ul>
    </div>
  );
}

/**
 * 1 ブロック分の before/after 行 (issue #98).
 * マッチ箇所を <mark> でハイライト。テキストは React 経由で挿入するので escape 不要。
 */
function MatchPreviewRow({ item }: { item: MatchPreviewItem }) {
  const shortId = item.blockId.length > 6 ? item.blockId.slice(0, 6) : item.blockId;
  return (
    <li className="replace-preview-item">
      <div className="replace-preview-loc">
        p.{item.pageIndex + 1} #{shortId}
      </div>
      <div className="replace-preview-row">
        <span className="replace-preview-label">before</span>
        <span
          className={`replace-preview-text replace-preview-${item.writingMode}`}
        >
          {renderWithHighlights(item.before, item.beforeRanges)}
        </span>
      </div>
      <div className="replace-preview-row">
        <span className="replace-preview-label">after</span>
        <span
          className={`replace-preview-text replace-preview-${item.writingMode}`}
        >
          {renderWithHighlights(item.after, item.afterRanges)}
        </span>
      </div>
    </li>
  );
}

/**
 * テキストを ranges に基づいて [normal, <mark>matched</mark>, normal, ...] の
 * ReactNode 配列にする。
 *  - React が自動 escape するので dangerouslySetInnerHTML は使わない (XSS 安全)
 *  - 空配列の場合はそのままテキスト返す (defensive)
 */
function renderWithHighlights(
  text: string,
  ranges: Array<{ start: number; end: number }>,
) {
  if (ranges.length === 0) return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (cursor < r.start) {
      nodes.push(text.slice(cursor, r.start));
    }
    nodes.push(
      <mark key={i} className="replace-preview-mark">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    cursor = r.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
