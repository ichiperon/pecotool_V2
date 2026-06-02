/**
 * proofreadingRules utility (issue #198) unit tests.
 *
 * Covers:
 *  - loadRuleSet / saveRuleSet round-trip
 *  - exportRuleSetToJson / importRuleSetFromJson normal case
 *  - importRuleSetFromJson error cases: malformed JSON, wrong schema
 *  - validateRuleSet edge cases
 *  - enabled/disabled rule filtering helper
 *  - createRule defaults
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadRuleSet,
  saveRuleSet,
  exportRuleSetToJson,
  importRuleSetFromJson,
  validateRuleSet,
  createRule,
  type ProofreadingRule,
  type ProofreadingRuleSet,
} from '../../utils/proofreadingRules';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------
const localStorageData: Record<string, string> = {};

beforeEach(() => {
  Object.keys(localStorageData).forEach((k) => delete localStorageData[k]);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => localStorageData[key] ?? null);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
    localStorageData[key] = String(value);
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
    delete localStorageData[key];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRule(overrides: Partial<ProofreadingRule> = {}): ProofreadingRule {
  return {
    id: 'test-id-1',
    pattern: 'foo',
    replacement: 'bar',
    isRegex: false,
    caseSensitive: false,
    enabled: true,
    ...overrides,
  };
}

function makeRuleSet(rules: ProofreadingRule[] = []): ProofreadingRuleSet {
  return { version: 1, rules };
}

// ---------------------------------------------------------------------------
// loadRuleSet
// ---------------------------------------------------------------------------
describe('loadRuleSet', () => {
  it('returns empty ruleset when localStorage is empty', () => {
    const result = loadRuleSet();
    expect(result).toEqual({ version: 1, rules: [] });
  });

  it('returns empty ruleset when stored JSON is malformed', () => {
    localStorageData['pecotool.proofreadingRules'] = 'not valid json';
    const result = loadRuleSet();
    expect(result).toEqual({ version: 1, rules: [] });
  });

  it('returns empty ruleset when stored JSON has wrong version', () => {
    localStorageData['pecotool.proofreadingRules'] = JSON.stringify({ version: 2, rules: [] });
    const result = loadRuleSet();
    expect(result).toEqual({ version: 1, rules: [] });
  });

  it('returns empty ruleset when stored JSON is not an object', () => {
    localStorageData['pecotool.proofreadingRules'] = JSON.stringify([1, 2, 3]);
    const result = loadRuleSet();
    expect(result).toEqual({ version: 1, rules: [] });
  });
});

// ---------------------------------------------------------------------------
// saveRuleSet / loadRuleSet round-trip
// ---------------------------------------------------------------------------
describe('saveRuleSet + loadRuleSet round-trip', () => {
  it('saves and loads a ruleset with one rule', () => {
    const rule = makeRule();
    const ruleSet = makeRuleSet([rule]);
    saveRuleSet(ruleSet);
    const loaded = loadRuleSet();
    expect(loaded).toEqual(ruleSet);
  });

  it('round-trips multiple rules preserving order', () => {
    const rules = [
      makeRule({ id: 'id-1', pattern: 'aaa', replacement: 'bbb' }),
      makeRule({ id: 'id-2', pattern: 'ccc', replacement: 'ddd', isRegex: true }),
      makeRule({ id: 'id-3', pattern: 'eee', replacement: '', enabled: false }),
    ];
    const ruleSet = makeRuleSet(rules);
    saveRuleSet(ruleSet);
    const loaded = loadRuleSet();
    expect(loaded.rules).toHaveLength(3);
    expect(loaded.rules[0].id).toBe('id-1');
    expect(loaded.rules[1].isRegex).toBe(true);
    expect(loaded.rules[2].enabled).toBe(false);
  });

  it('round-trips optional note field', () => {
    const rule = makeRule({ note: 'OCR always gets this wrong' });
    saveRuleSet(makeRuleSet([rule]));
    const loaded = loadRuleSet();
    expect(loaded.rules[0].note).toBe('OCR always gets this wrong');
  });

  it('loaded ruleset has no note when original omitted it', () => {
    const rule = makeRule();
    saveRuleSet(makeRuleSet([rule]));
    const loaded = loadRuleSet();
    expect(loaded.rules[0].note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exportRuleSetToJson
// ---------------------------------------------------------------------------
describe('exportRuleSetToJson', () => {
  it('produces valid JSON string', () => {
    const ruleSet = makeRuleSet([makeRule()]);
    const json = exportRuleSetToJson(ruleSet);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('exported JSON round-trips back via importRuleSetFromJson', () => {
    const ruleSet = makeRuleSet([makeRule({ pattern: 'x', replacement: 'y' })]);
    const json = exportRuleSetToJson(ruleSet);
    const result = importRuleSetFromJson(json);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rules[0].pattern).toBe('x');
      expect(result.rules[0].replacement).toBe('y');
    }
  });

  it('produces pretty-printed JSON (indented)', () => {
    const json = exportRuleSetToJson(makeRuleSet([]));
    expect(json).toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// importRuleSetFromJson - normal cases
// ---------------------------------------------------------------------------
describe('importRuleSetFromJson - normal', () => {
  it('imports a valid ruleset JSON', () => {
    const ruleSet = makeRuleSet([makeRule()]);
    const json = JSON.stringify(ruleSet);
    const result = importRuleSetFromJson(json);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.version).toBe(1);
      expect(result.rules).toHaveLength(1);
    }
  });

  it('imports empty rules array', () => {
    const json = JSON.stringify({ version: 1, rules: [] });
    const result = importRuleSetFromJson(json);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.rules).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// importRuleSetFromJson - error cases
// ---------------------------------------------------------------------------
describe('importRuleSetFromJson - errors', () => {
  it('returns error for malformed JSON', () => {
    const result = importRuleSetFromJson('{bad json}');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('JSON パースエラー');
    }
  });

  it('returns error for JSON array at root', () => {
    const result = importRuleSetFromJson(JSON.stringify([1, 2, 3]));
    expect('error' in result).toBe(true);
  });

  it('returns error for missing version field', () => {
    const result = importRuleSetFromJson(JSON.stringify({ rules: [] }));
    expect('error' in result).toBe(true);
  });

  it('returns error for wrong version number', () => {
    const result = importRuleSetFromJson(JSON.stringify({ version: 99, rules: [] }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('99');
    }
  });

  it('returns error when rules is not an array', () => {
    const result = importRuleSetFromJson(JSON.stringify({ version: 1, rules: 'bad' }));
    expect('error' in result).toBe(true);
  });

  it('returns error when a rule element is not an object', () => {
    const result = importRuleSetFromJson(JSON.stringify({ version: 1, rules: ['bad'] }));
    expect('error' in result).toBe(true);
  });

  it('returns error when rule.id is missing', () => {
    const badRule = { pattern: 'x', replacement: 'y', isRegex: false, caseSensitive: false, enabled: true };
    const result = importRuleSetFromJson(JSON.stringify({ version: 1, rules: [badRule] }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('id');
    }
  });

  it('returns error when rule.isRegex is not boolean', () => {
    const badRule = { id: 'x', pattern: 'x', replacement: 'y', isRegex: 'yes', caseSensitive: false, enabled: true };
    const result = importRuleSetFromJson(JSON.stringify({ version: 1, rules: [badRule] }));
    expect('error' in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateRuleSet
// ---------------------------------------------------------------------------
describe('validateRuleSet', () => {
  it('accepts a minimal valid ruleset', () => {
    const raw = { version: 1, rules: [] };
    const result = validateRuleSet(raw);
    expect('error' in result).toBe(false);
  });

  it('rejects null input', () => {
    const result = validateRuleSet(null);
    expect('error' in result).toBe(true);
  });

  it('rejects a primitive input', () => {
    const result = validateRuleSet(42);
    expect('error' in result).toBe(true);
  });

  it('strips unknown fields from rules (does not propagate them)', () => {
    const raw = {
      version: 1,
      rules: [{
        id: 'x',
        pattern: 'a',
        replacement: 'b',
        isRegex: false,
        caseSensitive: false,
        enabled: true,
        unknownField: 'should be ignored',
      }],
    };
    const result = validateRuleSet(raw);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect((result.rules[0] as Record<string, unknown>)['unknownField']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// enabled/disabled rule filtering (the caller pattern used in bulk-apply)
// ---------------------------------------------------------------------------
describe('enabled/disabled rule filtering', () => {
  it('filters to only enabled rules', () => {
    const rules = [
      makeRule({ id: '1', enabled: true }),
      makeRule({ id: '2', enabled: false }),
      makeRule({ id: '3', enabled: true }),
    ];
    const ruleSet = makeRuleSet(rules);
    const enabled = ruleSet.rules.filter((r) => r.enabled);
    expect(enabled).toHaveLength(2);
    expect(enabled.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('returns empty array when all rules are disabled', () => {
    const rules = [
      makeRule({ enabled: false }),
      makeRule({ enabled: false }),
    ];
    const ruleSet = makeRuleSet(rules);
    expect(ruleSet.rules.filter((r) => r.enabled)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createRule
// ---------------------------------------------------------------------------
describe('createRule', () => {
  it('creates a rule with default values', () => {
    const rule = createRule();
    expect(rule.pattern).toBe('');
    expect(rule.replacement).toBe('');
    expect(rule.isRegex).toBe(false);
    expect(rule.caseSensitive).toBe(false);
    expect(rule.enabled).toBe(true);
    expect(typeof rule.id).toBe('string');
    expect(rule.id.length).toBeGreaterThan(0);
  });

  it('accepts partial overrides', () => {
    const rule = createRule({ pattern: 'hello', isRegex: true });
    expect(rule.pattern).toBe('hello');
    expect(rule.isRegex).toBe(true);
    expect(rule.enabled).toBe(true);
  });

  it('generates unique IDs for each call', () => {
    const r1 = createRule();
    const r2 = createRule();
    expect(r1.id).not.toBe(r2.id);
  });
});
