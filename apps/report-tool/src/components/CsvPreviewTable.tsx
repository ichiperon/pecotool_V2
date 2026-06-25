import type { FC } from "react";
import { useReportStore } from "../store/reportStore";

const CsvPreviewTable: FC = () => {
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);
  const setCells = useReportStore((s) => s.setCells);

  const pageNumbers = Array.from(cells.keys()).sort((a, b) => a - b);
  const hasData = pageNumbers.length > 0;
  const hasFields = fields.length > 0;

  // 開発用: サンプルデータを注入する
  const injectSampleData = () => {
    if (fields.length === 0) return;
    const sample = new Map<number, Map<string, string>>();
    for (let page = 1; page <= 3; page++) {
      const row = new Map<string, string>();
      fields.forEach((field, idx) => {
        // ページ1の最初のフィールドを空欄にしてプレビュー確認
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
        <button className="csv-preview__sample-btn" onClick={injectSampleData}>
          サンプルデータを挿入（開発用）
        </button>
      </div>
    );
  }

  return (
    <div className="csv-preview">
      <div className="csv-preview__toolbar">
        <span className="csv-preview__info">
          {pageNumbers.length} ページ / {fields.length} 欄
        </span>
        <button className="csv-preview__sample-btn" onClick={injectSampleData}>
          サンプル再挿入（開発用）
        </button>
      </div>
      <div className="csv-preview__table-wrapper">
        <table className="csv-preview__table">
          <thead>
            <tr>
              <th className="csv-preview__th csv-preview__th--page">ページ</th>
              {fields.map((field) => (
                <th key={field.id} className="csv-preview__th">
                  <span
                    className="csv-preview__field-badge"
                    style={{ backgroundColor: field.color }}
                  />
                  {field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageNumbers.map((pageNum) => {
              const pageMap = cells.get(pageNum);
              return (
                <tr key={pageNum}>
                  <td className="csv-preview__td csv-preview__td--page">{pageNum}</td>
                  {fields.map((field) => {
                    const value = pageMap?.get(field.id) ?? "";
                    const isEmpty = value === "";
                    return (
                      <td
                        key={field.id}
                        className={`csv-preview__td ${isEmpty ? "csv-preview__td--empty" : ""}`}
                        title={isEmpty ? "未取得" : value}
                      >
                        {isEmpty ? <span className="csv-preview__empty-mark">(空)</span> : value}
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
