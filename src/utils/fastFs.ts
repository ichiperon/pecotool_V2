import { invoke } from '@tauri-apps/api/core';

/**
 * Tauri plugin-fs の readFile より 180 倍以上高速。
 * spawn_blocking で std::fs::read を直接呼ぶ。
 *
 * Rust 側は `tauri::ipc::Response::new(Vec<u8>)` を返しており、
 * Tauri v2 の raw binary IPC 経路で JS 側は ArrayBuffer として受け取る。
 * これにより Vec<u8> を JSON number[] にシリアライズする ~180 秒級の
 * オーバーヘッドを回避できる。
 *
 * 実行環境差で Uint8Array / number[] が返る可能性に備えたフォールバックも保持。
 */
export async function fastReadFile(filePath: string): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('fast_read_file', { filePath });
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw);
  throw new Error('[fastReadFile] unexpected response type: ' + typeof raw);
}
