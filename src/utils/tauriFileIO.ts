import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';

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
 * issue #253: single entry-point for reading files via Tauri fs plugin.
 * Centralises the import so hooks/components do not directly depend on
 * @tauri-apps/plugin-fs, making the boundary easy to mock in tests.
 */
export async function readFileSafe(path: string): Promise<Uint8Array> {
  return readFile(path);
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
 * Rust std::io::Error の Display は Windows ではロケール依存メッセージ +
 * `(os error N)` を返す。日本語 Windows では ERROR_ACCESS_DENIED が
 * 「アクセスが拒否されました。 (os error 5)」のように出力され、英語フレーズ
 * 照合をすり抜けるため、`os error` の番号照合をロケールに依存しない
 * フォールバックとして併用する (issue #363)。
 *
 * 番号は以下を対象にする:
 *   5    = ERROR_ACCESS_DENIED (読み取り専用属性・権限不足を含む)
 *   19   = ERROR_WRITE_PROTECT
 *   32   = ERROR_SHARING_VIOLATION (他プロセスがファイルを占有)
 *   33   = ERROR_LOCK_VIOLATION
 *   1224 = ERROR_USER_MAPPED_FILE
 *
 * os error 5 は純粋な権限不足 (書込先フォルダの ACL 不足など) でも発生しうるが、
 * その場合も「別名で保存」への誘導は妥当な救済導線であるため、番号だけで
 * ロック検知と権限不足を区別する必要はない。
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
    /os error (5|19|32|33|1224)\b/.test(lower)
  );
}
