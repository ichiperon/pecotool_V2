/**
 * OCR 校正辞書 / ルールセット ユーティリティ (issue #198)。
 *
 * localStorage へのロード/保存、JSON エクスポート/インポート、
 * および一括適用のためにルールを順番に走査するヘルパーを提供する。
 *
 * ストレージキー: `pecotool.proofreadingRules`
 * スキーマバージョン: 1 (将来バージョンは後方互換を維持すること)
 *
 * localStorage アクセスは jsonStorage アダプター経由で統一 (#255)
 */

import { getJson, setJson } from './jsonStorage';

export interface ProofreadingRule {
  id: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  caseSensitive: boolean;
  enabled: boolean;
  note?: string;
}

export interface ProofreadingRuleSet {
  version: 1;
  rules: ProofreadingRule[];
}

const STORAGE_KEY = 'pecotool.proofreadingRules';

function emptyRuleSet(): ProofreadingRuleSet {
  return { version: 1, rules: [] };
}

export function loadRuleSet(): ProofreadingRuleSet {
  const parsed = getJson<unknown>(STORAGE_KEY);
  if (parsed === null) return emptyRuleSet();
  const validated = validateRuleSet(parsed);
  if ('error' in validated) return emptyRuleSet();
  return validated;
}

export function saveRuleSet(set: ProofreadingRuleSet): void {
  setJson(STORAGE_KEY, set);
}

export function exportRuleSetToJson(set: ProofreadingRuleSet): string {
  return JSON.stringify(set, null, 2);
}

export function importRuleSetFromJson(json: string): ProofreadingRuleSet | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { error: `JSON パースエラー: ${e instanceof Error ? e.message : String(e)}` };
  }
  return validateRuleSet(parsed);
}

/**
 * パース済みの未知値を ProofreadingRuleSet に検証・正規化する。
 * 失敗した場合は呼び出し元がメッセージを表示できるよう `{ error: string }` を返す。
 */
export function validateRuleSet(raw: unknown): ProofreadingRuleSet | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'ルールセットはオブジェクトである必要があります' };
  }
  const obj = raw as Record<string, unknown>;

  if (obj['version'] !== 1) {
    return { error: `未対応のバージョン: ${String(obj['version'])}` };
  }

  if (!Array.isArray(obj['rules'])) {
    return { error: '"rules" 配列が見つかりません' };
  }

  const rules: ProofreadingRule[] = [];
  for (let i = 0; i < (obj['rules'] as unknown[]).length; i++) {
    const r = (obj['rules'] as unknown[])[i];
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { error: `rules[${i}] はオブジェクトである必要があります` };
    }
    const rule = r as Record<string, unknown>;

    if (typeof rule['id'] !== 'string') {
      return { error: `rules[${i}].id が文字列ではありません` };
    }
    if (typeof rule['pattern'] !== 'string') {
      return { error: `rules[${i}].pattern が文字列ではありません` };
    }
    if (typeof rule['replacement'] !== 'string') {
      return { error: `rules[${i}].replacement が文字列ではありません` };
    }
    if (typeof rule['isRegex'] !== 'boolean') {
      return { error: `rules[${i}].isRegex が真偽値ではありません` };
    }
    if (typeof rule['caseSensitive'] !== 'boolean') {
      return { error: `rules[${i}].caseSensitive が真偽値ではありません` };
    }
    if (typeof rule['enabled'] !== 'boolean') {
      return { error: `rules[${i}].enabled が真偽値ではありません` };
    }

    // isRegex=true の場合、pattern が有効な正規表現かどうかを検証する (#231)
    if (rule['isRegex'] === true) {
      try {
        new RegExp(rule['pattern'] as string);
      } catch {
        return { error: `rules[${i}].pattern が不正な正規表現です: ${String(rule['pattern'])}` };
      }
    }

    // 以下のキャストは上記の typeof 型ガードを通過済みのため安全 (#235)
    rules.push({
      id: rule['id'] as string,
      pattern: rule['pattern'] as string,
      replacement: rule['replacement'] as string,
      isRegex: rule['isRegex'] as boolean,
      caseSensitive: rule['caseSensitive'] as boolean,
      enabled: rule['enabled'] as boolean,
      note: typeof rule['note'] === 'string' ? (rule['note'] as string) : undefined,
    });
  }

  return { version: 1, rules };
}

/**
 * UUID を生成し、デフォルト値を設定した新しいルールを作成する。
 */
export function createRule(partial?: Partial<Omit<ProofreadingRule, 'id'>>): ProofreadingRule {
  return {
    id: crypto.randomUUID(),
    pattern: '',
    replacement: '',
    isRegex: false,
    caseSensitive: false,
    enabled: true,
    ...partial,
  };
}
