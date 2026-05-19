/**
 * Find & Replace ダイアログ (issue #93).
 *
 *  - Modal (#40) を通じて Esc/role/aria を委譲。
 *  - 検索 / 置換 / スコープ / 大小区別 / 正規表現 を UI で受け取り、
 *    useFindReplace で計算したプレビュー件数をリアルタイム表示。
 *  - [置換実行] で onConfirm を呼び出し、結果を親 (App.tsx) で toast 表示する。
 *  - 全ページスコープでヒット数 > 50 の場合は ask() で確認 (親側責務)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Modal, useModalTitleId } from './ui/Modal';
import { useFindReplace, type ReplaceScope } from '../hooks/useFindReplace';

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

  const { counts, regexError } = useFindReplace(query, scope);

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
