/**
 * tauriFileIO utility のユニットテスト。
 *
 * - writeFileChunked が chunk size 上限で分割呼び出しされること
 * - 小さな bytes (chunk size 以下) は 1 回の invoke で完了すること
 * - 空 bytes (byteLength === 0) でも offset=0 で 1 回 invoke されること
 * - isWriteAccessError が EACCES / EPERM 系メッセージを検出すること
 * - isWriteAccessError が他のエラーで false を返すこと
 * - readFileSafe が @tauri-apps/plugin-fs readFile を委譲すること (wave 8)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import {
  writeFileChunked,
  writeFileAtomically,
  cleanupStalePdfTempFiles,
  isWriteAccessError,
  readFileSafe,
} from '../../utils/tauriFileIO';

const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(undefined));
});

describe('writeFileChunked', () => {
  it('空 bytes (byteLength === 0) でも write_pdf_chunk を offset=0 で 1 回呼ぶ', async () => {
    const bytes = new Uint8Array(0);
    await writeFileChunked('/test/empty.pdf', bytes);

    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    expect(calls.length).toBe(1);
    const [, body, opts] = calls[0] as [string, ArrayBuffer, { headers: Record<string, string> }];
    expect(opts.headers['x-offset']).toBe('0');
    expect(body.byteLength).toBe(0);
  });

  it('chunk size 以下の bytes は 1 回の invoke で完了する', async () => {
    const bytes = new Uint8Array(100).fill(0xab);
    await writeFileChunked('/test/small.pdf', bytes);

    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    expect(calls.length).toBe(1);
    const [, , opts] = calls[0] as [string, ArrayBuffer, { headers: Record<string, string> }];
    expect(opts.headers['x-offset']).toBe('0');
  });

  it('chunk size (4MB) を超える bytes は複数回に分割して invoke される', async () => {
    const CHUNK = 4 * 1024 * 1024; // 4MB
    const size = CHUNK + 1; // 4MB + 1 byte -> 2 回
    const bytes = new Uint8Array(size).fill(0x01);
    await writeFileChunked('/test/large.pdf', bytes);

    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    expect(calls.length).toBe(2);

    // 1 回目: offset=0
    const [, , opts0] = calls[0] as [string, ArrayBuffer, { headers: Record<string, string> }];
    expect(opts0.headers['x-offset']).toBe('0');

    // 2 回目: offset=CHUNK
    const [, , opts1] = calls[1] as [string, ArrayBuffer, { headers: Record<string, string> }];
    expect(opts1.headers['x-offset']).toBe(String(CHUNK));
  });

  it('パスが encodeURIComponent されて x-path ヘッダに渡される', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFileChunked('/path/with spaces/file.pdf', bytes);

    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    expect(calls.length).toBe(1);
    const [, , opts] = calls[0] as [string, ArrayBuffer, { headers: Record<string, string> }];
    expect(opts.headers['x-path']).toBe(encodeURIComponent('/path/with spaces/file.pdf'));
  });
});

describe('writeFileAtomically', () => {
  it('一時ファイルへの writeFileChunked の後に replace_pdf_file を呼ぶ', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await writeFileAtomically('/out/final.pdf', bytes);

    const chunkCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    const replaceCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'replace_pdf_file');

    // write_pdf_chunk が先に呼ばれる
    expect(chunkCalls.length).toBeGreaterThanOrEqual(1);
    // replace_pdf_file が 1 回呼ばれる
    expect(replaceCalls.length).toBe(1);

    // 呼び出し順を確認: write_pdf_chunk の最後のインデックス < replace_pdf_file のインデックス
    const lastChunkIdx = invokeMock.mock.calls.findLastIndex(([cmd]) => cmd === 'write_pdf_chunk');
    const replaceIdx = invokeMock.mock.calls.findIndex(([cmd]) => cmd === 'replace_pdf_file');
    expect(lastChunkIdx).toBeLessThan(replaceIdx);

    // replace_pdf_file の args に targetPath が含まれる
    const [, replaceArgs] = replaceCalls[0] as [string, { tempPath: string; targetPath: string }];
    expect(replaceArgs.targetPath).toBe('/out/final.pdf');

    // tempPath は '.pecotool-' を含む一時パス
    expect(replaceArgs.tempPath).toContain('.pecotool-');
    expect(replaceArgs.tempPath).toContain('.tmp');
  });

  // ── AZKi C-1: 保存一時ファイル残骸の掃除経路 ──────────────────────

  it('保存成功後に cleanup_stale_pdf_temp_files を対象パスで fire-and-forget 呼び出しする', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await writeFileAtomically('/out/final.pdf', bytes);

    // writeFileAtomically は cleanup を待たずに resolve するため、マイクロタスクを
    // 1 周させて fire-and-forget の invoke 呼び出しを確定させる。
    await Promise.resolve();

    const cleanupCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'cleanup_stale_pdf_temp_files');
    expect(cleanupCalls.length).toBe(1);
    const [, cleanupArgs] = cleanupCalls[0] as [string, { targetPath: string }];
    expect(cleanupArgs.targetPath).toBe('/out/final.pdf');
  });

  it('write_pdf_chunk 段階 (rename 未試行) の失敗では remove_pdf_temp_file で即座に temp を削除し、元エラーを再送出する', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'write_pdf_chunk') return Promise.reject(new Error('disk full'));
      return Promise.resolve(undefined);
    });

    await expect(writeFileAtomically('/out/final.pdf', new Uint8Array([1, 2, 3]))).rejects.toThrow('disk full');

    const removeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'remove_pdf_temp_file');
    expect(removeCalls.length).toBe(1);
    const [, removeArgs] = removeCalls[0] as [string, { tempPath: string }];
    expect(removeArgs.tempPath).toContain('.pecotool-');
    expect(removeArgs.tempPath).toContain('.tmp');

    // rename (replace_pdf_file) は一度も試みられていないこと
    const replaceCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'replace_pdf_file');
    expect(replaceCalls.length).toBe(0);
  });

  it('remove_pdf_temp_file 自体が失敗しても、書き込み失敗の元エラーが優先してスローされる', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'write_pdf_chunk') return Promise.reject(new Error('disk full'));
      if (cmd === 'remove_pdf_temp_file') return Promise.reject(new Error('cleanup also failed'));
      return Promise.resolve(undefined);
    });

    await expect(writeFileAtomically('/out/final.pdf', new Uint8Array([1, 2, 3]))).rejects.toThrow('disk full');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rename (replace_pdf_file) 失敗時は temp を削除せず (remove_pdf_temp_file 未呼出)、元エラーを再送出する', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') return Promise.reject(new Error('rename temp->target failed: sharing violation'));
      return Promise.resolve(undefined);
    });

    await expect(writeFileAtomically('/out/final.pdf', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'rename temp->target failed',
    );

    const removeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'remove_pdf_temp_file');
    expect(removeCalls.length).toBe(0);
    const cleanupCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'cleanup_stale_pdf_temp_files');
    expect(cleanupCalls.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('cleanupStalePdfTempFiles', () => {
  it('cleanup_stale_pdf_temp_files を targetPath で呼ぶ', async () => {
    await cleanupStalePdfTempFiles('/docs/report.pdf');

    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'cleanup_stale_pdf_temp_files');
    expect(calls.length).toBe(1);
    const [, args] = calls[0] as [string, { targetPath: string }];
    expect(args.targetPath).toBe('/docs/report.pdf');
  });

  it('invoke が失敗しても例外を伝播させない (fire-and-forget)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation(() => Promise.reject(new Error('scope error')));

    await expect(cleanupStalePdfTempFiles('/docs/report.pdf')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('isWriteAccessError', () => {
  it('EACCES を検出する', () => {
    expect(isWriteAccessError('EACCES: permission denied')).toBe(true);
    expect(isWriteAccessError('eacces')).toBe(true);
  });

  it('EBUSY を検出する', () => {
    expect(isWriteAccessError('EBUSY: resource busy or locked')).toBe(true);
    expect(isWriteAccessError('ebusy')).toBe(true);
  });

  it('access is denied を検出する', () => {
    expect(isWriteAccessError('Access is denied.')).toBe(true);
    expect(isWriteAccessError('access is denied')).toBe(true);
  });

  it('permission denied を検出する', () => {
    expect(isWriteAccessError('permission denied')).toBe(true);
  });

  it('being used by another process を検出する', () => {
    expect(isWriteAccessError('The process cannot access the file because it is being used by another process')).toBe(true);
  });

  it('sharing violation を検出する', () => {
    expect(isWriteAccessError('sharing violation')).toBe(true);
  });

  it('lock violation を検出する', () => {
    expect(isWriteAccessError('lock violation')).toBe(true);
  });

  it('os error 32 (Windows sharing violation) を検出する', () => {
    expect(isWriteAccessError('os error 32')).toBe(true);
  });

  it('os error 33 (Windows lock violation) を検出する', () => {
    expect(isWriteAccessError('os error 33')).toBe(true);
  });

  it('os error 32 でも単語境界で正しく検出する (os error 320 は検出しない)', () => {
    expect(isWriteAccessError('os error 320')).toBe(false);
  });

  // ── issue #363: 日本語 Windows の os error 5 (ERROR_ACCESS_DENIED) 対応 ──

  it('os error 5 (ERROR_ACCESS_DENIED) を英語フレーズなしでも番号照合で検出する', () => {
    expect(isWriteAccessError('os error 5')).toBe(true);
  });

  it('日本語 Windows のロケール依存メッセージ「アクセスが拒否されました。 (os error 5)」を検出する', () => {
    // Rust std::io::Error の Display は日本語 Windows では英語フレーズを含まないため、
    // 'access is denied' / 'permission denied' 等の文字列照合は全てすり抜ける。
    // 番号照合 (os error 5) のみが検知経路になる。
    expect(isWriteAccessError('アクセスが拒否されました。 (os error 5)')).toBe(true);
  });

  it('日本語 Windows で write_pdf_chunk / replace_pdf_file 相当のラップメッセージでも検出する', () => {
    expect(
      isWriteAccessError('ファイルの書き込みに失敗しました: アクセスが拒否されました。 (os error 5)'),
    ).toBe(true);
    expect(
      isWriteAccessError('rename target->backup failed: アクセスが拒否されました。 (os error 5)'),
    ).toBe(true);
  });

  it('os error 19 (ERROR_WRITE_PROTECT) を検出する', () => {
    expect(isWriteAccessError('os error 19')).toBe(true);
    expect(isWriteAccessError('書き込み禁止になっています。 (os error 19)')).toBe(true);
  });

  it('os error 1224 (ERROR_USER_MAPPED_FILE) を検出する', () => {
    expect(isWriteAccessError('os error 1224')).toBe(true);
  });

  it('os error 5 でも単語境界で正しく検出する (os error 50 / os error 15 は検出しない)', () => {
    expect(isWriteAccessError('os error 50')).toBe(false);
    expect(isWriteAccessError('os error 15')).toBe(false);
    expect(isWriteAccessError('os error 51')).toBe(false);
  });

  it('os error 19 でも単語境界で正しく検出する (os error 190 は検出しない)', () => {
    expect(isWriteAccessError('os error 190')).toBe(false);
  });

  it('os error 1224 でも単語境界で正しく検出する (os error 12245 は検出しない)', () => {
    expect(isWriteAccessError('os error 12245')).toBe(false);
  });

  it('無関係な os error 番号は false を返す (os error 2 = ERROR_FILE_NOT_FOUND)', () => {
    expect(isWriteAccessError('os error 2')).toBe(false);
    expect(isWriteAccessError('指定されたファイルが見つかりません。 (os error 2)')).toBe(false);
  });

  it('無関係なエラーメッセージは false を返す', () => {
    expect(isWriteAccessError('ENOENT: no such file or directory')).toBe(false);
    expect(isWriteAccessError('network error')).toBe(false);
    expect(isWriteAccessError('')).toBe(false);
  });

  it('大文字小文字を区別しない', () => {
    expect(isWriteAccessError('PERMISSION DENIED')).toBe(true);
    expect(isWriteAccessError('Sharing Violation')).toBe(true);
  });
});

// ── readFileSafe (wave 8 / issue #253) ────────────────────────────────────

describe('readFileSafe', () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it('readFile の結果をそのまま返す (happy path)', async () => {
    const expected = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    readFileMock.mockResolvedValue(expected);

    const result = await readFileSafe('/docs/sample.pdf');

    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledWith('/docs/sample.pdf');
    expect(result).toBe(expected);
  });

  it('空 Uint8Array でも返す (空ファイル)', async () => {
    const empty = new Uint8Array(0);
    readFileMock.mockResolvedValue(empty);

    const result = await readFileSafe('/empty.bin');

    expect(result.byteLength).toBe(0);
  });

  it('readFile が reject した場合は例外を再スローする', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(readFileSafe('/missing.pdf')).rejects.toThrow('ENOENT');
  });

  it('パスがそのまま readFile に渡される (encoding なし)', async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1]));

    await readFileSafe('/path/with spaces/file.pdf');

    expect(readFileMock).toHaveBeenCalledWith('/path/with spaces/file.pdf');
  });

  it('大きなファイル (1MB) でも返す', async () => {
    const large = new Uint8Array(1024 * 1024).fill(0xab);
    readFileMock.mockResolvedValue(large);

    const result = await readFileSafe('/large.pdf');

    expect(result.byteLength).toBe(1024 * 1024);
    expect(result[0]).toBe(0xab);
  });
});
