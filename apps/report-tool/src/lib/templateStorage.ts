/**
 * 欄テンプレートライブラリの Tauri IPC 境界アダプタ。
 *
 * Rust コマンド契約:
 * - save_template(id, json) -> void
 * - list_templates() -> TemplateSummary[]
 * - load_template(id) -> string（生 JSON）
 * - delete_template(id) -> void
 *
 * 非 Tauri 環境（テスト/ブラウザ単体プレビュー）では "@tauri-apps/api/core" の
 * 動的 import が失敗しうるため、失敗を捕捉して unavailable として扱う
 * （components/CsvExportButton.tsx の分岐パターンを踏襲）。
 */

/** list_templates が返すサマリ 1 件。readable=false は破損 JSON など読み込み不能を示す。 */
export interface TemplateSummary {
  id: string;
  name: string;
  savedAt: string;
  schemaVersion: number;
  readable: boolean;
}

export type TemplateStorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; unavailable?: boolean };

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TemplateStorageAdapter {
  saveTemplate(id: string, json: string): Promise<TemplateStorageResult<void>>;
  listTemplates(): Promise<TemplateStorageResult<TemplateSummary[]>>;
  loadTemplate(id: string): Promise<TemplateStorageResult<string>>;
  deleteTemplate(id: string): Promise<TemplateStorageResult<void>>;
}

const UNAVAILABLE_REASON = "この環境ではテンプレート機能を利用できません。";

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tauri invoke を動的 import で解決する。
 * Tauri ランタイム外（ブラウザ・vitest 等）では import 自体が失敗しうるため、
 * その場合は null を返して呼び出し側に unavailable を判定させる。
 */
async function loadInvoke(): Promise<InvokeFn | null> {
  try {
    const core = await import("@tauri-apps/api/core");
    return core.invoke as InvokeFn;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[templateStorage] Tauri invoke が利用できません。テンプレート機能をスキップします。");
    return null;
  }
}

/**
 * テンプレートストレージアダプタを生成する。
 *
 * @param invokeFnOverride テスト用の invoke 差し替え。省略時は動的 import で解決する。
 */
export function createTemplateStorageAdapter(invokeFnOverride?: InvokeFn): TemplateStorageAdapter {
  const resolveInvoke = async (): Promise<InvokeFn | null> => {
    if (invokeFnOverride) return invokeFnOverride;
    return loadInvoke();
  };

  return {
    async saveTemplate(id, json) {
      const invoke = await resolveInvoke();
      if (!invoke) return { ok: false, reason: UNAVAILABLE_REASON, unavailable: true };
      try {
        await invoke<void>("save_template", { id, json });
        return { ok: true, value: undefined };
      } catch (e) {
        return { ok: false, reason: describeError(e) };
      }
    },

    async listTemplates() {
      const invoke = await resolveInvoke();
      if (!invoke) return { ok: false, reason: UNAVAILABLE_REASON, unavailable: true };
      try {
        const value = await invoke<TemplateSummary[]>("list_templates");
        return { ok: true, value };
      } catch (e) {
        return { ok: false, reason: describeError(e) };
      }
    },

    async loadTemplate(id) {
      const invoke = await resolveInvoke();
      if (!invoke) return { ok: false, reason: UNAVAILABLE_REASON, unavailable: true };
      try {
        const value = await invoke<string>("load_template", { id });
        return { ok: true, value };
      } catch (e) {
        return { ok: false, reason: describeError(e) };
      }
    },

    async deleteTemplate(id) {
      const invoke = await resolveInvoke();
      if (!invoke) return { ok: false, reason: UNAVAILABLE_REASON, unavailable: true };
      try {
        await invoke<void>("delete_template", { id });
        return { ok: true, value: undefined };
      } catch (e) {
        return { ok: false, reason: describeError(e) };
      }
    },
  };
}

/** アプリ実行時に使う既定アダプタ（動的 import で Tauri invoke を解決する）。 */
export const templateStorage: TemplateStorageAdapter = createTemplateStorageAdapter();
