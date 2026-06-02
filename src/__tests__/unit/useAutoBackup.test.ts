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
import type React from 'react';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// useAutoBackup は store / pdfLoader 等を import するため、副作用を抑える mock
// performBackup 経由のテスト (#24 関連) でも getAllTemporaryPageData は空 Map を返す。
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
}));

import { useAutoBackup, BackupData } from '../../hooks/useAutoBackup';
import { usePecoStore } from '../../store/pecoStore';
import { useViewerStore } from '../../store/viewerStore';
import { saveTemporaryPageDataBatch, clearTemporaryChanges, getAllTemporaryPageData } from '../../utils/pdfLoader';
import type { PageData, PecoDocument } from '../../types';

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

  // #18: pages 直下ではなく、page エントリ内側の __proto__ も検出する必要がある
  it('S-10-03c (#18): page エントリの own key として __proto__ を持つ場合は reject', async () => {
    // pages.0 の own key として __proto__ を仕込んだ JSON を直接組み立てる
    // (オブジェクトリテラルでは __proto__ プロパティを設定できないため文字列で構築)
    const json =
      '{"version":1,"timestamp":"t","originalFilePath":"f",' +
      '"pages":{"0":{"__proto__":{"polluted":true},"textBlocks":[]}}}';
    mockLoadBackup(json);
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-03d (#18): page エントリの own key として constructor を持つ場合は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { constructor: { polluted: true }, textBlocks: [] },
      }),
    );
    expect(await callLoadBackupData()).toBeNull();
  });

  it('S-10-03e (#18): page エントリの own key として prototype を持つ場合は reject', async () => {
    mockLoadBackup(
      makeBackup({
        '0': { prototype: { polluted: true }, textBlocks: [] },
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

// ── #24: performBackup の早期スキップ / debounce ────────────────────────────

/** PageData のヘルパー */
function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  };
}

/** PecoDocument のヘルパー */
function makeDoc(pages: Map<number, PageData> = new Map([[0, makePage()]])): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  };
}

/** store を初期化する。テスト毎に呼ぶ。 */
function resetStore() {
  usePecoStore.setState({
    document: null,
    originalBytes: null,
    pageAccessOrder: [],
    currentPageIndex: 0,
    isDirty: false,
    selectedIds: new Set(),
    lastSelectedId: null,
    clipboard: [],
    undoStack: [],
    redoStack: [],
    pendingRestoration: null,
    lastIdbError: null,
    currentPageProxy: null,
    currentPageProxyKey: null,
  });
  useViewerStore.setState({
    zoom: 100,
    showOcr: true,
    showTextPreview: false,
    isDrawingMode: false,
    isSplitMode: false,
  });
}

describe('useAutoBackup performBackup (#24 早期スキップ / debounce)', () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(getAllTemporaryPageData).mockResolvedValue(new Map());
    vi.mocked(saveTemporaryPageDataBatch).mockResolvedValue(undefined);
    vi.mocked(clearTemporaryChanges).mockResolvedValue(undefined);
  });

  // #24-b: dirty なしの場合は Map 走査・stringify ともにスキップされる
  it('S-24-01 (#24-b): isDirty=false のとき save_backup は呼ばれず getAllTemporaryPageData も走らない', async () => {
    // 編集なし: document はあるが isDirty=false
    usePecoStore.setState({ document: makeDoc(), isDirty: false });

    // performBackup を取得して呼び出す
    // quietPeriodMs=0 にして debounce 側の影響を排除
    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, 0));
    await act(async () => {
      await result.current.performBackup();
    });

    // 早期 return のため save_backup は呼ばれない
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(0);
    // IDB 走査もスキップされる (waitForPendingIdbSaves 以降の処理に進まない)
    expect(vi.mocked(getAllTemporaryPageData)).not.toHaveBeenCalled();
  });

  // #24-c: 最終編集から quietPeriodMs 以内なら performBackup はスキップされる
  it('S-24-02 (#24-c): 最終編集から quietPeriodMs 未満では save_backup は呼ばれない', async () => {
    const quietMs = 60_000;
    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // 先に setDocument 相当 (filePath が null→test.pdf) を発行 → lastEditTimeRef は更新されない (#67)
    usePecoStore.setState({ document: makeDoc(), isDirty: false });
    // 続いて同じ filePath 上で pages 参照を変えて編集発生をシミュレート → lastEditTimeRef が「今」になる
    usePecoStore.setState({
      document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
      isDirty: true,
    });

    await act(async () => {
      await result.current.performBackup();
    });

    // 直近編集から 0 秒なので skip される
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(0);
    expect(vi.mocked(getAllTemporaryPageData)).not.toHaveBeenCalled();
  });

  // #24-c: quietPeriodMs を超えて静かなら performBackup は走る
  it('S-24-03 (#24-c): 最終編集から quietPeriodMs 超過なら save_backup が呼ばれる', async () => {
    const quietMs = 60_000;
    // 編集時刻を quietPeriodMs より過去にしたいので、Date.now() を mock する。
    // lastEditTimeRef===0 は「未編集」の sentinel なので 0 は避ける。
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // 先に setDocument 相当 (filePath が null→test.pdf) を発行 → lastEditTimeRef は更新されない (#67)
    nowSpy.mockReturnValue(500);
    usePecoStore.setState({ document: makeDoc(), isDirty: false });

    // 編集発生を t=1000 として subscribe 側に通知 (filePath 同一で pages 参照変化) → lastEditTimeRef = 1000
    nowSpy.mockReturnValue(1000);
    usePecoStore.setState({
      document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
      isDirty: true,
    });

    // 60s 経過後に performBackup → Date.now() - 1000 = 60001 > 60000
    nowSpy.mockReturnValue(1000 + quietMs + 1);
    await act(async () => {
      await result.current.performBackup();
    });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });
});

// ── #67: 新規 PDF オープン直後 (setDocument) は lastEditTime を更新しない ──

describe('useAutoBackup lastEditTime tracking (#67 setDocument を編集とみなさない)', () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(getAllTemporaryPageData).mockReset().mockResolvedValue(new Map());
    vi.mocked(saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined);
    vi.mocked(clearTemporaryChanges).mockReset().mockResolvedValue(undefined);
  });

  // #67 主回帰テスト: 新規 PDF オープン直後 (filePath が変わる setDocument) は
  // 「直近編集」とみなさない → quietPeriodMs を経過しても lastEdit===0 のままで performBackup は走らない。
  it('S-67-01: setDocument のみでは lastEditTime を更新しない (lastEdit=0 のままで backup skip)', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // t=1000: setDocument 相当 (null → test.pdf) を発行
    nowSpy.mockReturnValue(1000);
    usePecoStore.setState({ document: makeDoc(), isDirty: false });

    // 修正前は lastEditTimeRef=1000 となり、以降 quietMs=60s 編集できなくても 60s 後に backup が走ってしまっていた。
    // 修正後は lastEditTimeRef=0 のままなので、編集なしのままどれだけ経過しても performBackup はスキップされる。
    nowSpy.mockReturnValue(1000 + quietMs + 1);
    // 「編集はしていないが isDirty は true」のシナリオは現実には起きないが、
    // 仮にそうであっても lastEdit===0 であれば performBackup は走らないことを確認する
    usePecoStore.setState({ isDirty: true });

    await act(async () => {
      await result.current.performBackup();
    });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(0);
    // lastEdit===0 で早期 return されるため IDB 走査にも進まない
    expect(vi.mocked(getAllTemporaryPageData)).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  // #67: filePath 同一で pages 参照のみ更新された場合 (= updatePageData) は
  // 編集発生とみなして lastEditTime を更新する。
  it('S-67-02: filePath 同一で pages 更新時のみ lastEditTime を更新する', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // t=500: 新規 PDF オープン (setDocument) → lastEditTime は更新されない
    nowSpy.mockReturnValue(500);
    usePecoStore.setState({ document: makeDoc(), isDirty: false });

    // t=1000: ユーザー編集発生 (filePath 同一, pages 参照だけ変わる) → lastEditTime=1000
    nowSpy.mockReturnValue(1000);
    usePecoStore.setState({
      document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
      isDirty: true,
    });

    // t=1000 + quietMs + 1: 60s 静かにしてから performBackup → 走る
    nowSpy.mockReturnValue(1000 + quietMs + 1);
    await act(async () => {
      await result.current.performBackup();
    });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });

  // #67 retrospective: 新規 PDF を開いた "直後" (60s 以内) の編集が確実にバックアップされる。
  // 修正前: setDocument が lastEdit を更新するため、編集してから残り 30s しかなく
  //   60s 後に performBackup されても 30s 静止していない → スキップになる可能性があった。
  // 修正後: setDocument では lastEdit が更新されないので、編集から 60s 静止で backup される。
  it('S-67-03: 新規 PDF オープン直後 30 秒で編集し 60 秒待てば backup が走る', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // t=1: 新規 PDF オープン (sentinel 回避のため 0 ではなく 1)
    nowSpy.mockReturnValue(1);
    usePecoStore.setState({ document: makeDoc(), isDirty: false });

    // t=30_000: ユーザー編集 (filePath 同一で pages 参照更新) → lastEditTime=30000
    nowSpy.mockReturnValue(30_000);
    usePecoStore.setState({
      document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
      isDirty: true,
    });

    // t=30_000 + 60_001: 編集から 60s 経過 → backup 走る
    nowSpy.mockReturnValue(30_000 + quietMs + 1);
    await act(async () => {
      await result.current.performBackup();
    });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });

  // #67 negative: 別 PDF への切替 (filePath が変わる setDocument) も編集とみなさない。
  // 切替後に編集してから quietPeriodMs 静止して初めて backup される。
  it('S-67-04: 別 PDF への切替時も setDocument 単独では lastEditTime を更新しない', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));

    // t=1000: file1 を開く
    nowSpy.mockReturnValue(1000);
    const file1 = { ...makeDoc(), filePath: 'file1.pdf', fileName: 'file1.pdf' };
    usePecoStore.setState({ document: file1, isDirty: false });

    // t=2000: file2 に切り替え (setDocument, filePath 変化) → lastEditTime は 0 のまま
    nowSpy.mockReturnValue(2000);
    const file2 = { ...makeDoc(), filePath: 'file2.pdf', fileName: 'file2.pdf' };
    usePecoStore.setState({ document: file2, isDirty: false });

    // t=2000 + quietMs + 1: isDirty=true でも lastEdit===0 (sentinel) で skip
    nowSpy.mockReturnValue(2000 + quietMs + 1);
    usePecoStore.setState({ isDirty: true });
    await act(async () => {
      await result.current.performBackup();
    });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(0);

    nowSpy.mockRestore();
  });
});

// ── Wave-3: isSavingRef 排他ロック / externalIsSavingRef ガード ─────────────

/**
 * isSavingRef 排他: performBackup の冒頭で isSavingRef.current=true を設定し、
 * finally で false に戻す。並走呼び出しは冒頭チェックで早期 return する。
 *
 * externalIsSavingRef: 手動保存中フラグ (useFileOperations から渡す shared ref)。
 * true のときは performBackup がスキップされる (issue #137)。
 */

/** quietPeriodMs を超えるよう Date.now を設定して performBackup が走れる状態にする */
function setupBackupReadyState(
  nowSpy: ReturnType<typeof vi.spyOn>,
  quietMs: number,
): void {
  // t=1: PDF オープン (setDocument)
  nowSpy.mockReturnValue(1);
  usePecoStore.setState({ document: makeDoc(), isDirty: false });
  // t=1000: 編集発生 (pages 参照変化)
  nowSpy.mockReturnValue(1000);
  usePecoStore.setState({
    document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
    isDirty: true,
  });
  // t=1000 + quietMs + 1: 静止期間経過後
  nowSpy.mockReturnValue(1000 + quietMs + 1);
}

describe('useAutoBackup isSavingRef 排他ロック (Wave-3 issue #137)', () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(getAllTemporaryPageData).mockReset().mockResolvedValue(new Map());
    vi.mocked(saveTemporaryPageDataBatch).mockReset().mockResolvedValue(undefined);
    vi.mocked(clearTemporaryChanges).mockReset().mockResolvedValue(undefined);
    // デフォルト: save_backup は成功
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'check_pending_backups') return [];
      if (cmd === 'save_backup') return undefined;
      return undefined;
    });
  });

  // S-137-01: isSavingRef=true 中は並走呼び出しが skip される
  it('S-137-01: isSavingRef=true 中に performBackup を呼ぶと save_backup が 1 回だけ呼ばれる', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    let resolveBackup!: () => void;
    // 1 回目の save_backup を一時停止させる
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'check_pending_backups') return [];
      if (cmd === 'save_backup') {
        await new Promise<void>((resolve) => { resolveBackup = resolve; });
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));
    // renderHook 後に state を設定 (既存テストのパターンに合わせる)
    setupBackupReadyState(nowSpy, quietMs);

    // 1 回目: 走り始めるが pause 中
    const p1 = act(async () => { await result.current.performBackup(); });
    // microtask を少し進めて isSavingRef.current=true になるのを待つ
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // 2 回目: isSavingRef=true のため skip される
    await act(async () => { await result.current.performBackup(); });

    // 1 回目を完了させる
    resolveBackup();
    await p1;

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    // isSavingRef=true の間に入ってきた 2 回目は skip → save_backup は 1 回のみ
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });

  // S-137-02: isSavingRef が false に戻った後の呼び出しは正常実行
  it('S-137-02: isSavingRef=false 後の performBackup は正常に save_backup を呼ぶ', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const { result } = renderHook(() => useAutoBackup(() => {}, 5 * 60 * 1000, quietMs));
    setupBackupReadyState(nowSpy, quietMs);

    // 1 回目: 完了まで待つ
    await act(async () => { await result.current.performBackup(); });

    // 1 回目完了後に再度編集・静止してから 2 回目を呼ぶ
    nowSpy.mockReturnValue(2000);
    usePecoStore.setState({
      document: makeDoc(new Map([[0, makePage({ isDirty: true })]])),
      isDirty: true,
    });
    nowSpy.mockReturnValue(2000 + quietMs + 1);

    await act(async () => { await result.current.performBackup(); });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    // 2 回実行される
    expect(saveCalls).toHaveLength(2);

    nowSpy.mockRestore();
  });

  // S-137-03: externalIsSavingRef=true のとき performBackup は skip される (issue #137)
  it('S-137-03: externalIsSavingRef=true のとき save_backup は呼ばれない', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    // externalIsSavingRef を true に設定
    const externalRef = { current: true } as React.RefObject<boolean>;

    const { result } = renderHook(() =>
      useAutoBackup(() => {}, 5 * 60 * 1000, quietMs, externalRef)
    );
    setupBackupReadyState(nowSpy, quietMs);

    await act(async () => { await result.current.performBackup(); });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(0);

    nowSpy.mockRestore();
  });

  // S-137-04: externalIsSavingRef=false のときは skip されない
  it('S-137-04: externalIsSavingRef=false のとき save_backup は正常に呼ばれる', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    const externalRef = { current: false } as React.RefObject<boolean>;

    const { result } = renderHook(() =>
      useAutoBackup(() => {}, 5 * 60 * 1000, quietMs, externalRef)
    );
    setupBackupReadyState(nowSpy, quietMs);

    await act(async () => { await result.current.performBackup(); });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });

  // S-137-05: externalIsSavingRef=undefined のとき従来挙動 (ガードなし)
  it('S-137-05: externalIsSavingRef=undefined のとき save_backup は呼ばれる (従来挙動)', async () => {
    const quietMs = 60_000;
    const nowSpy = vi.spyOn(Date, 'now');

    // externalIsSavingRef を渡さない
    const { result } = renderHook(() =>
      useAutoBackup(() => {}, 5 * 60 * 1000, quietMs, undefined)
    );
    setupBackupReadyState(nowSpy, quietMs);

    await act(async () => { await result.current.performBackup(); });

    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_backup');
    expect(saveCalls).toHaveLength(1);

    nowSpy.mockRestore();
  });
});
