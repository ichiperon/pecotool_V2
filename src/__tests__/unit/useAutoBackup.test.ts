/**
 * S-10: useAutoBackup の TypeGuard (isValidBackupData) を検証する。
 *
 * isValidBackupData は export されていないため、loadBackupData 経由で検証する:
 *   - invoke('load_backup', ...) が返す JSON 文字列を mock し、
 *   - loadBackupData が validation 失敗時に null を返すことを確認する。
 *
 * 起動時に呼ばれる check_pending_backups も mock しておく。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// useAutoBackup は store / pdfLoader 等を import するため、副作用を抑える mock
vi.mock('../../utils/pdfLoader', () => ({
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
}));

import { useAutoBackup, BackupData } from '../../hooks/useAutoBackup';

/** invoke('load_backup', ...) が指定 JSON 文字列を返すように設定 */
function mockLoadBackup(json: string) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'check_pending_backups') return [];
    if (cmd === 'load_backup') return json;
    return undefined;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  // デフォルト: check_pending_backups は空配列
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'check_pending_backups') return [];
    return undefined;
  });
});

/** loadBackupData を呼び出すヘルパー */
async function callLoadBackupData(): Promise<BackupData | null> {
  const { result } = renderHook(() => useAutoBackup(() => {}));
  let ret: BackupData | null = null;
  await act(async () => {
    ret = await result.current.loadBackupData('/dummy/path.pdf');
  });
  return ret;
}

const validBlock = {
  id: 'b1',
  text: 'hello',
  bbox: { x: 1, y: 2, width: 10, height: 20 },
  writingMode: 'horizontal',
  order: 0,
};

function makeBackup(pages: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    timestamp: '2024-01-01T00:00:00Z',
    originalFilePath: '/dummy/path.pdf',
    pages,
  });
}

describe('useAutoBackup loadBackupData (isValidBackupData via mocked invoke)', () => {
  it('S-10-01: 正常な backup JSON はパース成功', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [validBlock] },
      }),
    );
    const result = await callLoadBackupData();
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.pages['0']).toBeDefined();
  });

  it('S-10-02: __proto__ を pages のキーに含む JSON は reject', async () => {
    // JSON 文字列内に __proto__ を own property として書く
    const json =
      '{"version":1,"timestamp":"t","originalFilePath":"f","pages":{"__proto__":{"textBlocks":[]}}}';
    mockLoadBackup(json);
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-03a: constructor キーを含む pages は reject', async () => {
    mockLoadBackup(
      makeBackup({
        constructor: { textBlocks: [] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-03b: prototype キーを含む pages は reject', async () => {
    mockLoadBackup(
      makeBackup({
        prototype: { textBlocks: [] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-04a: bbox.x が文字列 ("NaN") の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': {
          textBlocks: [
            { ...validBlock, bbox: { x: 'NaN', y: 0, width: 10, height: 10 } },
          ],
        },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-04b: bbox.x が null の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': {
          textBlocks: [
            { ...validBlock, bbox: { x: null, y: 0, width: 10, height: 10 } },
          ],
        },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-04c: bbox.x が文字列 ("Infinity") の textBlock は reject', async () => {
    // JSON は Infinity リテラルを表現できないため文字列で食わせる
    mockLoadBackup(
      makeBackup({
        '0': {
          textBlocks: [
            { ...validBlock, bbox: { x: 'Infinity', y: 0, width: 10, height: 10 } },
          ],
        },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it("S-10-05a: writingMode が 'diagonal' の textBlock は reject", async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, writingMode: 'diagonal' }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-05b: writingMode が null の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, writingMode: null }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-05c: writingMode が 123 (数値) の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, writingMode: 123 }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-06a: order が負数 (-1) の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, order: -1 }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-06b: order が小数 (1.5) の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, order: 1.5 }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-06c: order が文字列 ("0") の textBlock は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [{ ...validBlock, order: '0' }] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-07: textBlocks が配列でない (オブジェクト) 場合は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: { foo: 'bar' } },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-08: ネスト構造 (pages[].textBlocks[].bbox) の途中で型違反があれば全体 reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { textBlocks: [validBlock] }, // 正常
        '1': {
          textBlocks: [
            validBlock,
            { ...validBlock, bbox: { x: 'bad', y: 0, width: 1, height: 1 } }, // 不正
          ],
        },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('version フィールドが文字列の場合は reject', async () => {
    const json =
      '{"version":"1","timestamp":"t","originalFilePath":"f","pages":{}}';
    mockLoadBackup(json);
    expect(await callLoadBackupData()).toBeNull();
  });

  it('originalFilePath が欠落している場合は reject', async () => {
    const json = '{"version":1,"timestamp":"t","pages":{}}';
    mockLoadBackup(json);
    expect(await callLoadBackupData()).toBeNull();
  });

  it('JSON.parse が失敗する不正文字列の場合は null', async () => {
    mockLoadBackup('{not-json');
    expect(await callLoadBackupData()).toBeNull();
  });

  it('pages が空オブジェクトでも (有効スキーマなら) パース成功', async () => {
    mockLoadBackup(makeBackup({}));
    const result = await callLoadBackupData();
    expect(result).not.toBeNull();
    expect(result?.pages).toEqual({});
  });
});
