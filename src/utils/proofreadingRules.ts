/**
 * OCR proofreading dictionary / rule-set utilities (issue #198).
 *
 * Provides load/save via localStorage, JSON export/import, and a helper
 * to iterate rules in order for bulk-apply.
 *
 * Storage key: `pecotool.proofreadingRules`
 * Schema version: 1 (future versions must be backward-compatible)
 */

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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRuleSet();
    const parsed: unknown = JSON.parse(raw);
    const validated = validateRuleSet(parsed);
    if ('error' in validated) return emptyRuleSet();
    return validated;
  } catch {
    return emptyRuleSet();
  }
}

export function saveRuleSet(set: ProofreadingRuleSet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(set));
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
 * Validate and normalize a raw parsed value into ProofreadingRuleSet.
 * Returns `{ error: string }` on failure so callers can surface the message.
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
 * Create a new rule with a generated UUID and sensible defaults.
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
