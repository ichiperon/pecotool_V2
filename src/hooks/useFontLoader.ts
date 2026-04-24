import { logger } from '../utils/logger';

let fontBytesCache: ArrayBuffer | null = null;
let fontLoadPromise: Promise<ArrayBuffer | null> | null = null;
let fallbackFontBytesCache: ArrayBuffer[] | null = null;
let fallbackFontLoadPromise: Promise<ArrayBuffer[] | null> | null = null;

const FALLBACK_FONT_PATHS = [
  '/fonts/NotoSans-Regular.ttf',
  '/fonts/NotoSansSymbols-Regular.ttf',
  '/fonts/NotoSansSymbols2-Regular.ttf',
];

/**
 * フォントを遅延ロードする。初回呼び出し時にfetchし、以降はキャッシュを返す。
 */
export async function loadFontLazy(): Promise<ArrayBuffer | null> {
  if (fontBytesCache) return fontBytesCache;
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    try {
      // pdf-lib/fontkit は WOFF2 を直接食わせると loca/glyf 出力が破損するため、
      // ビルド時に decompress しておいた TTF を使う。
      // public/fonts/IPAexGothic.ttf は wawoff2 で生成 (test-scratch/decompress_font.mjs)。
      const res = await fetch('/fonts/IPAexGothic.ttf');
      if (res.ok) {
        fontBytesCache = await res.arrayBuffer();
        fontLoadPromise = null;
        logger.log('[loadFontLazy] Font loaded successfully');
        return fontBytesCache;
      } else {
        console.error('[loadFontLazy] Failed to fetch font: status', res.status);
        fontLoadPromise = null;
        return null;
      }
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
      for (const path of FALLBACK_FONT_PATHS) {
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
