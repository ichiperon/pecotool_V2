import { useState, useMemo, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { buildTemplateCsv } from "../logic/templateCsv";
import { encodeCsvUtf8Bom } from "../logic/csvEncode";
import { listReviewTargets, countReviewTargets } from "../logic/reviewTargets";
import type { CsvOptions } from "../types/report";

/**
 * フルパスからファイル名（拡張子込み）を取り出す。
 * Tauri の filePath は Windows(\) / POSIX(/) どちらの区切りでも来うるため両対応する。
 */
function basenameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? filePath;
}

const DEFAULT_OPTIONS: CsvOptions = {
  includeFileName: true,
  includePageNumber: true,
  emptyValue: "",
  normalizeNumbers: false,
};

interface CsvExportButtonProps {
  /** テスト・ブラウザ環境からファイル保存APIを差し込むための注入口。省略時はTauriプラグインを使う。 */
  onSave?: (data: Uint8Array, csv: string) => Promise<void>;
  /**
   * 直近の全ページ OCR で処理失敗したページ番号（App の ocrHook から渡す）。
   * 失敗ページは cells に載らず CSV から行ごと消えるため、出力前に明示警告する。
   */
  failedPages?: number[];
}

const CsvExportButton: FC<CsvExportButtonProps> = ({ onSave, failedPages = [] }) => {
  const template = useReportStore((s) => s.template);
  const cells = useReportStore((s) => s.cells);
  const confidences = useReportStore((s) => s.confidences);
  const excludedPages = useReportStore((s) => s.excludedPages);
  const pdfFilePath = usePdfStore((s) => s.filePath);
  const [opts, setOpts] = useState<CsvOptions>(DEFAULT_OPTIONS);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error" | "unavailable">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  // 除外ページは CSV に出さない（OCR後に除外された場合も cells に残っているため必ずフィルタ）
  const pageNumbers = Array.from(cells.keys())
    .filter((p) => !excludedPages.has(p))
    .sort((a, b) => a - b);

  // 出力前ゲート用: 未確認の要確認セル（低信頼・空）の残数
  const reviewCounts = useMemo(
    () => countReviewTargets(listReviewTargets(cells, confidences, template.fields, excludedPages)),
    [cells, confidences, template.fields, excludedPages]
  );

  const handleExport = async () => {
    if (template.fields.length === 0) {
      setErrorMessage("欄が定義されていません。先に欄を追加してください。");
      setStatus("error");
      return;
    }

    // OCR 未実行（cells 空）だとヘッダ＋空行1行の CSV が「保存しました」で成功して
    // しまい、初見ユーザーが成功と誤認する。明示確認を挟む（ブロックはしない）。
    if (cells.size === 0) {
      const ok = window.confirm(
        "OCR 結果がありません。ヘッダーと空の行だけの CSV を出力しますか？"
      );
      if (!ok) return;
    }

    setStatus("saving");
    setErrorMessage("");

    try {
      const csv = buildTemplateCsv(template, cells, opts, {
        fileName: pdfFilePath ? basenameOf(pdfFilePath) : "",
        pageNumbers: pageNumbers.length > 0 ? pageNumbers : [1],
      });
      const data = encodeCsvUtf8Bom(csv);

      if (onSave) {
        // テスト・非Tauri環境: 外部からモックを注入（テスト互換維持）
        await onSave(data, csv);
        setStatus("done");
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        // Tauriランタイム環境: plugin-dialog でパス取得 → Rust save_csv コマンドで保存
        let saveModule: typeof import("@tauri-apps/plugin-dialog") | null = null;
        try {
          saveModule = await import("@tauri-apps/plugin-dialog");
        } catch {
          // Tauriランタイム外（ブラウザ等）ではプラグインが利用不可
          // eslint-disable-next-line no-console
          console.warn("Tauri plugin が利用できません。ファイル保存をスキップしました。");
          setStatus("unavailable");
          setTimeout(() => setStatus("idle"), 3000);
          return;
        }

        const filePath = await saveModule.save({
          defaultPath: "report.csv",
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });

        if (filePath === null || filePath === undefined) {
          // ユーザーがキャンセルした → 成功表示せずにidle へ戻す
          setStatus("idle");
          return;
        }

        // BOM 付与は Rust 側 save_csv が担当するため csv 文字列をそのまま渡す
        await invoke("save_csv", { path: filePath, csv });
        setStatus("done");
        setTimeout(() => setStatus("idle"), 2000);
      }
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
          />
        </label>
      </section>

      {/* 出力前ゲート: 出す前に「直すべきものが残っていないか」を明示する */}
      {reviewCounts.lowConfidence > 0 && (
        <p className="csv-export__gate csv-export__gate--warn" role="note">
          ⚠ 低信頼セルが {reviewCounts.lowConfidence} 件未確認です。確認ステップで見直してからの出力を推奨します
        </p>
      )}
      {failedPages.length > 0 && (
        <p className="csv-export__gate csv-export__gate--alert" role="alert">
          ページ {failedPages.join(", ")} は OCR 失敗のため CSV に行が含まれません（行とページの対応がずれます）
        </p>
      )}

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
            : status === "unavailable"
              ? "この環境では保存できません"
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
