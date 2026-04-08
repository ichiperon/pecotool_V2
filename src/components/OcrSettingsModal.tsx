import React from 'react';
import {
  useOcrSettingsStore,
  RowOrder, ColumnOrder,
  ROW_ORDER_LABELS, COLUMN_ORDER_LABELS,
} from '../store/ocrSettingsStore';

const ROW_OPTIONS: RowOrder[] = ['top-to-bottom', 'bottom-to-top'];
const COL_OPTIONS: ColumnOrder[] = ['left-to-right', 'right-to-left'];

interface OcrSettingsModalProps {
  onClose: () => void;
}

export const OcrSettingsModal: React.FC<OcrSettingsModalProps> = ({ onClose }) => {
  const {
    horizontal, vertical, groupTolerance,
    setHorizontalRowOrder, setHorizontalColumnOrder,
    setVerticalColumnOrder, setVerticalRowOrder,
    setGroupTolerance,
  } = useOcrSettingsStore();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          OCR 序列設定
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* 横書き設定 */}
          <div className="modal-section-title" style={{ marginBottom: 8 }}>横書き</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <tbody>
              <tr>
                <td style={{ paddingBottom: 8, paddingRight: 16, whiteSpace: 'nowrap', width: 100 }}>行の順序</td>
                <td style={{ paddingBottom: 8 }}>
                  <select
                    value={horizontal.rowOrder}
                    onChange={(e) => setHorizontalRowOrder(e.target.value as RowOrder)}
                    style={{ width: '100%' }}
                  >
                    {ROW_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{ROW_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr>
                <td style={{ paddingRight: 16, whiteSpace: 'nowrap' }}>行内の列順序</td>
                <td>
                  <select
                    value={horizontal.columnOrder}
                    onChange={(e) => setHorizontalColumnOrder(e.target.value as ColumnOrder)}
                    style={{ width: '100%' }}
                  >
                    {COL_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{COLUMN_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>

          {/* 縦書き設定 */}
          <div className="modal-section-title" style={{ marginBottom: 8 }}>縦書き</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <tbody>
              <tr>
                <td style={{ paddingBottom: 8, paddingRight: 16, whiteSpace: 'nowrap', width: 100 }}>列の順序</td>
                <td style={{ paddingBottom: 8 }}>
                  <select
                    value={vertical.columnOrder}
                    onChange={(e) => setVerticalColumnOrder(e.target.value as ColumnOrder)}
                    style={{ width: '100%' }}
                  >
                    {COL_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{COLUMN_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr>
                <td style={{ paddingRight: 16, whiteSpace: 'nowrap' }}>列内の行順序</td>
                <td>
                  <select
                    value={vertical.rowOrder}
                    onChange={(e) => setVerticalRowOrder(e.target.value as RowOrder)}
                    style={{ width: '100%' }}
                  >
                    {ROW_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{ROW_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>

          {/* グループ閾値 */}
          <div className="modal-section-title" style={{ marginBottom: 8 }}>グループ閾値</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <input
              type="number"
              min={0}
              max={200}
              value={groupTolerance}
              onChange={(e) => setGroupTolerance(Math.max(0, parseInt(e.target.value, 10) || 0))}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12, opacity: 0.7 }}>px — 同じ行／列とみなす許容幅</span>
          </div>

          <div style={{ marginTop: 16, padding: '8px 12px', background: 'rgba(128,128,128,0.1)', borderRadius: 4, fontSize: 11, opacity: 0.7 }}>
            設定はOCR実行時に適用されます。<br />
            縦横混在ページは縦書き→横書きの順で結合されます。
          </div>
        </div>
      </div>
    </div>
  );
};
