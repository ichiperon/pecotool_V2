import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  useOcrSettingsStore,
  RowOrder, ColumnOrder, MixedOrder,
  ROW_ORDER_LABELS, COLUMN_ORDER_LABELS, MIXED_ORDER_LABELS,
  OcrLanguageInfo,
} from '../store/ocrSettingsStore';
import { Modal, useModalTitleId } from './ui/Modal';

const ROW_OPTIONS: RowOrder[] = ['top-to-bottom', 'bottom-to-top'];
const COL_OPTIONS: ColumnOrder[] = ['left-to-right', 'right-to-left'];
const MIXED_OPTIONS: MixedOrder[] = ['vertical-first', 'horizontal-first'];

interface OcrSettingsModalProps {
  onClose: () => void;
  /**
   * 位置補正 calibration 用プレビュー。現在の補正値で一時 PDF を書き出し既定ビューアで開く。
   * 未指定なら「プレビュー」ボタンを表示しない。
   */
  onPreview?: () => void | Promise<unknown>;
  /**
   * 位置補正を未編集ページも含む全ページに適用して上書き保存する。
   * 未指定なら「全ページに適用して保存」ボタンを表示しない。
   */
  onSaveAllPages?: () => void | Promise<unknown>;
}

export const OcrSettingsModal: React.FC<OcrSettingsModalProps> = ({ onClose, onPreview, onSaveAllPages }) => {
  const {
    horizontal, vertical, groupTolerance, mixedOrder,
    ocrLanguage, availableLanguages,
    ocrConfidenceThreshold, showLowConfidenceHighlight,
    pdfTextOffsetRightMm, pdfTextOffsetDownMm,
    setHorizontalRowOrder, setHorizontalColumnOrder,
    setVerticalColumnOrder, setVerticalRowOrder,
    setGroupTolerance, setMixedOrder,
    setOcrLanguage, setAvailableLanguages,
    setOcrConfidenceThreshold, setShowLowConfidenceHighlight,
    setPdfTextOffsetRightMm, setPdfTextOffsetDownMm,
  } = useOcrSettingsStore();

  const [toleranceInput, setToleranceInput] = useState(String(groupTolerance));
  const [offsetRightInput, setOffsetRightInput] = useState(String(pdfTextOffsetRightMm));
  const [offsetDownInput, setOffsetDownInput] = useState(String(pdfTextOffsetDownMm));
  const [previewing, setPreviewing] = useState(false);
  const [savingAll, setSavingAll] = useState(false);

  const handlePreview = async () => {
    if (!onPreview || previewing) return;
    setPreviewing(true);
    try {
      await onPreview();
    } finally {
      setPreviewing(false);
    }
  };

  const handleSaveAllPages = async () => {
    if (!onSaveAllPages || savingAll) return;
    setSavingAll(true);
    try {
      await onSaveAllPages();
    } finally {
      setSavingAll(false);
    }
  };
  const [langLoading, setLangLoading] = useState(false);
  const titleId = useModalTitleId();

  useEffect(() => {
    if (availableLanguages.length > 0) return;
    setLangLoading(true);
    invoke<OcrLanguageInfo[]>('list_ocr_languages')
      .then((langs) => {
        setAvailableLanguages(langs);
      })
      .catch((e) => {
        console.warn('[OcrSettingsModal] list_ocr_languages failed:', e);
      })
      .finally(() => {
        setLangLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      onClose={onClose}
      titleId={titleId}
      backdropClassName="modal-backdrop"
      dialogClassName="modal ocr-settings-modal"
    >
      <div className="modal-header">
        <span id={titleId}>OCR 序列設定</span>
        <button className="modal-close" onClick={onClose} aria-label="閉じる">✕</button>
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

        {/* OCR 言語設定 */}
        <div className="modal-section-title ocr-settings-section-title">OCR 言語</div>
        {langLoading ? (
          <div className="ocr-settings-lang-loading">言語リスト取得中...</div>
        ) : availableLanguages.length === 0 ? (
          <div className="ocr-settings-lang-empty">
            <p>利用可能な言語パックが見つかりませんでした。</p>
            <p>
              Windows の設定 &gt; 時刻と言語 &gt; 言語と地域 から、OCR を利用したい言語パックを追加してください。
            </p>
          </div>
        ) : (
          <table className="ocr-settings-table">
            <tbody>
              <tr>
                <td className="label">言語</td>
                <td className="value">
                  <select
                    id="ocr-language-select"
                    aria-label="OCR 言語"
                    value={ocrLanguage}
                    onChange={(e) => setOcrLanguage(e.target.value)}
                  >
                    {availableLanguages.map((lang) => (
                      <option key={lang.tag} value={lang.tag}>
                        {lang.display_name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {/* 低信頼ハイライト設定 (#192) */}
        <div className="modal-section-title ocr-settings-section-title">低信頼ハイライト</div>
        <table className="ocr-settings-table">
          <tbody>
            <tr>
              <td className="label">ハイライト表示</td>
              <td className="value">
                <label className="ocr-confidence-toggle-label">
                  <input
                    type="checkbox"
                    checked={showLowConfidenceHighlight}
                    onChange={(e) => setShowLowConfidenceHighlight(e.target.checked)}
                    aria-label="低信頼ハイライトの表示 ON/OFF"
                  />
                  {showLowConfidenceHighlight ? 'ON' : 'OFF'}
                </label>
              </td>
            </tr>
            <tr>
              <td className="label">信頼度閾値</td>
              <td className="value">
                <div className="ocr-confidence-slider-row">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={ocrConfidenceThreshold}
                    onChange={(e) => setOcrConfidenceThreshold(Number(e.target.value))}
                    aria-label={`信頼度閾値 ${Math.round(ocrConfidenceThreshold * 100)}%`}
                    disabled={!showLowConfidenceHighlight}
                  />
                  <span className="ocr-confidence-slider-value">
                    {Math.round(ocrConfidenceThreshold * 100)}%
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* PDF テキスト層の位置オフセット（Acrobat の Ctrl+A 選択範囲） */}
        <div className="modal-section-title ocr-settings-section-title">テキスト層の位置補正</div>
        <table className="ocr-settings-table">
          <tbody>
            <tr>
              <td className="label pb">右方向</td>
              <td className="value pb">
                <input
                  type="number"
                  step={0.5}
                  aria-label="テキスト層オフセット：右方向（mm）"
                  value={offsetRightInput}
                  onChange={(e) => setOffsetRightInput(e.target.value)}
                  onBlur={() => {
                    const parsed = parseFloat(offsetRightInput);
                    const val = isNaN(parsed) ? pdfTextOffsetRightMm : parsed;
                    setPdfTextOffsetRightMm(val);
                    setOffsetRightInput(String(val));
                  }}
                />
                <span className="ocr-settings-tolerance-hint"> mm（正で右・負で左）</span>
              </td>
            </tr>
            <tr>
              <td className="label">下方向</td>
              <td className="value">
                <input
                  type="number"
                  step={0.5}
                  aria-label="テキスト層オフセット：下方向（mm）"
                  value={offsetDownInput}
                  onChange={(e) => setOffsetDownInput(e.target.value)}
                  onBlur={() => {
                    const parsed = parseFloat(offsetDownInput);
                    const val = isNaN(parsed) ? pdfTextOffsetDownMm : parsed;
                    setPdfTextOffsetDownMm(val);
                    setOffsetDownInput(String(val));
                  }}
                />
                <span className="ocr-settings-tolerance-hint"> mm（正で下・負で上）</span>
              </td>
            </tr>
          </tbody>
        </table>
        {onPreview && (
          <div className="ocr-settings-preview-row">
            <button
              type="button"
              className="ocr-settings-preview-btn"
              onClick={handlePreview}
              disabled={previewing || savingAll}
            >
              {previewing ? 'プレビュー生成中…' : 'この補正値で全ページプレビュー'}
            </button>
            <span className="ocr-settings-tolerance-hint">
              一時PDFを書き出して既定ビューアで開きます（保存はされません）
            </span>
          </div>
        )}
        {onSaveAllPages && (
          <div className="ocr-settings-preview-row">
            <button
              type="button"
              className="ocr-settings-preview-btn"
              onClick={handleSaveAllPages}
              disabled={savingAll || previewing}
            >
              {savingAll ? '全ページ保存中…' : '全ページに適用して保存'}
            </button>
            <span className="ocr-settings-tolerance-hint">
              未編集ページにも補正を反映して上書き保存（ページ数が多いと遅くなります）
            </span>
          </div>
        )}
        <div className="ocr-settings-note">
          位置補正は保存する PDF の透明テキスト層（Acrobat の Ctrl+A 選択範囲）にのみ反映されます。
          画面表示やテキスト枠の位置は変わりません。その他の設定はOCR実行時に適用されます。
        </div>
      </div>
    </Modal>
  );
};
