/**
 * 作業セッションの永続化アダプタ（Rust save_session / load_session / clear_session の薄い橋）。
 *
 * templateStorage と同じ方針:
 * - Tauri invoke は動的 import で解決し、ランタイム外（ブラウザ・jsdom）では
 *   例外を投げず unavailable として静かに機能停止する
 * - 例外は握って Result 型で返す（呼び出し側の分岐を単純化）
 */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface SessionSaveResult {
  ok: boolean;
  unavailable?: boolean;
  reason?: string;
}

export type SessionLoadResult =
  | { ok: true; json: string }
  | { ok: false; missing?: boolean; unavailable?: boolean; reason?: string };

export interface SessionFileStorage {
  save: (json: string) => Promise<SessionSaveResult>;
  load: () => Promise<SessionLoadResult>;
  clear: () => Promise<SessionSaveResult>;
}

async function resolveInvoke(): Promise<InvokeFn | null> {
  try {
    const core = await import("@tauri-apps/api/core");
    return core.invoke as InvokeFn;
  } catch {
    return null;
  }
}

export function createSessionFileStorage(invokeFnOverride?: InvokeFn): SessionFileStorage {
  const getInvoke = async (): Promise<InvokeFn | null> =>
    invokeFnOverride ?? (await resolveInvoke());

  return {
    async save(json) {
      const invoke = await getInvoke();
      if (!invoke) return { ok: false, unavailable: true };
      try {
        await invoke<void>("save_session", { json });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async load() {
      const invoke = await getInvoke();
      if (!invoke) return { ok: false, unavailable: true };
      try {
        const json = await invoke<string>("load_session");
        return { ok: true, json };
      } catch {
        // Rust 側はファイル不在も Err で返す契約。復元フローでは「なし」と同義に扱う
        return { ok: false, missing: true };
      }
    },

    async clear() {
      const invoke = await getInvoke();
      if (!invoke) return { ok: false, unavailable: true };
      try {
        await invoke<void>("clear_session");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
