import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * perfLogger regression tests
 *
 * 主目的: production ビルドで perf.mark を呼んでも performance.mark (User Timing
 * バッファ) が呼ばれないことを保証する。
 *
 * 背景: User Timing バッファは無制限に蓄積されるため、bbox ドラッグなど
 * 高頻度操作で発火するとメモリリークの原因になる (issue #16)。
 */

type PerfModule = typeof import('../../utils/perfLogger');

async function loadPerf(opts: { dev: boolean; localStorage?: string | null }): Promise<PerfModule> {
  vi.resetModules();
  vi.stubEnv('DEV', opts.dev);
  vi.stubEnv('PROD', !opts.dev);

  // detectEnabled() は localStorage を参照する。pecoPerf を '1' に設定しておくことで
  // DEV/PROD のどちらでも enabled=true となり、mark() が pushEntry まで到達する。
  if (opts.localStorage === undefined || opts.localStorage === '1') {
    window.localStorage.setItem('pecoPerf', '1');
  } else if (opts.localStorage === null) {
    window.localStorage.removeItem('pecoPerf');
  } else {
    window.localStorage.setItem('pecoPerf', opts.localStorage);
  }

  return await import('../../utils/perfLogger');
}

describe('perfLogger', () => {
  // jsdom の performance には mark/clearMarks が無いため、テスト用に noop を差し込む。
  // ここで定義した関数を後段で spyOn する。
  let perfMarkSpy: ReturnType<typeof vi.fn>;
  const originalMark = (performance as unknown as { mark?: (n: string) => void }).mark;

  beforeEach(() => {
    perfMarkSpy = vi.fn();
    Object.defineProperty(performance, 'mark', {
      value: perfMarkSpy,
      configurable: true,
      writable: true,
    });
    window.localStorage.removeItem('pecoPerf');
  });

  afterEach(() => {
    // 元の状態に戻す (jsdom の場合 originalMark は undefined)
    if (originalMark === undefined) {
      delete (performance as unknown as { mark?: unknown }).mark;
    } else {
      Object.defineProperty(performance, 'mark', {
        value: originalMark,
        configurable: true,
        writable: true,
      });
    }
    vi.unstubAllEnvs();
    window.localStorage.removeItem('pecoPerf');
  });

  it('U-PL-01: production では mark() を 100 回呼んでも performance.mark を呼ばない (内部リングバッファのみ)', async () => {
    const { perf } = await loadPerf({ dev: false, localStorage: '1' });
    expect(perf.enabled).toBe(true);

    for (let i = 0; i < 100; i++) {
      perf.mark(`prod.iter.${i}`);
    }

    // production では performance.mark を 1 回も呼んではならない (N=1 未満)
    expect(perfMarkSpy).toHaveBeenCalledTimes(0);
    // 内部リングバッファは動いていること
    expect(perf.getEntries().length).toBe(100);
    expect(perf.getEntries()[0].label).toBe('prod.iter.0');
    expect(perf.getEntries()[99].label).toBe('prod.iter.99');
  });

  it('U-PL-02: development では mark() に応じて performance.mark を呼ぶ', async () => {
    const { perf } = await loadPerf({ dev: true, localStorage: '1' });
    expect(perf.enabled).toBe(true);

    perf.mark('dev.a');
    perf.mark('dev.b');

    expect(perfMarkSpy).toHaveBeenCalledTimes(2);
    expect(perfMarkSpy).toHaveBeenNthCalledWith(1, 'dev.a');
    expect(perfMarkSpy).toHaveBeenNthCalledWith(2, 'dev.b');
    expect(perf.getEntries().length).toBe(2);
  });

  it('U-PL-03: enabled=false (localStorage=off) では mark() は no-op', async () => {
    const { perf } = await loadPerf({ dev: false, localStorage: 'off' });
    expect(perf.enabled).toBe(false);

    perf.mark('disabled.x');

    expect(perfMarkSpy).toHaveBeenCalledTimes(0);
    expect(perf.getEntries()).toEqual([]);
  });

  it('U-PL-04: production でリングバッファ上限 (5000) を超えても performance.mark は呼ばれない', async () => {
    const { perf } = await loadPerf({ dev: false, localStorage: '1' });

    // 5000 を超えてもバッファは 5000 件で頭打ち、performance.mark は 0 回
    const N = 5050;
    for (let i = 0; i < N; i++) {
      perf.mark(`prod.bulk.${i}`);
    }

    expect(perfMarkSpy).toHaveBeenCalledTimes(0);
    expect(perf.getEntries().length).toBe(5000);
  });

  it('U-PL-05: enabled API (getter) は呼び出し側互換性を維持する', async () => {
    const { perf } = await loadPerf({ dev: false, localStorage: '1' });
    // boolean getter として動作すること
    expect(typeof perf.enabled).toBe('boolean');
    expect(perf.enabled).toBe(true);
  });

  it('U-PL-06: production でも localStorage 未設定なら default は disabled (issue #76)', async () => {
    // pecoPerf 未設定 / location.hash も #perf なし → opt-in されていない
    const { perf } = await loadPerf({ dev: false, localStorage: null });
    expect(perf.enabled).toBe(false);

    // mark しても push されない (hot path での object allocation を防ぐ)
    perf.mark('prod.default.x', { foo: 'bar' });
    expect(perf.getEntries()).toEqual([]);
    expect(perfMarkSpy).toHaveBeenCalledTimes(0);
  });

  it('U-PL-07: development でも localStorage 未設定なら default は disabled', async () => {
    const { perf } = await loadPerf({ dev: true, localStorage: null });
    expect(perf.enabled).toBe(false);
  });

  it('U-PL-08: localStorage.pecoPerf=1 で PROD でも opt-in 可能', async () => {
    const { perf } = await loadPerf({ dev: false, localStorage: '1' });
    expect(perf.enabled).toBe(true);
  });
});
