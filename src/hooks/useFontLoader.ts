import { invoke } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';

let fontBytesCache: ArrayBuffer | null = null;
let fontLoadPromise: Promise<ArrayBuffer | null> | null = null;
let fallbackFontBytesCache: ArrayBuffer[] | null = null;
let fallbackFontLoadPromise: Promise<ArrayBuffer[] | null> | null = null;
let primaryFontKind: 'meiryo' | 'ipamj' | null = null;
let systemFontDisabledForSession = false;

const SYMBOL_FALLBACK_FONT_PATHS = [
  '/fonts/NotoSans-Regular.ttf',
  '/fonts/NotoSansSymbols-Regular.ttf',
  '/fonts/NotoSansSymbols2-Regular.ttf',
];

function getFallbackFontPaths(): string[] {
  if (primaryFontKind === 'meiryo') return ['/fonts/IPAmjMincho.ttf', ...SYMBOL_FALLBACK_FONT_PATHS];
  return SYMBOL_FALLBACK_FONT_PATHS;
}

// PCT-199 AQ-8: load_meiryo_font は tauri::ipc::Response で raw binary を返すようになった
// (JSON number 配列だと数MBフォントのシリアライズで大きなヒープスパイクが起きるため)。
// raw binary 応答の invoke は ArrayBuffer を返す。旧来の number[]/Uint8Array 応答
// (JSON 経路) にも後方互換で対応しておく。
function toArrayBuffer(bytes: ArrayBuffer | number[] | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function getPrimaryFontKind(): 'meiryo' | 'ipamj' | null {
  return primaryFontKind;
}

export function disableSystemFontForSession(): void {
  systemFontDisabledForSession = true;
  fontBytesCache = null;
  fontLoadPromise = null;
  fallbackFontBytesCache = null;
  fallbackFontLoadPromise = null;
  primaryFontKind = null;
}

// issue #142: pure fetch ヘルパ。成功時のみ ArrayBuffer を返し、cache や
// primaryFontKind には一切触らない。失敗を null で返してリトライ可能にしつつ、
// caller (loadFontLazy) 側で「成功した時だけ」cache を更新する責務に統一する。
export async function loadBundledIpAmjFontLazy(): Promise<ArrayBuffer | null> {
  const res = await fetch('/fonts/IPAmjMincho.ttf');
  if (!res.ok) {
    console.error('[loadFontLazy] Failed to fetch bundled font: status', res.status);
    return null;
  }
  return await res.arrayBuffer();
}

/**
 * フォントを遅延ロードする。初回呼び出し時にfetchし、以降はキャッシュを返す。
 */
export async function loadFontLazy(): Promise<ArrayBuffer | null> {
  if (fontBytesCache) return fontBytesCache;
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    try {
      if (!systemFontDisabledForSession) {
        try {
          const meiryoBytes = await invoke<ArrayBuffer | number[] | Uint8Array>('load_meiryo_font');
          fontBytesCache = toArrayBuffer(meiryoBytes);
          primaryFontKind = 'meiryo';
          fontLoadPromise = null;
          logger.log('[loadFontLazy] Meiryo font loaded successfully');
          return fontBytesCache;
        } catch (err) {
          console.warn('[loadFontLazy] Meiryo unavailable; falling back to bundled IPAmjMincho:', err);
        }
      }

      // issue #142: loadBundledIpAmjFontLazy が null を返した場合は cache を
      // 上書きせず、primaryFontKind も触らない (次回呼び出しでリトライ可能にする)。
      const bundled = await loadBundledIpAmjFontLazy();
      fontLoadPromise = null;
      if (bundled) {
        fontBytesCache = bundled;
        primaryFontKind = 'ipamj';
        logger.log('[loadFontLazy] Bundled IPAmjMincho loaded successfully');
      }
      return fontBytesCache;
    } catch (err) {
      console.error('[loadFontLazy] Error loading font:', err);
      // issue #52: 失敗時にリトライ可能にするだけでなく、副作用で書かれた可能性のある
      // 中間状態 (primaryFontKind, fallback cache) も完全に巻き戻す。
      // そうしないと次回 loadFallbackFontsLazy が古い primaryFontKind を見て
      // フォールバック配列を誤った組み合わせで固定化してしまう。
      fontLoadPromise = null;
      fontBytesCache = null;
      primaryFontKind = null;
      fallbackFontBytesCache = null;
      fallbackFontLoadPromise = null;
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
      // primary フォント (Meiryo / IPAmjMincho) を先に確定させてから fallback パスを決める。
      // これを await しないと並列呼び出し時に primaryFontKind が null のままで
      // Meiryo 環境でも IPAmjMincho.ttf が fallback に含まれない状態でキャッシュされる。
      await loadFontLazy();
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
