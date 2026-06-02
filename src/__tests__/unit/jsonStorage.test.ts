import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getJson, setJson, removeJson } from '../../utils/jsonStorage';

// jsdom provides localStorage; reset between tests
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('getJson', () => {
  it('returns null when key is absent', () => {
    expect(getJson('missing')).toBeNull();
  });

  it('parses a stored JSON value', () => {
    localStorage.setItem('key', JSON.stringify({ a: 1 }));
    expect(getJson<{ a: number }>('key')).toEqual({ a: 1 });
  });

  it('returns null when stored value is malformed JSON', () => {
    localStorage.setItem('key', 'not-json{{{');
    expect(getJson('key')).toBeNull();
  });
});

describe('setJson', () => {
  it('serializes and stores a value', () => {
    setJson('key', { x: 42 });
    expect(JSON.parse(localStorage.getItem('key')!)).toEqual({ x: 42 });
  });

  it('does not throw when localStorage.setItem throws (e.g. quota exceeded)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => setJson('key', 'value')).not.toThrow();
  });
});

describe('removeJson', () => {
  it('removes a stored key', () => {
    localStorage.setItem('key', 'value');
    removeJson('key');
    expect(localStorage.getItem('key')).toBeNull();
  });

  it('does not throw when key does not exist', () => {
    expect(() => removeJson('nonexistent')).not.toThrow();
  });

  it('does not throw when localStorage.removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage error');
    });
    expect(() => removeJson('key')).not.toThrow();
  });
});
