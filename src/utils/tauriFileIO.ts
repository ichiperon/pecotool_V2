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
 *
 * AZKi C-1: 失敗/中断した保存の `.pecotool-<uuid>.tmp` がユーザーの保存先フォルダに
 * 永久に残り続けないよう、2つの掃除経路を持つ:
 * - rename (`replace_pdf_file`) を試みる前の書き込み失敗は、温存する理由がないため
 *   即座に削除する。
 * - rename 自体の失敗は Rust 側の設計判断で temp をデータ救済のため残すため削除せず、
 *   パスを可視化するだけに留める。
 * - 保存が成功した場合は、同名の隣に残っている過去の失敗/中断分の temp を
 *   fire-and-forget で掃除する（保存自体の成否には影響させない）。
 */
export async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${path}.pecotool-${Date.now()}-${crypto.randomUUID()}.tmp`;

  try {
    await writeFileChunked(tempPath, bytes);
  } catch (writeError) {
    // rename は一度も試みられていない。温存する理由がないため即座に削除する。
    try {
      await invoke('remove_pdf_temp_file', { tempPath });
    } catch (cleanupError) {
      console.warn(
        `[writeFileAtomically] failed to remove temp file after write failure: ${tempPath}`,
        cleanupError,
      );
    }
    throw writeError;
  }

  try {
    await invoke('replace_pdf_file', { tempPath, targetPath: path });
  } catch (replaceError) {
    // rename 失敗時は Rust 側の設計判断で temp をデータ救済のため残す
    // (replace_target_with_temp_inner のコメント参照)。削除はせず可視化のみ行う。
    console.warn(
      `[writeFileAtomically] replace_pdf_file failed; temp file kept for recovery at: ${tempPath}`,
    );
    throw replaceError;
  }

  // 保存成功: 隣接する過去の失敗/中断分の temp を fire-and-forget で掃除する。
  void cleanupStalePdfTempFiles(path);
}

/**
 * `path` に隣接する、失敗/中断済みの `.pecotool-*.tmp` の残骸を掃除する。
 *
 * fire-and-forget を想定しており、失敗しても呼び出し元へは伝播させない
 * (掃除できなくても次回の掃除機会・起動時掃除等でリカバリ可能なため)。
 */
export async function cleanupStalePdfTempFiles(path: string): Promise<void> {
  try {
    await invoke('cleanup_stale_pdf_temp_files', { targetPath: path });
  } catch (e) {
    console.warn(`[cleanupStalePdfTempFiles] failed for: ${path}`, e);
  }
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
