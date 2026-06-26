import { useState, useRef, type FC, type KeyboardEvent } from "react";
import { useReportStore, FIELD_COLOR_PALETTE } from "../store/reportStore";
import type { ReportField } from "../types/report";

interface FieldRowProps {
  field: ReportField;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
  onLineItemChange: (id: string, value: boolean) => void;
}

const FieldRow: FC<FieldRowProps> = ({
  field,
  onRename,
  onRemove,
  onColorChange,
  onLineItemChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.name);
  const [showPalette, setShowPalette] = useState(false);
  const colorChipRef = useRef<HTMLButtonElement>(null);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed !== "" && trimmed !== field.name) {
      onRename(field.id, trimmed);
    } else {
      setDraft(field.name);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") {
      setDraft(field.name);
      setEditing(false);
    }
  };

  const closePalette = () => {
    setShowPalette(false);
    colorChipRef.current?.focus();
  };

  const handlePaletteKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      closePalette();
    }
  };

  const isLineItem = field.isLineItem === true;

  return (
    <li className="field-row">
      <div
        className="field-row__color-wrapper"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setShowPalette(false);
          }
        }}
      >
        <button
          ref={colorChipRef}
          type="button"
          className="field-row__color-chip"
          // CSS カスタムプロパティ経由で色を渡す（インラインスタイル回避できないケース:
          // 動的色値のため外部 CSS では記述不可。既存の field-badge と同一パターン）
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          style={{ "--chip-color": field.color } as React.CSSProperties}
          onClick={() => setShowPalette((v) => !v)}
          aria-label={`${field.name} の色を変更`}
          aria-expanded={showPalette ? "true" : "false"}
          aria-haspopup="listbox"
        />
        {showPalette && (
          <div
            className="field-row__palette"
            role="listbox"
            aria-label="色を選択"
            onKeyDown={handlePaletteKeyDown}
          >
            {FIELD_COLOR_PALETTE.map((color, index) => (
              <button
                key={color}
                type="button"
                className={[
                  "field-row__palette-chip",
                  color === field.color ? "field-row__palette-chip--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                style={{ "--chip-color": color } as React.CSSProperties}
                onClick={() => {
                  onColorChange(field.id, color);
                  setShowPalette(false);
                }}
                aria-label={`色 ${index + 1}`}
                role="option"
                aria-selected={color === field.color ? "true" : "false"}
              />
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <input
          className="field-row__name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          autoFocus
          aria-label="欄の名前を編集"
        />
      ) : (
        <button
          type="button"
          className="field-row__name"
          onClick={() => {
            setDraft(field.name);
            setEditing(true);
          }}
          aria-label={`${field.name}（クリックで名前を編集）`}
        >
          {field.name}
        </button>
      )}

      {/* 明細欄トグル */}
      <label className="field-row__lineitem-label" title="明細欄（段ごとに繰り返す）">
        <input
          type="checkbox"
          className="field-row__lineitem-checkbox"
          checked={isLineItem}
          onChange={(e) => onLineItemChange(field.id, e.target.checked)}
          aria-label={`${field.name} を明細欄にする`}
        />
        <span className="field-row__lineitem-text">明細</span>
      </label>

      <button
        type="button"
        className="field-row__remove"
        onClick={() => onRemove(field.id)}
        aria-label={`${field.name} を削除`}
      >
        ✕
      </button>
    </li>
  );
};

const FieldListPanel: FC = () => {
  const fields = useReportStore((s) => s.template.fields);
  const removeField = useReportStore((s) => s.removeField);
  const renameField = useReportStore((s) => s.renameField);
  const setFieldColor = useReportStore((s) => s.setFieldColor);
  const setFieldLineItem = useReportStore((s) => s.setFieldLineItem);
  const mode = useReportStore((s) => s.mode);
  const setMode = useReportStore((s) => s.setMode);

  const handleModeToggle = () => {
    setMode(mode === "defineField" ? "idle" : "defineField");
  };

  const isDefining = mode === "defineField";

  return (
    <div className="field-list-panel">
      <div className="field-list-panel__header">
        <h3 className="field-list-panel__title">欄テンプレート</h3>
        <button
          type="button"
          className={
            isDefining
              ? "field-list-panel__add-btn field-list-panel__add-btn--active"
              : "field-list-panel__add-btn"
          }
          onClick={handleModeToggle}
          aria-pressed={isDefining ? "true" : "false"}
        >
          {isDefining ? "定義中…（クリックで終了）" : "＋ 欄を追加"}
        </button>
      </div>

      {fields.length === 0 ? (
        <p className="field-list-panel__empty">
          まだ欄がありません。［＋ 欄を追加］で欄を定義してください。
        </p>
      ) : (
        <ul className="field-list-panel__list" aria-label="定義済みの欄">
          {fields.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              onRename={renameField}
              onRemove={removeField}
              onColorChange={setFieldColor}
              onLineItemChange={setFieldLineItem}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export default FieldListPanel;
