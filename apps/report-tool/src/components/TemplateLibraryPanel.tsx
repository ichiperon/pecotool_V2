import { useEffect, useState, type FC, type KeyboardEvent } from "react";
import { useTemplateLibraryStore } from "../store/templateLibraryStore";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import type { TemplateSummary } from "../lib/templateStorage";

/**
 * 欄テンプレートライブラリパネル。
 *
 * ステップ①右ペインの FieldListPanel の直上に配置し、
 * 現在の欄構成を名前付きテンプレートとして保存・一覧表示・読込・削除・改名する。
 *
 * - 保存: 欄が 0 件のときはボタンを無効化（CsvExportButton の disabled 流儀を踏襲）。
 *   同名テンプレートが既にある場合は confirm で上書き確認してから再送信する。
 * - 読込: 現在の抽出データ（cells）が残っている場合は confirm で破棄確認する。
 *   readable=false（破損 JSON 等）の行は選択不可。
 * - 削除・改名: confirm 確認後に実行。改名のインライン編集は FieldListPanel/FieldRow の
 *   UX（Enter で確定・Escape で取消・IME 変換中の Enter は無視）を踏襲する。
 */
const TemplateLibraryPanel: FC = () => {
  const summaries = useTemplateLibraryStore((s) => s.summaries);
  const status = useTemplateLibraryStore((s) => s.status);
  const error = useTemplateLibraryStore((s) => s.error);
  const refreshList = useTemplateLibraryStore((s) => s.refreshList);
  const saveAs = useTemplateLibraryStore((s) => s.saveAs);
  const load = useTemplateLibraryStore((s) => s.load);
  const remove = useTemplateLibraryStore((s) => s.remove);
  const rename = useTemplateLibraryStore((s) => s.rename);

  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);

  const [isSaving, setIsSaving] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    void refreshList();
    // マウント時の一覧同期のみ。refreshList 自体は store 側で安定した参照ではないため
    // 依存配列には含めない（過剰な再取得を避ける）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasFields = fields.length > 0;

  const openSaveForm = () => {
    setSaveName("");
    setSaveError(null);
    setShowSaveForm(true);
  };

  const cancelSaveForm = () => {
    setShowSaveForm(false);
    setSaveName("");
    setSaveError(null);
  };

  const commitSave = async (overwriteId?: string) => {
    const trimmed = saveName.trim();
    if (trimmed === "") {
      setSaveError("テンプレート名を入力してください。");
      return;
    }

    // テンプレは回転メタデータを持たない（欄 rect は現在の表示空間のまま保存される）。
    // 回転中に保存して回転 0 の別 PDF で読み込むと座標が二重回転で全ずれするため、
    // 回転中の保存は明示確認を挟む（恒久対応=回転メタデータの保存は別issue）。
    if (overwriteId === undefined && usePdfStore.getState().rotation !== 0) {
      const ok = window.confirm(
        "ページを回転した状態で保存します。このテンプレートは同じ回転状態でのみ正しく使えます。続けますか？"
      );
      if (!ok) return;
    }

    setIsSaving(true);
    setSaveError(null);
    const result = await saveAs(trimmed, new Date().toISOString(), overwriteId);
    setIsSaving(false);

    if (result.status === "saved") {
      setShowSaveForm(false);
      setSaveName("");
      return;
    }
    if (result.status === "conflict") {
      const ok = window.confirm(`同名テンプレ『${trimmed}』を上書きしますか？`);
      if (ok) {
        await commitSave(result.existingId);
      }
      return;
    }
    setSaveError(result.reason);
  };

  const handleSaveKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") void commitSave();
    if (e.key === "Escape") cancelSaveForm();
  };

  const handleLoad = async (summary: TemplateSummary) => {
    if (!summary.readable) return;
    if (cells.size > 0) {
      const ok = window.confirm(
        "現在の抽出データ（OCR結果・手編集）が破棄されます。よろしいですか？"
      );
      if (!ok) return;
    }
    if (usePdfStore.getState().rotation !== 0) {
      const ok = window.confirm(
        "ページを回転した状態でテンプレートを読み込みます。テンプレートが回転なしで保存されている場合、欄の位置がずれます。続けますか？"
      );
      if (!ok) return;
    }
    await load(summary.id);
  };

  const handleRemove = async (summary: TemplateSummary) => {
    const ok = window.confirm(`テンプレート『${summary.name}』を削除しますか？`);
    if (!ok) return;
    await remove(summary.id);
  };

  const startRename = (summary: TemplateSummary) => {
    setEditingId(summary.id);
    setRenameDraft(summary.name);
  };

  const commitRename = async (summary: TemplateSummary) => {
    // Enter → rename 呼出 → setEditingId(null) → input アンマウント → onBlur 再発火、で
    // commitRename が二重に呼ばれるケースを想定したガード。editingId が既にこの行から
    // 外れていれば（前回の呼び出しで確定済みなら）何もしない。
    if (editingId !== summary.id) return;

    const trimmed = renameDraft.trim();
    if (trimmed === "" || trimmed === summary.name) {
      setRenameDraft(summary.name);
      setEditingId(null);
      return;
    }

    setEditingId(null);
    await rename(summary.id, trimmed, new Date().toISOString());
  };

  const handleRenameKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    summary: TemplateSummary
  ) => {
    // IME 変換中/変換確定の Enter・Escape はリネームの commit/cancel に渡さない
    // （FieldRow と同パターン。keyCode 229 は isComposing が false で届く IME 確定キーの互換フォールバック）。
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") void commitRename(summary);
    if (e.key === "Escape") {
      setRenameDraft(summary.name);
      setEditingId(null);
    }
  };

  return (
    <div className="template-library-panel">
      <div className="template-library-panel__header">
        <h3 className="template-library-panel__title">テンプレートライブラリ</h3>
      </div>

      {!showSaveForm ? (
        <button
          type="button"
          className="template-library-panel__save-btn"
          onClick={openSaveForm}
          disabled={!hasFields}
          aria-label="現在の欄をテンプレとして保存"
        >
          現在の欄をテンプレとして保存
        </button>
      ) : (
        <div className="template-library-panel__save-form">
          <input
            className="template-library-panel__save-input"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={handleSaveKeyDown}
            placeholder="テンプレート名"
            aria-label="テンプレート名を入力"
            autoFocus
            disabled={isSaving}
          />
          <button
            type="button"
            className="template-library-panel__save-confirm-btn"
            onClick={() => void commitSave()}
            disabled={isSaving}
            aria-label="テンプレート保存を確定"
          >
            {isSaving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="template-library-panel__save-cancel-btn"
            onClick={cancelSaveForm}
            disabled={isSaving}
            aria-label="テンプレート保存をキャンセル"
          >
            キャンセル
          </button>
        </div>
      )}

      {saveError && (
        <p className="template-library-panel__error" role="alert">
          {saveError}
        </p>
      )}

      {status === "loading" && (
        <p className="template-library-panel__loading" aria-live="polite">
          読み込み中…
        </p>
      )}
      {status === "error" && error && (
        <p className="template-library-panel__error" role="alert">
          {error}
        </p>
      )}

      {summaries.length === 0 && status !== "loading" ? (
        <p className="template-library-panel__empty">
          保存済みテンプレートはありません。
        </p>
      ) : (
        <ul className="template-library-panel__list" aria-label="保存済みテンプレート">
          {summaries.map((summary) => (
            <li key={summary.id} className="template-library-row">
              {editingId === summary.id ? (
                <input
                  className="template-library-row__name-input"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename(summary)}
                  onKeyDown={(e) => handleRenameKeyDown(e, summary)}
                  autoFocus
                  aria-label={`${summary.name} の名前を編集`}
                />
              ) : (
                <button
                  type="button"
                  className="template-library-row__name"
                  onClick={() => void handleLoad(summary)}
                  disabled={!summary.readable}
                  aria-label={
                    summary.readable
                      ? `${summary.name} を読み込む`
                      : `${summary.name}（読み込めません）`
                  }
                >
                  {summary.name}
                  {!summary.readable && (
                    <span className="template-library-row__unreadable">
                      　読み込めません
                    </span>
                  )}
                </button>
              )}

              <button
                type="button"
                className="template-library-row__rename-btn"
                onClick={() => startRename(summary)}
                aria-label={`${summary.name} の名前を変更`}
              >
                改名
              </button>

              <button
                type="button"
                className="template-library-row__remove-btn"
                onClick={() => void handleRemove(summary)}
                aria-label={`${summary.name} を削除`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TemplateLibraryPanel;
