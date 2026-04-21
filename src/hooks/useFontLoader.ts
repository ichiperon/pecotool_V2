import { logger } from '../utils/logger';

let fontBytesCache: ArrayBuffer | null = null;
let fontLoadPromise: Promise<ArrayBuffer | null> | null = null;

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
