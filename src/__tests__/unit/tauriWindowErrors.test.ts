import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isTauriWindowNotFoundError,
  logUnlessTauriWindowNotFound,
} from '../../utils/tauriWindowErrors';

describe('tauriWindowErrors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('window not found は Tauri のサブウィンドウ競合として判定する', () => {
    expect(isTauriWindowNotFoundError('window not found')).toBe(true);
    expect(isTauriWindowNotFoundError(new Error('Window not found'))).toBe(true);
  });

  it('window not found は console.error に出さない', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logUnlessTauriWindowNotFound(new Error('window not found'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('それ以外のエラーは console.error に残す', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('permission denied');

    logUnlessTauriWindowNotFound(err, '[test]');

    expect(spy).toHaveBeenCalledWith('[test]', err);
  });
});
