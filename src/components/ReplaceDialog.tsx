/**
 * Find & Replace ダイアログ (issue #93 + issue #98).
 *
 *  - Modal (#40) を通じて Esc/role/aria を委譲。
 *  - 検索 / 置換 / スコープ / 大小区別 / 正規表現 を UI で受け取り、
 *    useFindReplace で計算したプレビュー件数をリアルタイム表示。
 *  - issue #98: 件数の下に before/after プレビュー (最大 20 ブロック) を <mark> 風ハイライト付きで表示。
 *  - [置換実行] で onConfirm を呼び出し、結果を親 (App.tsx) で toast 表示する。
 *  - 全ページスコープでヒット数 > 50 の場合は ask() で確認 (親側責務)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Modal, useModalTitleId } from './ui/Modal';
import {
  useFindReplace,
  type ReplaceScope,
  type MatchPreviewItem,
} from '../hooks/useFindReplace';

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

const SCOPE_LABELS: Record<ReplaceScope, string> = {
  selection: '選択BB',
  current: '現ページ',
  all: '全ページ',
};

export function ReplaceDialog({ onClose, onConfirm, hasSelection }: ReplaceDialogProps) {
  const titleId = useModalTitleId();
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

  const { counts, preview, regexError } = useFindReplace(query, scope, replacement, 20);

  // pattern を変更したら検索 input に focus が残るようにする
  const patternInputRef = useRef<HTMLInputElement>(null);

  const isExecuteDisabled =
    pattern.length === 0 || regexError !== null || counts.hits === 0;

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
    <Modal
      onClose={onClose}
      titleId={titleId}
      backdropClassName="modal-backdrop"
      dialogClassName="modal replace-dialog"
    >
      <div className="modal-header">
        <span id={titleId}>検索と置換</span>
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          <X size={16} />
        </button>
      </div>
      <div className="modal-body">
        <div className="replace-dialog-row">
          <label htmlFor="replace-find-input">検索文字列</label>
          <input
            id="replace-find-input"
            ref={patternInputRef}
            data-autofocus
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isExecuteDisabled) {
                e.preventDefault();
                handleConfirm();
              }
            }}
            aria-invalid={regexError !== null}
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
            style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}
          >
            正規表現エラー: {regexError}
          </div>
        )}

        <div className="replace-dialog-preview" aria-live="polite">
          {pattern.length === 0 ? (
            <span>検索文字列を入力してください</span>
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
        <button className="cancel-btn" onClick={onClose}>
          キャンセル
        </button>
        <button
          className="confirm-btn"
          onClick={handleConfirm}
          disabled={isExecuteDisabled}
        >
          置換実行
        </button>
      </div>
    </Modal>
  );
}

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
