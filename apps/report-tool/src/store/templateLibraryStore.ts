import { create } from "zustand";
import type { TemplateSummary } from "../lib/templateStorage";
import { templateStorage } from "../lib/templateStorage";
import {
  newTemplateId,
  parseTemplateRecord,
  serializeTemplate,
  validateTemplateName,
} from "../logic/templateLibrary";
import { useReportStore } from "./reportStore";
import type { TemplateRecord } from "../logic/templateLibrary";

export type TemplateLibraryStatus = "idle" | "loading" | "error";

export type SaveAsResult =
  | { status: "saved"; id: string }
  /** 同名の既存テンプレートが見つかった。保存は行っていない。UI が確認後 overwriteId を付けて再呼び出しする。 */
  | { status: "conflict"; existingId: string }
  | { status: "error"; reason: string };

export type LoadResult =
  | { status: "loaded"; record: TemplateRecord }
  | { status: "error"; reason: string };

export type RemoveResult = { status: "removed" } | { status: "error"; reason: string };

export type RenameResult =
  | { status: "renamed"; id: string }
  | { status: "error"; reason: string };

interface TemplateLibraryState {
  summaries: TemplateSummary[];
  status: TemplateLibraryStatus;
  error: string | null;

  /** list_templates を呼び直して summaries を更新する。 */
  refreshList: () => Promise<void>;
  /**
   * 現在の欄テンプレート（useReportStore の template.fields）を名前付きで保存する。
   * 同名の既存テンプレートがある場合、overwriteId を指定しない呼び出しは保存せず
   * conflict を返す（呼び出し側で上書き確認 UI を出す想定）。
   */
  saveAs: (name: string, savedAt: string, overwriteId?: string) => Promise<SaveAsResult>;
  /**
   * テンプレートを読み込み、useReportStore.replaceTemplateFields で反映する。
   * cells/confidences/pageOffsets の破棄は replaceTemplateFields 側が担保する。
   */
  load: (id: string) => Promise<LoadResult>;
  remove: (id: string) => Promise<RemoveResult>;
  /** load → name 書き換え → save_template（同一 id）で改名する。 */
  rename: (id: string, name: string, savedAt: string) => Promise<RenameResult>;
}

export const useTemplateLibraryStore = create<TemplateLibraryState>((set, get) => ({
  summaries: [],
  status: "idle",
  error: null,

  refreshList: async () => {
    set({ status: "loading", error: null });
    const result = await templateStorage.listTemplates();
    if (!result.ok) {
      set({ status: "error", error: result.reason, summaries: [] });
      return;
    }
    set({ summaries: result.value, status: "idle", error: null });
  },

  saveAs: async (name, savedAt, overwriteId) => {
    const nameCheck = validateTemplateName(name);
    if (!nameCheck.ok) {
      return { status: "error", reason: nameCheck.reason };
    }

    if (!overwriteId) {
      const existing = get().summaries.find((s) => s.name === name);
      if (existing) {
        return { status: "conflict", existingId: existing.id };
      }
    }

    const id = overwriteId ?? newTemplateId();
    const fields = useReportStore.getState().template.fields;
    const json = serializeTemplate(fields, name, savedAt, { id });

    const result = await templateStorage.saveTemplate(id, json);
    if (!result.ok) {
      return { status: "error", reason: result.reason };
    }

    await get().refreshList();
    return { status: "saved", id };
  },

  load: async (id) => {
    set({ status: "loading", error: null });
    const loadResult = await templateStorage.loadTemplate(id);
    if (!loadResult.ok) {
      set({ status: "error", error: loadResult.reason });
      return { status: "error", reason: loadResult.reason };
    }

    const parsed = parseTemplateRecord(loadResult.value);
    if (!parsed.ok) {
      set({ status: "error", error: parsed.reason });
      return { status: "error", reason: parsed.reason };
    }

    useReportStore.getState().replaceTemplateFields(parsed.record.fields);
    set({ status: "idle", error: null });
    return { status: "loaded", record: parsed.record };
  },

  remove: async (id) => {
    const result = await templateStorage.deleteTemplate(id);
    if (!result.ok) {
      set({ status: "error", error: result.reason });
      return { status: "error", reason: result.reason };
    }
    await get().refreshList();
    return { status: "removed" };
  },

  rename: async (id, name, savedAt) => {
    const nameCheck = validateTemplateName(name);
    if (!nameCheck.ok) {
      set({ status: "error", error: nameCheck.reason });
      return { status: "error", reason: nameCheck.reason };
    }

    // 別テンプレート（id 不一致）と同名になる改名は拒否する。
    // saveAs の conflict（上書き確認して保存継続）と異なり、rename は別テンプレートの
    // 上書きが意味を成さないため error として拒否する。
    const duplicate = get().summaries.find((s) => s.name === name && s.id !== id);
    if (duplicate) {
      const reason = "同名のテンプレートが既に存在します";
      set({ status: "error", error: reason });
      return { status: "error", reason };
    }

    const loadResult = await templateStorage.loadTemplate(id);
    if (!loadResult.ok) {
      set({ status: "error", error: loadResult.reason });
      return { status: "error", reason: loadResult.reason };
    }

    const parsed = parseTemplateRecord(loadResult.value);
    if (!parsed.ok) {
      set({ status: "error", error: parsed.reason });
      return { status: "error", reason: parsed.reason };
    }

    const json = serializeTemplate(parsed.record.fields, name, savedAt, {
      id,
      sourcePageWidth: parsed.record.sourcePageWidth,
      sourcePageHeight: parsed.record.sourcePageHeight,
    });

    const saveResult = await templateStorage.saveTemplate(id, json);
    if (!saveResult.ok) {
      set({ status: "error", error: saveResult.reason });
      return { status: "error", reason: saveResult.reason };
    }

    await get().refreshList();
    return { status: "renamed", id };
  },
}));
