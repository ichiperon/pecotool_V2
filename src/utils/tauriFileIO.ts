import { invoke } from '@tauri-apps/api/core';

/**
 * Rust 側 `write_pdf_chunk` コマンドを使って bytes を分割書き込みする。
 *
 * Tauri v2 の IPC binary 転送が 100MB 一発だと hang する事象を回避するため、
 * 4MB 単位でチャンクして invoke する。Rust 側は raw body (tauri::ipc::Request) を
 * 受けるため JSON シリアライズは発生しない。
 *
 * bytes.byteLength === 0 の場合でも offset==0 で 1 回だけ呼び、
 * Rust 側 (offset==0 で create+truncate) に空ファイル生成を任せる。
 */
export async function writeFileChunked(path: string, bytes: Uint8Array): Promise<void> {
  const CHUNK = 4 * 1024 * 1024; // 4MB
  const headerPath = encodeURIComponent(path);
  if (bytes.byteLength === 0) {
    await invoke('write_pdf_chunk', new ArrayBuffer(0), {
      headers: {
        'x-path': headerPath,
        'x-offset': '0',
      },
    });
    return;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.byteLength);
    // subarray はビューを返すだけ (copy しない)
    const chunk = bytes.subarray(offset, end);
    // subarray の buffer は元 bytes の buffer を指すため、byteOffset/byteLength を
    // 考慮した slice を取ってから .buffer を渡す (native IPC は ArrayBuffer を期待)。
    const body = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk.buffer
      : chunk.slice().buffer;
    await invoke('write_pdf_chunk', body, {
      headers: {
        'x-path': headerPath,
        'x-offset': String(offset),
      },
    });
  }
}

/**
 * 一時ファイル → atomic rename で write を完了する。
 * 中断/クラッシュ時の半書き出しを防止する。
 */
export async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${path}.pecotool-${Date.now()}-${crypto.randomUUID()}.tmp`;
  await writeFileChunked(tempPath, bytes);
  await invoke('replace_pdf_file', { tempPath, targetPath: path });
}

/**
 * Rust 側エラーメッセージから「上書き不可」系の障害を検出する。
 * Windows では他プロセス (Acrobat 等) がファイルを掴んでいると EACCES/EBUSY/
 * ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) が返るため、
 * これらを「別名で保存」フォールバックの引き金にする。
 *
 * Rust 側は std::io::Error の英文メッセージや `os error 32` 番号を含む文字列を
 * 返してくる。コード番号 (os error 32) や英語フレーズの両方で検出できるように
 * 緩めの正規表現でマッチする。
 */
export function isWriteAccessError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('eacces') ||
    lower.includes('ebusy') ||
    lower.includes('access is denied') ||
    lower.includes('permission denied') ||
    lower.includes('being used by another process') ||
    lower.includes('sharing violation') ||
    lower.includes('lock violation') ||
    /os error (32|33)\b/.test(lower)
  );
}
