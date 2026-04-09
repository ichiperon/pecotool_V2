import React, { useState } from 'react';
import {
  useOcrSettingsStore,
  RowOrder, ColumnOrder, MixedOrder,
  ROW_ORDER_LABELS, COLUMN_ORDER_LABELS, MIXED_ORDER_LABELS,
} from '../store/ocrSettingsStore';

const ROW_OPTIONS: RowOrder[] = ['top-to-bottom', 'bottom-to-top'];
const COL_OPTIONS: ColumnOrder[] = ['left-to-right', 'right-to-left'];
const MIXED_OPTIONS: MixedOrder[] = ['vertical-first', 'horizontal-first'];

interface OcrSettingsModalProps {
  onClose: () => void;
}

export const OcrSettingsModal: React.FC<OcrSettingsModalProps> = ({ onClose }) => {
  const {
    horizontal, vertical, groupTolerance, mixedOrder,
    setHorizontalRowOrder, setHorizontalColumnOrder,
    setVerticalColumnOrder, setVerticalRowOrder,
    setGroupTolerance, setMixedOrder,
  } = useOcrSettingsStore();

  const [toleranceInput, setToleranceInput] = useState(String(groupTolerance));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ocr-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          OCR 序列設定
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* 横書き設定 */}
          <div className="modal-section-title ocr-settings-section-title">横書き</div>
          <table className="ocr-settings-table">
            <tbody>
              <tr>
                <td className="label pb">行の順序</td>
                <td className="value pb">
                  <select
                    aria-label="横書き：行の順序"
                    value={horizontal.rowOrder}
                    onChange={(e) => setHorizontalRowOrder(e.target.value as RowOrder)}
                  >
                    {ROW_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{ROW_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr>
                <td className="label">行内の列順序</td>
                <td className="value">
                  <select
                    aria-label="横書き：行内の列順序"
                    value={horizontal.columnOrder}
                    onChange={(e) => setHorizontalColumnOrder(e.target.value as ColumnOrder)}
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
          <div className="modal-section-title ocr-settings-section-title">縦書き</div>
          <table className="ocr-settings-table">
            <tbody>
              <tr>
                <td className="label pb">列の順序</td>
                <td className="value pb">
                  <select
                    aria-label="縦書き：列の順序"
                    value={vertical.columnOrder}
                    onChange={(e) => setVerticalColumnOrder(e.target.value as ColumnOrder)}
                  >
                    {COL_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{COLUMN_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr>
                <td className="label">列内の行順序</td>
                <td className="value">
                  <select
                    aria-label="縦書き：列内の行順序"
                    value={vertical.rowOrder}
                    onChange={(e) => setVerticalRowOrder(e.target.value as RowOrder)}
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
          <div className="modal-section-title ocr-settings-section-title">グループ閾値</div>
          <div className="ocr-settings-tolerance-row">
            <input
              type="number"
              min={0}
              max={200}
              aria-label="グループ閾値（px）"
              value={toleranceInput}
              onChange={(e) => setToleranceInput(e.target.value)}
              onBlur={() => {
                const parsed = parseInt(toleranceInput, 10);
                const val = isNaN(parsed) ? groupTolerance : Math.max(0, parsed);
                setGroupTolerance(val);
                setToleranceInput(String(val));
              }}
            />
            <span className="ocr-settings-tolerance-hint">px — 同じ行／列とみなす許容幅</span>
          </div>

          {/* 縦横混在時の結合順 */}
          <div className="modal-section-title ocr-settings-section-title">縦横混在時の結合順</div>
          <table className="ocr-settings-table">
            <tbody>
              <tr>
                <td className="label">結合順序</td>
                <td className="value">
                  <select
                    aria-label="縦横混在時の結合順序"
                    value={mixedOrder}
                    onChange={(e) => setMixedOrder(e.target.value as MixedOrder)}
                  >
                    {MIXED_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{MIXED_ORDER_LABELS[opt]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="ocr-settings-note">
            設定はOCR実行時に適用されます。
          </div>
        </div>
      </div>
    </div>
  );
};
