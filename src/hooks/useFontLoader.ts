import { invoke } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';

let fontBytesCache: ArrayBuffer | null = null;
let fontLoadPromise: Promise<ArrayBuffer | null> | null = null;
let fallbackFontBytesCache: ArrayBuffer[] | null = null;
let fallbackFontLoadPromise: Promise<ArrayBuffer[] | null> | null = null;
let primaryFontKind: 'meiryo' | 'noto-cjk' | null = null;

const BASE_FALLBACK_FONT_PATHS = [
  '/fonts/IPAmjMincho.ttf',
  '/fonts/NotoSans-Regular.ttf',
  '/fonts/NotoSansSymbols-Regular.ttf',
  '/fonts/NotoSansSymbols2-Regular.ttf',
];

function getFallbackFontPaths(): string[] {
  if (primaryFontKind === 'noto-cjk') return BASE_FALLBACK_FONT_PATHS;
  return [
    '/fonts/IPAmjMincho.ttf',
    '/fonts/NotoSansCJKjp-Regular.otf',
    '/fonts/NotoSans-Regular.ttf',
    '/fonts/NotoSansSymbols-Regular.ttf',
    '/fonts/NotoSansSymbols2-Regular.ttf',
  ];
}

function toArrayBuffer(bytes: number[] | Uint8Array): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function loadBundledNotoCjkFont(): Promise<ArrayBuffer | null> {
  const res = await fetch('/fonts/NotoSansCJKjp-Regular.otf');
  if (!res.ok) {
    console.error('[loadFontLazy] Failed to fetch bundled font: status', res.status);
    return null;
  }
  primaryFontKind = 'noto-cjk';
  return res.arrayBuffer();
}

/**
 * フォントを遅延ロードする。初回呼び出し時にfetchし、以降はキャッシュを返す。
 */
export async function loadFontLazy(): Promise<ArrayBuffer | null> {
  if (fontBytesCache) return fontBytesCache;
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    try {
      try {
        const meiryoBytes = await invoke<number[] | Uint8Array>('load_meiryo_font');
        fontBytesCache = toArrayBuffer(meiryoBytes);
        primaryFontKind = 'meiryo';
        fontLoadPromise = null;
        logger.log('[loadFontLazy] Meiryo font loaded successfully');
        return fontBytesCache;
      } catch (err) {
        console.warn('[loadFontLazy] Meiryo unavailable; falling back to bundled Noto Sans CJK JP:', err);
      }

      fontBytesCache = await loadBundledNotoCjkFont();
      fontLoadPromise = null;
      if (fontBytesCache) logger.log('[loadFontLazy] Bundled Noto Sans CJK JP loaded successfully');
      return fontBytesCache;
    } catch (err) {
      console.error('[loadFontLazy] Error loading font:', err);
      fontLoadPromise = null; // リトライ可能にする
      return null;
    }
  })();

  return fontLoadPromise;
}

export async function loadFallbackFontsLazy(): Promise<ArrayBuffer[] | null> {
  if (fallbackFontBytesCache) return fallbackFontBytesCache;
  if (fallbackFontLoadPromise) return fallbackFontLoadPromise;

  fallbackFontLoadPromise = (async () => {
    try {
      const buffers: ArrayBuffer[] = [];
      for (const path of getFallbackFontPaths()) {
        const res = await fetch(path);
        if (!res.ok) {
          console.error('[loadFallbackFontsLazy] Failed to fetch font:', path, res.status);
          fallbackFontLoadPromise = null;
          return null;
        }
        buffers.push(await res.arrayBuffer());
      }
      fallbackFontBytesCache = buffers;
      fallbackFontLoadPromise = null;
      logger.log('[loadFallbackFontsLazy] Fallback fonts loaded successfully');
      return fallbackFontBytesCache;
    } catch (err) {
      console.error('[loadFallbackFontsLazy] Error loading fallback fonts:', err);
      fallbackFontLoadPromise = null;
      return null;
    }
  })();

  return fallbackFontLoadPromise;
}
