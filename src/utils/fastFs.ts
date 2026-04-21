import { invoke } from '@tauri-apps/api/core';

/**
 * Tauri plugin-fs の readFile より約 50-200 倍高速。
 * spawn_blocking で std::fs::read を直接呼ぶ。
 * @tauri-apps/plugin-fs が ~1MB/s しか出ない問題を回避。
 *
 * Tauri v2 の IPC は Vec<u8> を ArrayBuffer で返すのが通常だが、
 * 環境や経路により Uint8Array または number[] で返るケースがあるため
 * いずれの型でも安全に Uint8Array へ正規化する。
 */
export async function fastReadFile(filePath: string): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('fast_read_file', { filePath });
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(raw);
  throw new Error('[fastReadFile] unexpected response type: ' + typeof raw);
}
