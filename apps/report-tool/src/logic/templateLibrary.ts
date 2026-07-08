import type { ReportField } from "../types/report";

/**
 * 欄テンプレートライブラリのシリアライズ形式バージョン。
 * schemaVersion が一致しない保存データは非対応として扱う（前方互換）。
 */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** 名前付き欄テンプレートの永続化レコード（Rust 側 save_template/load_template の JSON 契約） */
export interface TemplateRecord {
  schemaVersion: 1;
  /** ファイル名（<id>.json）にもなる一意識別子 */
  id: string;
  name: string;
  fields: ReportField[];
  /** ISO8601 文字列。呼び出し側が時刻を注入する（この層では Date.now を呼ばない） */
  savedAt: string;
  /** 将来のオフセット再現用（今回は populate しない・スキーマ欄のみ用意） */
  sourcePageWidth?: number;
  sourcePageHeight?: number;
}

export type ParseTemplateResult =
  | { ok: true; record: TemplateRecord }
  | { ok: false; reason: string };

export type NameValidationResult = { ok: true } | { ok: false; reason: string };

const MAX_NAME_LENGTH = 100;

/**
 * テンプレート名を検証する。
 * 空文字・空白のみ・長すぎる名前を拒否する。
 */
export function validateTemplateName(name: string): NameValidationResult {
  if (typeof name !== "string") {
    return { ok: false, reason: "テンプレート名が不正です。" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "テンプレート名を入力してください。" };
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `テンプレート名は${MAX_NAME_LENGTH}文字以内で入力してください。` };
  }
  return { ok: true };
}

/** テンプレートレコードの id を新規採番する。 */
export function newTemplateId(): string {
  return globalThis.crypto.randomUUID();
}

export interface SerializeTemplateOptions {
  /** 省略時は newTemplateId() で新規採番する（新規保存時）。既存 id を指定すると上書き/改名になる。 */
  id?: string;
  sourcePageWidth?: number;
  sourcePageHeight?: number;
}

/**
 * ReportField[] を TemplateRecord の JSON 文字列にシリアライズする。
 *
 * savedAt は呼び出し側が渡す（この関数内で Date.now / new Date() を呼ばない）。
 * テストの決定性と、呼び出し側（store）が保存時刻を一元管理できることを優先する。
 *
 * @param fields 保存する欄定義
 * @param name テンプレート表示名
 * @param savedAt ISO8601 文字列（呼び出し側が生成する）
 * @param opts id・元ページサイズなどの追加オプション
 */
export function serializeTemplate(
  fields: ReportField[],
  name: string,
  savedAt: string,
  opts?: SerializeTemplateOptions
): string {
  const record: TemplateRecord = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: opts?.id ?? newTemplateId(),
    name,
    fields,
    savedAt,
  };
  if (opts?.sourcePageWidth !== undefined) {
    record.sourcePageWidth = opts.sourcePageWidth;
  }
  if (opts?.sourcePageHeight !== undefined) {
    record.sourcePageHeight = opts.sourcePageHeight;
  }
  return JSON.stringify(record);
}

function describeParseError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 1 件の欄定義候補を検証・正規化する。不正な場合は null を返す。
 */
function parseField(raw: unknown): ReportField | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || f.id.length === 0) return null;
  if (typeof f.name !== "string") return null;
  if (typeof f.color !== "string") return null;

  const rect = f.rect;
  if (typeof rect !== "object" || rect === null) return null;
  const r = rect as Record<string, unknown>;
  if (
    typeof r.x !== "number" ||
    typeof r.y !== "number" ||
    typeof r.width !== "number" ||
    typeof r.height !== "number"
  ) {
    return null;
  }

  const field: ReportField = {
    id: f.id,
    name: f.name,
    color: f.color,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
  if (typeof f.isLineItem === "boolean") {
    field.isLineItem = f.isLineItem;
  }
  return field;
}

/**
 * TemplateRecord の JSON 文字列をパース・検証する。
 *
 * 以下をすべて検出し、破損データを呼び出し側に安全に伝える:
 * - JSON.parse 失敗
 * - schemaVersion が 1 以外（未対応バージョン）
 * - 必須欄（id/name/fields/savedAt）欠落
 * - fields 内の要素の型不正（id/name/color/rect 欠落・型不一致）
 *
 * @param json load_template が返す生 JSON 文字列
 */
export function parseTemplateRecord(json: string): ParseTemplateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, reason: `テンプレート JSON のパースに失敗しました: ${describeParseError(e)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "テンプレートデータの形式が不正です。" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    return { ok: false, reason: `未対応の schemaVersion です: ${String(obj.schemaVersion)}` };
  }
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { ok: false, reason: "id が不正です。" };
  }
  if (typeof obj.name !== "string") {
    return { ok: false, reason: "name が不正です。" };
  }
  if (typeof obj.savedAt !== "string") {
    return { ok: false, reason: "savedAt が不正です。" };
  }
  if (!Array.isArray(obj.fields)) {
    return { ok: false, reason: "fields が不正です。" };
  }

  const fields: ReportField[] = [];
  for (const raw of obj.fields) {
    const field = parseField(raw);
    if (field === null) {
      return { ok: false, reason: "fields 内に不正な欄定義があります（id/name/color/rect を確認してください）。" };
    }
    fields.push(field);
  }

  const record: TemplateRecord = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: obj.id,
    name: obj.name,
    fields,
    savedAt: obj.savedAt,
  };
  if (typeof obj.sourcePageWidth === "number") {
    record.sourcePageWidth = obj.sourcePageWidth;
  }
  if (typeof obj.sourcePageHeight === "number") {
    record.sourcePageHeight = obj.sourcePageHeight;
  }

  return { ok: true, record };
}
