import { useState, useRef, useCallback, useEffect, type FC, type KeyboardEvent, type DragEvent } from "react";
import { useReportStore } from "../store/reportStore";

/** フォーカス位置 */
interface FocusPos {
  pageNum: number;
  fieldIndex: number;
}

/**
 * ゼロ幅スペース (U+200B)。不可視かつスクリーンリーダーも無視するため表示に影響しない。
 * aria-live の再アナウンスを保証するため、同一テキストでも DOM の textContent を変化させる
 * トグル文字として使う。スクリーンリーダーは同一文字列を連続してセットすると再読み上げしない
 * ため、末尾を微細に変化させることで確実に変更イベントを発火させる。
 */
// eslint-disable-next-line no-irregular-whitespace
const ZWSP = "​";

function makeAnnouncement(text: string, toggle: boolean): string {
  return toggle ? `${text}${ZWSP}` : text;
}

const CsvPreviewTable: FC = () => {
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);
  const setCells = useReportStore((s) => s.setCells);
  const setCellValue = useReportStore((s) => s.setCellValue);
  const clearCellValue = useReportStore((s) => s.clearCellValue);
  const moveCellValue = useReportStore((s) => s.moveCellValue);

  const pageNumbers = Array.from(cells.keys()).sort((a, b) => a - b);
  const hasData = pageNumbers.length > 0;
  const hasFields = fields.length > 0;

  // 編集状態
  const [editPos, setEditPos] = useState<{ pageNum: number; fieldId: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  // フォーカス位置（グリッドナビ用）
  const [focusPos, setFocusPos] = useState<FocusPos | null>(null);
  // ドラッグ状態
  const [dragSource, setDragSource] = useState<{ pageNum: number; fieldId: string } | null>(null);
  const [dragOverPos, setDragOverPos] = useState<{ pageNum: number; fieldId: string } | null>(null);
  // aria-live 通知（toggle で同一テキスト連続セット時も再アナウンスを保証）
  const [announcement, setAnnouncement] = useState("");
  const announcementToggleRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const getCellKey = (pageNum: number, fieldIndex: number) => `${pageNum}:${fieldIndex}`;

  /**
   * focusPos のフィールドインデックスとページインデックスを有効範囲にクランプする。
   * fields や pageNumbers が縮小した後に範囲外を指すことを防ぐ。
   */
  const clampFocusPos = useCallback(
    (pos: FocusPos, currentFields: typeof fields, currentPageNumbers: typeof pageNumbers): FocusPos | null => {
      if (currentFields.length === 0 || currentPageNumbers.length === 0) return null;
      const clampedFieldIndex = Math.min(pos.fieldIndex, currentFields.length - 1);
      const pageIdx = currentPageNumbers.indexOf(pos.pageNum);
      const resolvedPageIdx = pageIdx >= 0 ? pageIdx : Math.min(0, currentPageNumbers.length - 1);
      const clampedPageNum = currentPageNumbers[Math.min(resolvedPageIdx, currentPageNumbers.length - 1)];
      return { pageNum: clampedPageNum, fieldIndex: clampedFieldIndex };
    },
    []
  );

  // 通知を発火するヘルパー（toggle を内部管理して同一文字列でも再アナウンス）
  const announce = useCallback((text: string) => {
    announcementToggleRef.current = !announcementToggleRef.current;
    setAnnouncement(makeAnnouncement(text, announcementToggleRef.current));
  }, []);

  // 編集開始
  const startEdit = useCallback(
    (pageNum: number, fieldId: string) => {
      const value = cells.get(pageNum)?.get(fieldId) ?? "";
      setEditPos({ pageNum, fieldId });
      setEditValue(value);
    },
    [cells]
  );

  // 編集確定
  const commitEdit = useCallback(() => {
    if (!editPos) return;
    setCellValue(editPos.pageNum, editPos.fieldId, editValue);
    setEditPos(null);
  }, [editPos, editValue, setCellValue]);

  // 編集取消: フォーカスを親セル(td)へ確実に戻す
  const cancelEdit = useCallback(() => {
    if (!editPos) {
      setEditPos(null);
      return;
    }
    const fieldIndex = fields.findIndex((f) => f.id === editPos.fieldId);
    const safeFieldIndex = fieldIndex >= 0 ? fieldIndex : 0;
    setEditPos(null);
    // 次フレームで td にフォーカスを戻す（input のアンマウント完了後）
    const targetKey = getCellKey(editPos.pageNum, safeFieldIndex);
    requestAnimationFrame(() => {
      cellRefs.current.get(targetKey)?.focus();
    });
  }, [editPos, fields]);

  // input がマウントされたらフォーカス
  useEffect(() => {
    if (editPos && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editPos]);

  // セル削除
  const handleDelete = useCallback(
    (pageNum: number, fieldId: string, fieldName: string) => {
      clearCellValue(pageNum, fieldId);
      announce(`${pageNum}ページ目 ${fieldName} を削除しました`);
    },
    [clearCellValue, announce]
  );

  // 開発用: サンプルデータを注入
  const injectSampleData = () => {
    if (fields.length === 0) return;
    const sample = new Map<number, Map<string, string>>();
    for (let page = 1; page <= 3; page++) {
      const row = new Map<string, string>();
      fields.forEach((field, idx) => {
        if (page === 1 && idx === 0) {
          row.set(field.id, "");
        } else {
          row.set(field.id, `サンプル-P${page}-${field.name}`);
        }
      });
      sample.set(page, row);
    }
    setCells(sample);
  };

  // グリッドキーボードナビ
  const handleCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTableCellElement>, pageNum: number, fieldIndex: number) => {
      const fieldId = fields[fieldIndex]?.id;
      const fieldName = fields[fieldIndex]?.name ?? "";

      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        startEdit(pageNum, fieldId);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete(pageNum, fieldId, fieldName);
        return;
      }

      const pageIdx = pageNumbers.indexOf(pageNum);

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const nextFieldIdx = Math.min(fieldIndex + 1, fields.length - 1);
        setFocusPos({ pageNum, fieldIndex: nextFieldIdx });
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prevFieldIdx = Math.max(fieldIndex - 1, 0);
        setFocusPos({ pageNum, fieldIndex: prevFieldIdx });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextPageIdx = Math.min(pageIdx + 1, pageNumbers.length - 1);
        setFocusPos({ pageNum: pageNumbers[nextPageIdx], fieldIndex });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevPageIdx = Math.max(pageIdx - 1, 0);
        setFocusPos({ pageNum: pageNumbers[prevPageIdx], fieldIndex });
        return;
      }
    },
    [fields, pageNumbers, startEdit, handleDelete]
  );

  // focusPos が範囲外になったとき(欄/ページ削除後等)クランプする
  useEffect(() => {
    if (!focusPos) return;
    const clamped = clampFocusPos(focusPos, fields, pageNumbers);
    if (clamped === null) {
      setFocusPos(null);
      return;
    }
    if (clamped.fieldIndex !== focusPos.fieldIndex || clamped.pageNum !== focusPos.pageNum) {
      setFocusPos(clamped);
    }
  }, [focusPos, fields, pageNumbers, clampFocusPos]);

  // フォーカス位置が変わったとき対応セルにフォーカスを当てる
  useEffect(() => {
    if (focusPos && !editPos) {
      const key = getCellKey(focusPos.pageNum, focusPos.fieldIndex);
      const el = cellRefs.current.get(key);
      el?.focus();
    }
  }, [focusPos, editPos]);

  // input でのキー操作
  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, pageNum: number, fieldIndex: number) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
        // Tab相当: 次の欄へ
        const nextFieldIdx = fieldIndex + 1;
        if (nextFieldIdx < fields.length) {
          setFocusPos({ pageNum, fieldIndex: nextFieldIdx });
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        commitEdit();
        const dir = e.shiftKey ? -1 : 1;
        const nextFieldIdx = fieldIndex + dir;
        if (nextFieldIdx >= 0 && nextFieldIdx < fields.length) {
          setFocusPos({ pageNum, fieldIndex: nextFieldIdx });
        }
      }
    },
    [commitEdit, cancelEdit, fields.length]
  );

  // ドラッグ開始
  const handleDragStart = useCallback(
    (e: DragEvent<HTMLTableCellElement>, pageNum: number, fieldId: string) => {
      setDragSource({ pageNum, fieldId });
      e.dataTransfer.setData("text/plain", `${pageNum}:${fieldId}`);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  // ドラッグ中（ドロップ可否制御）
  const handleDragOver = useCallback(
    (e: DragEvent<HTMLTableCellElement>, pageNum: number, fieldId: string) => {
      if (!dragSource) return;
      // ページ跨ぎ禁止
      if (dragSource.pageNum !== pageNum) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverPos({ pageNum, fieldId });
    },
    [dragSource]
  );

  // ドラッグ離脱
  const handleDragLeave = useCallback(() => {
    setDragOverPos(null);
  }, []);

  // ドロップ
  const handleDrop = useCallback(
    (e: DragEvent<HTMLTableCellElement>, toPageNum: number, toFieldId: string) => {
      e.preventDefault();
      setDragOverPos(null);
      setDragSource(null);
      if (!dragSource) return;
      // ページ跨ぎは無視
      if (dragSource.pageNum !== toPageNum) return;
      moveCellValue(toPageNum, dragSource.fieldId, toFieldId);
      const fromField = fields.find((f) => f.id === dragSource.fieldId)?.name ?? "";
      const toField = fields.find((f) => f.id === toFieldId)?.name ?? "";
      announce(`${toPageNum}ページ目: ${fromField} と ${toField} の値を移動しました`);
    },
    [dragSource, moveCellValue, fields, announce]
  );

  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDragOverPos(null);
  }, []);

  if (!hasFields) {
    return (
      <div className="csv-preview csv-preview--empty">
        <p>欄テンプレートに欄を追加すると、ここにプレビューが表示されます。</p>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="csv-preview csv-preview--empty">
        <p>OCR 後に値が表示されます。</p>
        <button type="button" className="csv-preview__sample-btn" onClick={injectSampleData}>
          サンプルデータを挿入（開発用）
        </button>
      </div>
    );
  }

  return (
    <div className="csv-preview">
      {/* aria-live 領域（削除・移動のアナウンス） */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      <div className="csv-preview__toolbar">
        <span className="csv-preview__info">
          {pageNumbers.length} ページ / {fields.length} 欄
        </span>
        <button type="button" className="csv-preview__sample-btn" onClick={injectSampleData}>
          サンプル再挿入（開発用）
        </button>
      </div>

      <div className="csv-preview__table-wrapper">
        <table
          className="csv-preview__table"
          role="grid"
          aria-label={`OCR 結果編集テーブル: ${pageNumbers.length}ページ / ${fields.length}欄`}
        >
          <thead>
            <tr role="row">
              <th
                className="csv-preview__th csv-preview__th--page"
                role="columnheader"
                scope="col"
              >
                ページ
              </th>
              {fields.map((field) => (
                <th
                  key={field.id}
                  className="csv-preview__th"
                  role="columnheader"
                  scope="col"
                >
                  <span
                    className="csv-preview__field-badge"
                    style={{ backgroundColor: field.color }}
                    aria-hidden="true"
                  />
                  {field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageNumbers.map((pageNum) => {
              const pageMap = cells.get(pageNum);
              const isDimmedPage = dragSource !== null && dragSource.pageNum !== pageNum;
              return (
                <tr
                  key={pageNum}
                  role="row"
                  className={isDimmedPage ? "csv-preview__row--dimmed" : undefined}
                  aria-description={isDimmedPage ? "このページへはドロップできません" : undefined}
                >
                  <td
                    className="csv-preview__td csv-preview__td--page"
                    role="rowheader"
                    aria-label={`${pageNum}ページ目`}
                  >
                    {pageNum}
                  </td>
                  {fields.map((field, fieldIndex) => {
                    const value = pageMap?.get(field.id) ?? "";
                    const isEmpty = value === "";
                    const isEditing =
                      editPos?.pageNum === pageNum && editPos?.fieldId === field.id;
                    const isDragOver =
                      dragOverPos?.pageNum === pageNum && dragOverPos?.fieldId === field.id;
                    const isDragSource =
                      dragSource?.pageNum === pageNum && dragSource?.fieldId === field.id;
                    const cellKey = getCellKey(pageNum, fieldIndex);

                    return (
                      <td
                        key={field.id}
                        ref={(el) => {
                          if (el) cellRefs.current.set(cellKey, el);
                          else cellRefs.current.delete(cellKey);
                        }}
                        className={[
                          "csv-preview__td",
                          isEmpty ? "csv-preview__td--empty" : "",
                          isDragOver ? "csv-preview__td--drag-over" : "",
                          isDragSource ? "csv-preview__td--drag-source" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="gridcell"
                        aria-label={`${pageNum}ページ目 ${field.name} ${isEmpty ? "空" : value}。Delete キーで削除`}
                        aria-disabled={isDimmedPage || undefined}
                        tabIndex={
                          focusPos?.pageNum === pageNum && focusPos?.fieldIndex === fieldIndex
                            ? 0
                            : pageNum === pageNumbers[0] && fieldIndex === 0
                            ? 0
                            : -1
                        }
                        draggable
                        title={isEmpty ? "空" : value}
                        onDoubleClick={() => startEdit(pageNum, field.id)}
                        onKeyDown={(e) => handleCellKeyDown(e, pageNum, fieldIndex)}
                        onFocus={() => setFocusPos({ pageNum, fieldIndex })}
                        onDragStart={(e) => handleDragStart(e, pageNum, field.id)}
                        onDragOver={(e) => handleDragOver(e, pageNum, field.id)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, pageNum, field.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            className="csv-preview__cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => handleInputKeyDown(e, pageNum, fieldIndex)}
                            aria-label={`${pageNum}ページ目 ${field.name} 編集中`}
                          />
                        ) : (
                          <>
                            {isEmpty ? (
                              <span className="csv-preview__empty-mark">(空)</span>
                            ) : (
                              value
                            )}
                            <button
                              type="button"
                              className="csv-preview__cell-clear-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(pageNum, field.id, field.name);
                              }}
                              tabIndex={-1}
                              aria-label={`${pageNum}ページ目 ${field.name} を削除`}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CsvPreviewTable;
