import { useState, type FC } from "react";
import { useReportStore } from "../store/reportStore";
import { buildTemplateCsv } from "../logic/templateCsv";
import { encodeCsvUtf8Bom } from "../logic/csvEncode";
import type { CsvOptions } from "../types/report";

const DEFAULT_OPTIONS: CsvOptions = {
  includeFileName: true,
  includePageNumber: true,
  emptyValue: "",
  normalizeNumbers: false,
};

interface CsvExportButtonProps {
  /** テスト・ブラウザ環境からファイル保存APIを差し込むための注入口。省略時はTauriプラグインを使う。 */
  onSave?: (data: Uint8Array, csv: string) => Promise<void>;
}

const CsvExportButton: FC<CsvExportButtonProps> = ({ onSave }) => {
  const template = useReportStore((s) => s.template);
  const cells = useReportStore((s) => s.cells);
  const [opts, setOpts] = useState<CsvOptions>(DEFAULT_OPTIONS);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const pageNumbers = Array.from(cells.keys()).sort((a, b) => a - b);

  const handleExport = async () => {
    if (template.fields.length === 0) {
      setErrorMessage("欄が定義されていません。先に欄を追加してください。");
      setStatus("error");
      return;
    }

    setStatus("saving");
    setErrorMessage("");

    try {
      const csv = buildTemplateCsv(template, cells, opts, {
        pageNumbers: pageNumbers.length > 0 ? pageNumbers : [1],
      });
      const data = encodeCsvUtf8Bom(csv);

      if (onSave) {
        // テスト・非Tauri環境: 外部からモックを注入
        await onSave(data, csv);
      } else {
        // Tauriランタイム環境: plugin-dialog + plugin-fs で保存
        try {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const { writeFile } = await import("@tauri-apps/plugin-fs");

          const filePath = await save({
            defaultPath: "report.csv",
            filters: [{ name: "CSV", extensions: ["csv"] }],
          });

          if (filePath) {
            await writeFile(filePath, data);
          }
        } catch {
          // Tauriランタイム外（ブラウザ等）では保存をスキップ
          // eslint-disable-next-line no-console
          console.warn("Tauri plugin が利用できません。ファイル保存をスキップしました。");
        }
      }

      setStatus("done");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `出力エラー: ${err.message}`
          : "CSV の出力中にエラーが発生しました。もう一度お試しください。"
      );
      setStatus("error");
    }
  };

  const toggle = (key: keyof CsvOptions, value: boolean | string) => {
    setOpts((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="csv-export">
      <section className="csv-export__options" aria-label="CSV 出力オプション">
        <h4 className="csv-export__options-title">出力オプション</h4>

        <label className="csv-export__option-row">
          <input
            type="checkbox"
            checked={opts.includeFileName}
            onChange={(e) => toggle("includeFileName", e.target.checked)}
          />
          <span>ファイル名列を含める</span>
        </label>

        <label className="csv-export__option-row">
          <input
            type="checkbox"
            checked={opts.includePageNumber}
            onChange={(e) => toggle("includePageNumber", e.target.checked)}
          />
          <span>ページ番号列を含める</span>
        </label>

        <label className="csv-export__option-row">
          <input
            type="checkbox"
            checked={opts.normalizeNumbers}
            onChange={(e) => toggle("normalizeNumbers", e.target.checked)}
          />
          <span>数値を正規化する（△50,000 → -50000）</span>
        </label>

        <label className="csv-export__option-row csv-export__option-row--text">
          <span>空セルの出力値</span>
          <input
            type="text"
            className="csv-export__empty-value-input"
            value={opts.emptyValue}
            onChange={(e) => toggle("emptyValue", e.target.value)}
            placeholder="（空のまま）"
            aria-label="空セルの出力値"
          />
        </label>
      </section>

      <button
        className={`csv-export__btn ${status === "saving" ? "csv-export__btn--saving" : ""}`}
        onClick={handleExport}
        disabled={status === "saving" || template.fields.length === 0}
        aria-busy={status === "saving"}
      >
        {status === "saving"
          ? "出力中..."
          : status === "done"
            ? "保存しました"
            : "CSV を出力"}
      </button>

      {status === "error" && (
        <p className="csv-export__error" role="alert">
          {errorMessage}
        </p>
      )}

      {template.fields.length === 0 && (
        <p className="csv-export__hint">
          欄テンプレートに欄を追加すると出力できます。
        </p>
      )}
    </div>
  );
};

export default CsvExportButton;
