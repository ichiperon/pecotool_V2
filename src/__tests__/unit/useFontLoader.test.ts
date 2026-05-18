/**
 * useFontLoader: loadFallbackFontsLazy が loadFontLazy 完了前に呼ばれても
 * primaryFontKind 確定後の fallback パスを選ぶことを検証する。
 *
 * Bug: loadFallbackFontsLazy を loadFontLazy 完了前に呼ぶと、primaryFontKind が
 *      null のため getFallbackFontPaths が IPAmjMincho.ttf を含まない結果を返し、
 *      そのまま fallbackFontBytesCache に固定されてしまう。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// invoke (load_meiryo_font) を成功させるための mock
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'load_meiryo_font') {
      // 適当な ttf bytes (空でも cache に入ればよい)
      return new Uint8Array([0x00, 0x01, 0x00, 0x00]);
    }
    return undefined;
  }),
}));

describe('useFontLoader loadFallbackFontsLazy 並列呼び出し', () => {
  beforeEach(async () => {
    // モジュール内モジュール状態をリセット
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('loadFontLazy と並列に loadFallbackFontsLazy を呼んでも IPAmjMincho を含む fallback が選ばれる', async () => {
    const { loadFontLazy, loadFallbackFontsLazy, getPrimaryFontKind } =
      await import('../../hooks/useFontLoader');

    // fetch を spy/stub: 何が要求されたかを後で検証する
    const fetchedPaths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const path = typeof input === 'string' ? input : String(input);
      fetchedPaths.push(path);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response;
    });

    // 並列起動 (loadFontLazy 完了前に loadFallbackFontsLazy を発火)
    const [fontBytes, fallbackBuffers] = await Promise.all([
      loadFontLazy(),
      loadFallbackFontsLazy(),
    ]);

    expect(fontBytes).not.toBeNull();
    expect(fallbackBuffers).not.toBeNull();
    expect(getPrimaryFontKind()).toBe('meiryo');

    // Meiryo が primary になった場合は IPAmjMincho が fallback 配列の先頭に入る
    expect(fetchedPaths).toContain('/fonts/IPAmjMincho.ttf');
    expect(fetchedPaths).toContain('/fonts/NotoSans-Regular.ttf');
    expect(fetchedPaths).toContain('/fonts/NotoSansSymbols-Regular.ttf');
    expect(fetchedPaths).toContain('/fonts/NotoSansSymbols2-Regular.ttf');

    // fallback バッファは 4 枚 (IPAmjMincho + Symbol 3 枚)
    expect(fallbackBuffers!.length).toBe(4);

    fetchSpy.mockRestore();
  });

  it('disableSystemFontForSession 経由で ipamj が primary の場合は IPAmjMincho を重複ロードしない', async () => {
    const { loadFontLazy, loadFallbackFontsLazy, disableSystemFontForSession, getPrimaryFontKind } =
      await import('../../hooks/useFontLoader');

    disableSystemFontForSession();

    const fetchedPaths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const path = typeof input === 'string' ? input : String(input);
      fetchedPaths.push(path);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response;
    });

    const [fontBytes, fallbackBuffers] = await Promise.all([
      loadFontLazy(),
      loadFallbackFontsLazy(),
    ]);

    expect(fontBytes).not.toBeNull();
    expect(fallbackBuffers).not.toBeNull();
    expect(getPrimaryFontKind()).toBe('ipamj');

    // ipamj の場合は fallback に IPAmjMincho は含まれない (Symbol fonts のみ)
    const ipamjFallbackCount = fetchedPaths.filter(p => p === '/fonts/IPAmjMincho.ttf').length;
    // primary 用 1 回のみ (fallback では fetch されない)
    expect(ipamjFallbackCount).toBe(1);
    expect(fallbackBuffers!.length).toBe(3);

    fetchSpy.mockRestore();
  });
});
