import { useState, useRef, type FC, type KeyboardEvent } from "react";
import { useReportStore, FIELD_COLOR_PALETTE } from "../store/reportStore";
import type { ReportField } from "../types/report";

interface FieldRowProps {
  field: ReportField;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
}

const FieldRow: FC<FieldRowProps> = ({ field, onRename, onRemove, onColorChange }) => {
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

  return (
    <li className="field-row">
      <div
        className="field-row__color-wrapper"
        onBlur={(e) => {
          // フォーカスがcolor-wrapper外に移ったらパレットを閉じる
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setShowPalette(false);
          }
        }}
      >
        <button
          ref={colorChipRef}
          className="field-row__color-chip"
          style={{ backgroundColor: field.color }}
          onClick={() => setShowPalette((v) => !v)}
          aria-label={`${field.name} の色を変更`}
          aria-expanded={showPalette}
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
                className="field-row__palette-chip"
                style={{
                  backgroundColor: color,
                  outline: color === field.color ? "2px solid #333" : undefined,
                }}
                onClick={() => {
                  onColorChange(field.id, color);
                  setShowPalette(false);
                }}
                aria-label={`色 ${index + 1}`}
                role="option"
                aria-selected={color === field.color}
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

      <button
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
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export default FieldListPanel;
