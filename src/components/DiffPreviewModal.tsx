import { X } from 'lucide-react';
import { Modal, useModalTitleId } from './ui/Modal';
import type { SaveDiffSummary } from '../utils/saveDiffSummary';

interface DiffPreviewModalProps {
  summary: SaveDiffSummary;
  onConfirm: () => void;
  onCancel: () => void;
}

function truncate(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function changeTypeLabel(type: 'modified' | 'added' | 'removed'): string {
  switch (type) {
    case 'modified': return '変更';
    case 'added':    return '追加';
    case 'removed':  return '削除';
  }
}

export function DiffPreviewModal({ summary, onConfirm, onCancel }: DiffPreviewModalProps) {
  const titleId = useModalTitleId();
  const { entries, changedPages } = summary;

  return (
    <Modal
      onClose={onCancel}
      titleId={titleId}
      backdropClassName="diff-preview-backdrop"
      dialogClassName="diff-preview-dialog"
    >
      <div className="diff-preview-header">
        <h3 id={titleId}>保存前の変更確認</h3>
        <button onClick={onCancel} className="close-btn" title="キャンセル" aria-label="閉じる">
          <X size={18} />
        </button>
      </div>

      <div className="diff-preview-summary">
        変更ページ数: <strong>{changedPages.length}</strong> ページ
        &nbsp;/&nbsp;
        変更ブロック数: <strong>{entries.length}</strong> 件
        {changedPages.length > 0 && (
          <span className="diff-preview-pages">
            {' '}（ページ {changedPages.map((p) => p + 1).join(', ')}）
          </span>
        )}
      </div>

      <div className="diff-preview-body">
        {entries.length === 0 ? (
          <p className="diff-preview-empty">変更はありません。</p>
        ) : (
          <table className="diff-preview-table">
            <thead>
              <tr>
                <th>ページ</th>
                <th>種別</th>
                <th>変更前</th>
                <th>変更後</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={`${entry.pageIndex}-${entry.blockId}-${i}`} data-change-type={entry.changeType}>
                  <td className="diff-page-col">{entry.pageIndex + 1}</td>
                  <td className="diff-type-col">{changeTypeLabel(entry.changeType)}</td>
                  <td className="diff-before-col">
                    <span className="diff-text diff-text-before">{truncate(entry.before)}</span>
                  </td>
                  <td className="diff-after-col">
                    <span className="diff-text diff-text-after">{truncate(entry.after)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="diff-preview-footer">
        <button onClick={onCancel} className="cancel-btn">
          キャンセル
        </button>
        <button onClick={onConfirm} className="confirm-btn" data-autofocus>
          保存する
        </button>
      </div>
    </Modal>
  );
}
