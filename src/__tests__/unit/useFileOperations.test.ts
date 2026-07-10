/**
 * S-10 (追加): useFileOperations の localStorage JSON.parse narrow を検証する。
 * - handleOpen 内部の addToRecent が localStorage を読み書きする際、
 *   不正 JSON / 型違反値を安全に弾けることを確認する。
 *
 * #8: writeFileChunked が空 Uint8Array でも write_pdf_chunk を 1 回呼ぶこと
 * #34: explicitPath での読み込み失敗時に Recent から該当パスが除去されること
 * #29: originalBytes が zustand store に保持されず module-level cache へ移行されていること
 * #37: Recent Files が localStorage に保存されてリロード後も残ること
 * #53: writeFileAtomically が EACCES 系エラーで失敗した場合、saveAs アクション付きトーストが出ること
 *
 * 重い依存 (loadPDF / fs / dialog / fontLoader / store) は全て mock する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---- 依存 mock ----
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ mtime: new Date('2024-01-01') }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  convertFileSrc: (p: string) => p,
}));
vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn().mockResolvedValue({
    filePath: '',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map(),
  }),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChangesForPages: vi.fn().mockResolvedValue(undefined),
  remapTemporaryPageEntries: vi.fn().mockResolvedValue(undefined),
  clearCachedPages: vi.fn().mockResolvedValue(undefined),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn().mockResolvedValue({}),
  loadPage: vi.fn().mockResolvedValue({ textBlocks: [], imageBlocks: [], isDirty: false }),
  loadPecoToolBBoxMeta: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../utils/pdfSaver', () => ({
  savePDF: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));
vi.mock('../../hooks/useFontLoader', () => ({
  loadFallbackFontsLazy: vi.fn().mockResolvedValue([]),
  loadFontLazy: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  loadBundledIpAmjFontLazy: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  getPrimaryFontKind: vi.fn().mockReturnValue('bundled'),
  disableSystemFontForSession: vi.fn(),
}));
// PCT-101/C1: invalidateBBoxMetaCache の呼び出しを検証するためにモック
vi.mock('../../utils/pdfMetadataLoader', () => ({
  invalidateBBoxMetaCache: vi.fn(),
}));

// pecoStore は本物を使うが、必要最小限の状態だけ。
// loadPDF が返す doc を setDocument に流すので、副作用は無害。
import { useFileOperations, __originalBytesCacheForTest, isWriteAccessError } from '../../hooks/useFileOperations';
import { getAllTemporaryPageData, loadPDF, loadPage, clearTemporaryChanges, remapTemporaryPageEntries, getSharedPdfProxy } from '../../utils/pdfLoader';
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import type { PecoDocument, PageData } from '../../types';
import { invalidateBBoxMetaCache } from '../../utils/pdfMetadataLoader';
import {
  loadFontLazy,
  loadFallbackFontsLazy,
  loadBundledIpAmjFontLazy,
  getPrimaryFontKind,
  disableSystemFontForSession,
} from '../../hooks/useFontLoader';

beforeEach(() => {
  // issue #37: Recent Files は localStorage に保存される。両方クリアして検証ノイズを排除。
  sessionStorage.clear();
  localStorage.clear();
  // issue #29: module-level cache も毎テストでクリーンに
  __originalBytesCacheForTest.clear();
  vi.clearAllMocks();
  // loadPDF mock を毎回リセット
  (loadPDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    filePath: '/fixed/path.pdf',
    fileName: 'path.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map(),
  });
  // issue #115: 一部テスト (#53 等) は invoke を mockImplementation で
  // 永続的に reject させる。clearAllMocks では実装は消えないため、毎テスト前に
  // 良性デフォルト (全コマンド成功) へ戻して保存系テストの相互汚染を防ぐ。
  (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => Promise.resolve(undefined),
  );
  // savePDF も同様に毎テスト前にデフォルトの成功実装へ戻す。
  (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Uint8Array([4, 5, 6]),
  );
  (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Uint8Array([1, 2, 3]),
  );
  (stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    mtime: new Date('2024-01-01'),
    size: 3,
  });
});

function readRecent(): unknown {
  // issue #37: Recent Files は localStorage 経路へ移行
  const raw = localStorage.getItem('peco-recent-files');
  return raw === null ? null : JSON.parse(raw);
}

describe('useFileOperations addToRecent (localStorage narrow)', () => {
  it('S-10-09a: 既存値が string[] でなく数値混在配列の場合、空配列扱いで上書きされる', async () => {
    // 改ざんされた localStorage を仕込む
    localStorage.setItem('peco-recent-files', '[123, "/path"]');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/new/file.pdf');
    });

    // 不正配列は narrow で reject されるため、結果は ['/new/file.pdf'] のみ
    const recent = readRecent();
    expect(Array.isArray(recent)).toBe(true);
    expect(recent).toEqual(['/new/file.pdf']);
  });

  it('S-10-09b: 既存値がオブジェクト ({foo: 1}) でも narrow で reject される', async () => {
    localStorage.setItem('peco-recent-files', '{"foo":1}');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/new/file.pdf');
    });

    expect(readRecent()).toEqual(['/new/file.pdf']);
  });

  it('S-10-10: 既存値が JSON ではない (壊れた文字列) 場合、空配列にフォールバック', async () => {
    localStorage.setItem('peco-recent-files', 'not-json{{{');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/new/file.pdf');
    });

    expect(readRecent()).toEqual(['/new/file.pdf']);
  });

  it('既存値が正常な string[] の場合、先頭に追加されて重複が除去される', async () => {
    localStorage.setItem(
      'peco-recent-files',
      JSON.stringify(['/old.pdf', '/dup.pdf']),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/dup.pdf');
    });

    expect(readRecent()).toEqual(['/dup.pdf', '/old.pdf']);
  });
});

describe('useFileOperations writeFileChunked (issue #8 空 Uint8Array 対応)', () => {
  it('#8: savePDF が空 Uint8Array を返しても write_pdf_chunk が offset=0 で 1 回呼ばれる', async () => {
    // 保存対象 doc を pecoStore に直接セット (handleOpen 経由ではなく)。
    // dirty なページを 1 件持たせて、_executeSave の loadRepairPages 分岐に入らないようにする。
    const dirtyPage = {
      textBlocks: [],
      imageBlocks: [],
      isDirty: true,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/save/target.pdf',
      fileName: 'target.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      isDirty: true,
    });
    // issue #29: originalBytes は zustand store から外れ module-level cache へ移行したため
    // テスト側でも __originalBytesCacheForTest 経由で投入する。
    __originalBytesCacheForTest.set('/save/target.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // savePDF が空 Uint8Array を返すケース (#8 の再現条件)
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Uint8Array(0));

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'write_pdf_chunk' || cmd === 'replace_pdf_file' || cmd === 'clear_backup') {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // 修正前: 空 bytes だと for ループに入らず write_pdf_chunk は 0 回呼ばれる。
    // 修正後: 空でも 1 回呼ばれて Rust 側で create+truncate される。
    const writeChunkCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'write_pdf_chunk',
    );
    expect(writeChunkCalls.length).toBe(1);
    // offset header は '0' であること (create+truncate を担保)
    const [, body, opts] = writeChunkCalls[0] as [
      string,
      ArrayBuffer,
      { headers: Record<string, string> },
    ];
    expect(opts.headers['x-offset']).toBe('0');
    // 空 ArrayBuffer であること
    expect(body.byteLength).toBe(0);
    // replace_pdf_file もその後呼ばれて atomic 置換が完走する
    const replaceCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'replace_pdf_file',
    );
    expect(replaceCalls.length).toBe(1);
  });
});

describe('useFileOperations handleOpen Recent クリーンアップ (issue #34)', () => {
  it('#34: explicitPath で開いて loadPDF が失敗した場合、その path が Recent から除去され peco-recent-files-updated が発火する', async () => {
    // pecoStore をクリーンに
    usePecoStore.setState({ document: null, isDirty: false });

    // 事前に Recent に '/missing.pdf' と '/keep.pdf' を入れておく
    // issue #37: localStorage 経路へ移行済み
    localStorage.setItem(
      'peco-recent-files',
      JSON.stringify(['/missing.pdf', '/keep.pdf']),
    );

    // loadPDF が FS エラーで reject されるようにする
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOENT: no such file or directory'),
    );

    // peco-recent-files-updated イベント発火を検知
    const updatedListener = vi.fn();
    window.addEventListener('peco-recent-files-updated', updatedListener);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let opened = true;
    await act(async () => {
      opened = await result.current.handleOpen('/missing.pdf');
    });

    window.removeEventListener('peco-recent-files-updated', updatedListener);

    // handleOpen は false を返す
    expect(opened).toBe(false);
    // エラートーストが出る
    expect(showToast).toHaveBeenCalledWith('ファイルの読み込みに失敗しました。', true);
    // Recent から '/missing.pdf' が消え、'/keep.pdf' は残る
    expect(readRecent()).toEqual(['/keep.pdf']);
    // イベントが発火している (useRecentFiles 側の即時反映を保証)
    expect(updatedListener).toHaveBeenCalled();
  });

  it('#34: ダイアログ経由 (explicitPath なし) で失敗した場合は Recent を変更しない', async () => {
    usePecoStore.setState({ document: null, isDirty: false });
    localStorage.setItem(
      'peco-recent-files',
      JSON.stringify(['/existing.pdf']),
    );

    // open ダイアログが '/picked.pdf' を返し、その後 loadPDF が失敗するシナリオ
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/picked.pdf');
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOENT'),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen();
    });

    // Recent はそのまま (explicitPath ではないので除去対象外)
    expect(readRecent()).toEqual(['/existing.pdf']);
  });
});

describe('useFileOperations originalBytes module-level cache (issue #29)', () => {
  it('#29: originalBytes は zustand store に保持されない (store には key 自体が無い)', () => {
    const state = usePecoStore.getState() as unknown as Record<string, unknown>;
    expect('originalBytes' in state).toBe(false);
    expect('setOriginalBytes' in state).toBe(false);
  });

  it('#29: 保存時に originalBytes が無ければ readFile → module-level cache へ格納される', async () => {
    // dirty page を 1 件持たせて loadRepairPages 分岐を回避
    const dirtyPage = { textBlocks: [], imageBlocks: [], isDirty: true } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/cache/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });

    // cache は空のはずなので readFile が走る
    expect(__originalBytesCacheForTest.get('/cache/test.pdf')).toBeUndefined();

    const { readFile } = await import('@tauri-apps/plugin-fs');
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // 保存後は writePath をキーに savedBytes がキャッシュされる
    expect(__originalBytesCacheForTest.get('/cache/test.pdf')).toBeDefined();
  });

  it('#29: setOriginalBytesCache の MAX=1 制限により古いファイルのキャッシュは破棄される', () => {
    __originalBytesCacheForTest.set('/old.pdf', new Uint8Array([1]));
    expect(__originalBytesCacheForTest.size()).toBe(1);
    __originalBytesCacheForTest.set('/new.pdf', new Uint8Array([2]));
    expect(__originalBytesCacheForTest.size()).toBe(1);
    expect(__originalBytesCacheForTest.get('/old.pdf')).toBeUndefined();
    expect(__originalBytesCacheForTest.get('/new.pdf')).toBeDefined();
  });

  it('同一 filePath の mtime/size が変わったら古い originalBytes cache を使わず再読み込みする', async () => {
    const dirtyPage = { textBlocks: [], imageBlocks: [], isDirty: true } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/cache/stale.pdf',
      fileName: 'stale.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/cache/stale.pdf', new Uint8Array([1, 1, 1, 1]), {
      mtimeMs: new Date('2024-01-01').getTime(),
      size: 4,
    });
    (stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      mtime: new Date('2024-01-02'),
      size: 5,
    });
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Uint8Array([9, 9, 9, 9, 9]),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(readFile).toHaveBeenCalledWith('/cache/stale.pdf');
    const [saveSource] = (savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { bytes: Uint8Array },
    ];
    expect(Array.from(saveSource.bytes)).toEqual([9, 9, 9, 9, 9]);
  });

  it('fingerprint 付き cache は stat 失敗時も stale とみなして再読み込みする', async () => {
    const dirtyPage = { textBlocks: [], imageBlocks: [], isDirty: true } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/cache/stat-fail.pdf',
      fileName: 'stat-fail.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/cache/stat-fail.pdf', new Uint8Array([1, 1, 1, 1]), {
      mtimeMs: new Date('2024-01-01').getTime(),
      size: 4,
    });
    (stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stat failed'));
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Uint8Array([8, 8, 8, 8]),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(readFile).toHaveBeenCalledWith('/cache/stat-fail.pdf');
    const [statFailSaveSource] = (savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { bytes: Uint8Array },
    ];
    expect(Array.from(statFailSaveSource.bytes)).toEqual([8, 8, 8, 8]);
  });
});

describe('useFileOperations dirty-only save (issue #123)', () => {
  it('#123: dirty ページが 0 件なら全ページを loadPage して dirty 化しない', async () => {
    const cleanPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [],
      imageBlocks: [],
      isDirty: false,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/clean.pdf',
      fileName: 'clean.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([[0, cleanPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: false });
    __originalBytesCacheForTest.set('/clean.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    (getAllTemporaryPageData as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map());

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockResolvedValue(undefined);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(loadPage).not.toHaveBeenCalled();
    expect(savePDF).toHaveBeenCalled();
    const [, savedDoc] = (savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      PecoDocument,
    ];
    expect(savedDoc.pages.size).toBe(0);
  });
});

describe('useFileOperations Recent Files 永続化 (issue #37)', () => {
  it('#37: addToRecent は localStorage へ書き込む (sessionStorage には書き込まない)', async () => {
    expect(localStorage.getItem('peco-recent-files')).toBeNull();
    expect(sessionStorage.getItem('peco-recent-files')).toBeNull();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/persisted.pdf');
    });

    // 永続化 (localStorage) されている
    expect(localStorage.getItem('peco-recent-files')).toBe(JSON.stringify(['/persisted.pdf']));
    // sessionStorage には残らない
    expect(sessionStorage.getItem('peco-recent-files')).toBeNull();
  });

  it('#37: アプリ「再起動」相当 (sessionStorage クリア) 後も localStorage の Recent は維持される', async () => {
    // 1 度開いて履歴を作る
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleOpen('/survives.pdf');
    });
    expect(readRecent()).toEqual(['/survives.pdf']);

    // 再起動相当: sessionStorage だけクリア (旧仕様では Recent もここに居て消えていた)
    sessionStorage.clear();

    // localStorage 側に残っているため Recent は健在
    expect(readRecent()).toEqual(['/survives.pdf']);
  });
});

describe('useFileOperations writeFileAtomically EACCES フォールバック (issue #53)', () => {
  it('#53: isWriteAccessError が EACCES/EBUSY/access denied/sharing violation を正しく検出する', () => {
    expect(isWriteAccessError('EACCES: permission denied')).toBe(true);
    expect(isWriteAccessError('EBUSY: resource busy')).toBe(true);
    expect(isWriteAccessError('Access is denied. (os error 5)')).toBe(true);
    expect(isWriteAccessError('The process cannot access the file because it is being used by another process. (os error 32)')).toBe(true);
    expect(isWriteAccessError('open failed: sharing violation')).toBe(true);
    expect(isWriteAccessError('write failed: lock violation')).toBe(true);
    // 関係ないエラーは false
    expect(isWriteAccessError('ENOENT: no such file')).toBe(false);
    expect(isWriteAccessError('out of memory')).toBe(false);
  });

  it('#53: replace_pdf_file が EACCES で失敗したら、saveAs アクション付きトーストが表示される', async () => {
    // dirty page を 1 件用意
    const dirtyPage = { textBlocks: [], imageBlocks: [], isDirty: true } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/locked.pdf',
      fileName: 'locked.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/locked.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    // replace_pdf_file が Acrobat ロック相当のエラーで reject される
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error(
          'rename target->backup failed: Access is denied. (os error 5)',
        ));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // saveAs フォールバック用の action 付き Toast が呼ばれている
    const errorCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] === true);
    expect(errorCalls.length).toBeGreaterThan(0);
    const lastErrorCall = errorCalls[errorCalls.length - 1];
    // R04D-2: OS エラー文字列は除去し、ユーザー向けメッセージに変更済み
    expect(lastErrorCall[0]).toMatch(/他のアプリ|開かれている/);
    expect(lastErrorCall[2]).toBeDefined();
    expect(lastErrorCall[2].label).toBe('別名で保存');
    expect(typeof lastErrorCall[2].onClick).toBe('function');
  });

  it('#53: 通常のエラー (EACCES でない) は action なしのエラートースト', async () => {
    const dirtyPage = { textBlocks: [], imageBlocks: [], isDirty: true } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/normal.pdf',
      fileName: 'normal.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/normal.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error('disk full: ENOSPC'));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // 失敗トーストは action 引数なしで呼ばれている
    const errorCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] === true);
    expect(errorCalls.length).toBeGreaterThan(0);
    const lastErrorCall = errorCalls[errorCalls.length - 1];
    expect(lastErrorCall[2]).toBeUndefined();
  });
});

describe('useFileOperations handleOpen OCR 実行中ガード (issue #102)', () => {
  it('未保存変更の破棄を確認して別PDFを開くと旧filePathの temporary changes を消す', async () => {
    const dirtyPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as PageData;
    usePecoStore.setState({
      document: {
        filePath: '/dirty/current.pdf',
        fileName: 'current.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, dirtyPage]]),
      } as PecoDocument,
      isDirty: true,
    });
    (ask as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      filePath: '/next.pdf',
      fileName: 'next.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map(),
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/next.pdf');
    });

    expect(opened).toBe(true);
    expect(clearTemporaryChanges).toHaveBeenCalledWith('/dirty/current.pdf');
    expect(loadPDF).toHaveBeenCalledWith('/next.pdf');
    const clearOrder = (clearTemporaryChanges as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const loadOrder = (loadPDF as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(loadOrder).toBeLessThan(clearOrder);
  });

  it('破棄確認後でも別PDFの読み込みに失敗した場合は旧 temporary changes を消さない', async () => {
    const dirtyPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as PageData;
    const currentDoc = {
      filePath: '/dirty/current.pdf',
      fileName: 'current.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as PecoDocument;
    usePecoStore.setState({
      document: currentDoc,
      isDirty: true,
    });
    (ask as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('load failed'));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let opened = true;
    await act(async () => {
      opened = await result.current.handleOpen('/next.pdf');
    });

    expect(opened).toBe(false);
    expect(clearTemporaryChanges).not.toHaveBeenCalledWith('/dirty/current.pdf');
    expect(usePecoStore.getState().document).toBe(currentDoc);
  });

  it('#102: isOcrRunningRef.current=true なら handleOpen は loadPDF を呼ばず false を返す', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let opened = true;
    await act(async () => {
      opened = await result.current.handleOpen('/new.pdf');
    });

    expect(opened).toBe(false);
    expect(loadPDF).not.toHaveBeenCalled();
    // Toast にOCR実行中である旨が出る
    expect(showToast).toHaveBeenCalled();
    expect(showToast.mock.calls[0][0]).toMatch(/OCR.*開けません/);
  });

  it('#102: bypassOcrGuard=true ならフォルダ OCR 経由として handleOpen は素通り (loadPDF が呼ばれる)', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/folder.pdf', { bypassOcrGuard: true });
    });

    expect(opened).toBe(true);
    expect(loadPDF).toHaveBeenCalledTimes(1);
  });

  it('#102: isOcrRunningRef.current=false なら handleOpen は通常通り動く', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const isOcrRunningRef = { current: false } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/normal.pdf');
    });

    expect(opened).toBe(true);
    expect(loadPDF).toHaveBeenCalledTimes(1);
  });

  it('#102: isOcrRunningRef 未指定 (旧来呼び出し) でも従来通り動作 (loadPDF が呼ばれる)', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/legacy.pdf');
    });

    expect(opened).toBe(true);
    expect(loadPDF).toHaveBeenCalledTimes(1);
  });

  it('未保存確認中に保存が始まったら open を中止する', async () => {
    const dirtyPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as PageData;
    usePecoStore.setState({
      document: {
        filePath: '/current.pdf',
        fileName: 'current.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map([[0, dirtyPage]]),
      } as PecoDocument,
      isDirty: true,
    });

    let resolveAsk!: (value: boolean) => void;
    const askPromise = new Promise<boolean>((resolve) => { resolveAsk = resolve; });
    (ask as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(askPromise);

    let resolveSave!: (bytes: Uint8Array) => void;
    const savePromise = new Promise<Uint8Array>((resolve) => { resolveSave = resolve; });
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(savePromise);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openPromise = result.current.handleOpen('/next.pdf');
    await waitFor(() => {
      expect(ask).toHaveBeenCalled();
    });

    const saveTask = result.current.handleSave();
    await waitFor(() => {
      expect(savePDF).toHaveBeenCalled();
    });

    resolveAsk(true);
    await expect(openPromise).resolves.toBe(false);
    expect(loadPDF).not.toHaveBeenCalledWith('/next.pdf');

    resolveSave(new Uint8Array([9, 9, 9]));
    await saveTask;
  });
});

describe('useFileOperations selector subscription (re-render avoidance)', () => {
  it('actions だけを subscribe しているため document 更新で再 render しない', () => {
    // pecoStore を一旦リセットしてから初期 doc を投入
    const initialDoc: PecoDocument = {
      filePath: '/initial.pdf',
      fileName: 'initial.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map(),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: initialDoc });

    let renderCount = 0;
    const showToast = vi.fn();
    renderHook(() => {
      renderCount++;
      return useFileOperations(showToast);
    });

    // 初回 render 後の基準値
    const baseline = renderCount;

    // document を全く別オブジェクトに差し替える (テキスト編集相当の updatePageData
    // でも document リファレンスは新オブジェクトになる)
    act(() => {
      const nextDoc: PecoDocument = {
        ...initialDoc,
        pages: new Map(initialDoc.pages),
      } as unknown as PecoDocument;
      usePecoStore.setState({ document: nextDoc });
    });

    // 直接無関係なフィールドを変えても発火しないこと
    act(() => {
      usePecoStore.setState({ zoom: 150 });
    });
    act(() => {
      usePecoStore.setState({ selectedIds: new Set(['x']) });
    });

    // actions しか subscribe していないので、これらの変更では再 render が発生しない
    expect(renderCount).toBe(baseline);
  });
});

// ────────────────────────────────────────────────────────────────────────
// issue #115: 保存オーケストレーション層の修正テスト
// ────────────────────────────────────────────────────────────────────────

/**
 * _executeSave は savePDF(saveSource, mergedDoc, ...) を呼ぶ。
 * mergedDoc.pages には dirty ページが入るため、savePDF mock の第 2 引数を読めば
 * 「保存スナップショットに何のテキストが載ったか」を検証できる。
 */
function getLastSavedDoc(): PecoDocument {
  const calls = (savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as PecoDocument;
}

describe('useFileOperations save がフォーカス中の OCR 編集を flush する (issue #115 Fix 1)', () => {
  /**
   * OcrCard の .ocr-card-content に相当する contentEditable を DOM 上に作る。
   * flushActiveOcrCardText は focus 中の
   * `.ocr-card-content[data-page-index][data-block-id]` を直接読んで store へ
   * 同期コミットするため、この属性付き要素を本物の OcrCard の代わりに使う。
   */
  function makeOcrCardContent(pageIndex: number, blockId: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'ocr-card-content';
    el.setAttribute('contenteditable', 'true');
    el.dataset.pageIndex = String(pageIndex);
    el.dataset.blockId = blockId;
    el.tabIndex = 0;
    document.body.appendChild(el);
    return el;
  }

  it('#115: handleSave は store スナップショット前にフォーカス中の OCR 編集を flush して確定させる', async () => {
    // store には古いテキスト STALE、DOM 側には未コミット編集が乗っている状態。
    const block = { id: 'blk-1', text: 'STALE', isDirty: true } as unknown as Record<string, unknown>;
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [block],
      isDirty: true,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/flush/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/flush/test.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // フォーカス中の .ocr-card-content に未コミットの編集後テキストを入れておく。
    const content = makeOcrCardContent(0, 'blk-1');
    content.textContent = 'EDITED_BEFORE_SAVE';
    content.focus();
    expect(document.activeElement).toBe(content);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // flushActiveOcrCardText がスナップショット前に DOM の編集を store へ確定させ、
    // savePDF に渡る mergedDoc に編集後テキストが載っている (stale な STALE ではない)。
    const savedDoc = getLastSavedDoc();
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('EDITED_BEFORE_SAVE');

    document.body.removeChild(content);
  });

  it('#115: フォーカスが OCR カードでなければ flush しない (通常 button 等は影響なし)', async () => {
    const dirtyPage = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'b', text: 'T', isDirty: true }],
      isDirty: true, thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/flush/btn.pdf', fileName: 'btn.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/flush/btn.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // button は .ocr-card-content ではないので flush 対象外。
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    // flush は OCR カード以外を触らないので button のフォーカスは保持され、保存は完走する。
    expect(document.activeElement).toBe(button);
    const savedDoc = getLastSavedDoc();
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('T');

    document.body.removeChild(button);
  });

  it('#115: フォーカス中 OCR カードのテキストが store と同一なら無変更で保存される', async () => {
    const dirtyPage = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'blk-1', text: 'UNCHANGED', isDirty: true }],
      isDirty: true, thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/flush/same.pdf', fileName: 'same.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set('/flush/same.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // DOM 側のテキストは store と一致 = flush は差分なしで no-op になる。
    const content = makeOcrCardContent(0, 'blk-1');
    content.textContent = 'UNCHANGED';
    content.focus();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    const savedDoc = getLastSavedDoc();
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('UNCHANGED');

    document.body.removeChild(content);
  });
});

describe('useFileOperations save-diff: 編集が保存出力に反映される (issue #115 回帰)', () => {
  it('#115: ブロックのテキストを編集して保存すると、保存スナップショットに編集後テキストが載る (古いテキストではない)', async () => {
    // 初期テキスト ORIGINAL のブロックを持つ dirty ページ
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [{ id: 'edit-blk', text: 'ORIGINAL', isDirty: false }],
      isDirty: false,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/diff/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: false });
    __originalBytesCacheForTest.set('/diff/test.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // ユーザー編集相当: ブロックのテキストを NEW_TEXT に変更 (store へコミット)
    const page = usePecoStore.getState().document!.pages.get(0)!;
    usePecoStore.getState().updatePageData(0, {
      textBlocks: page.textBlocks.map((b: any) =>
        b.id === 'edit-blk' ? { ...b, text: 'NEW_TEXT', isDirty: true } : b,
      ),
      isDirty: true,
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    // savePDF に渡った doc は編集後の NEW_TEXT を保持している (stale な ORIGINAL ではない)
    const savedDoc = getLastSavedDoc();
    expect(savedDoc.pages.get(0)!.textBlocks[0].text).toBe('NEW_TEXT');
  });

  it('#115: 保存中に別ページを編集 → resetDirty 後もその編集が dirty を保ち、次回保存に載る', async () => {
    // page 0, page 1 を持つ doc。page 0 のみ dirty。
    const doc: PecoDocument = {
      filePath: '/diff/race.pdf',
      fileName: 'race.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map<number, PageData>([
        [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [{ id: 'p0', text: 'P0', isDirty: true }], isDirty: true, thumbnail: null } as unknown as PageData],
        [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [{ id: 'p1', text: 'P1', isDirty: false }], isDirty: false, thumbnail: null } as unknown as PageData],
      ]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1],
      isDirty: true,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set('/diff/race.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // savePDF が解決する前に「別ページ編集」を割り込ませる。
    // savePDF mock を 1 度だけ「解決前に page 1 を編集する」実装に差し替える。
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // save 実行中 (snapshot 後) に page 1 を編集 = race の再現
      const p1 = usePecoStore.getState().document!.pages.get(1)!;
      usePecoStore.getState().updatePageData(1, {
        textBlocks: p1.textBlocks.map((b: any) =>
          b.id === 'p1' ? { ...b, text: 'P1_DURING_SAVE', isDirty: true } : b,
        ),
        isDirty: true,
      });
      return new Uint8Array([4, 5, 6]);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    // resetDirty(savedPageSnapshots) は保存スナップショットと同一参照の page 0 のみ
    // クリア。保存中に編集された page 1 は参照が変わり一致しないため isDirty 維持。
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(usePecoStore.getState().document!.pages.get(1)!.isDirty).toBe(true);
    // 未保存ページが残るのでドキュメントレベル isDirty も true
    expect(usePecoStore.getState().isDirty).toBe(true);
    expect(usePecoStore.getState().lastSavedActionIndex).toBe(0);
    expect(usePecoStore.getState().undoStack.length).toBe(1);

    // 2 回目の保存: page 1 が dirty フィルタに載り、編集が保存スナップショットに含まれる
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Uint8Array([7, 8, 9]));
    await act(async () => {
      await result.current.handleSave();
    });
    const secondSavedDoc = getLastSavedDoc();
    // 2 回目スナップショットに page 1 が含まれ、編集後テキストが載っている
    expect(secondSavedDoc.pages.has(1)).toBe(true);
    expect(secondSavedDoc.pages.get(1)!.textBlocks[0].text).toBe('P1_DURING_SAVE');
    expect(usePecoStore.getState().lastSavedActionIndex).toBe(1);
  });
});

describe('useFileOperations 回帰(#350/PCT-127): 保存を跨ぐ undo の isDirty フィルタ漏れ', () => {
  it('#350: 編集→保存→undo→再保存で、undo が巻き戻した内容が2回目の保存対象に載る (isDirty フィルタを通過する)', async () => {
    // 初期テキスト ORIGINAL を持つ非 dirty ページ (開いた直後の状態を模す)
    const originalBlock = { id: 'edit-blk', text: 'ORIGINAL', isDirty: false };
    const cleanPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [originalBlock],
      isDirty: false,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/undo-save/test.pdf',
      fileName: 'test.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, cleanPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      pageOrder: [0],
      isDirty: false,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set('/undo-save/test.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // ユーザー編集: テキストを EDITED に変更 (dirty 化・undoStack に積む)
    const page = usePecoStore.getState().document!.pages.get(0)!;
    usePecoStore.getState().updatePageData(0, {
      textBlocks: page.textBlocks.map((b: any) =>
        b.id === 'edit-blk' ? { ...b, text: 'EDITED', isDirty: true } : b,
      ),
      isDirty: true,
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    // 1回目の保存: 編集後テキストが保存される
    await act(async () => {
      await result.current.handleSave();
    });
    const firstSavedDoc = getLastSavedDoc();
    expect(firstSavedDoc.pages.get(0)!.textBlocks[0].text).toBe('EDITED');
    // resetDirty により保存直後は page.isDirty が落ちている
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);

    // undo: 編集前の ORIGINAL に巻き戻す (ディスク上にはまだ EDITED が残っている)
    usePecoStore.getState().undo();
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('ORIGINAL');
    // #350 の核心: before スナップショットの isDirty=false をそのまま復元すると、
    // 保存フィルタ (p.isDirty) から漏れて 2 回目の保存が対象ゼロで完了してしまう。
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(true);

    // 2回目の保存: undo で巻き戻った ORIGINAL が保存対象に載り、実際にディスクへ反映される
    await act(async () => {
      await result.current.handleSave();
    });
    const secondSavedDoc = getLastSavedDoc();
    expect(secondSavedDoc.pages.has(0)).toBe(true);
    expect(secondSavedDoc.pages.get(0)!.textBlocks[0].text).toBe('ORIGINAL');
  });
});

describe('formatSkippedCharWarning メッセージ改善 (issue #115 Fix 3)', () => {
  // formatSkippedCharWarning は内部関数のため、save 経由 (skippedChars 付き savePDF) で
  // トースト文言を観測する。savePDF の 5 引数目 onSkipped(chars) を呼び出すと
  // _executeSave 内 skippedChars に伝播し、成功トーストに formatSkippedCharWarning が乗る。
  function setupDirtyDoc(filePath: string) {
    const dirtyPage = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'b', text: 'T', isDirty: true }],
      isDirty: true, thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath, fileName: 'x.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  }

  it('#115: スキップ文字のトーストに 各文字・コードポイント・除外回数・合計数が出る', async () => {
    setupDirtyDoc('/skip/a.pdf');

    // savePDF mock: 5 引数目 onSkipped に skippedChars を渡す
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_src, _doc, _font, _fallback, onSkipped) => {
        (onSkipped as (c: unknown[]) => void)([
          { char: 'A', codePoint: 'U+0041', count: 3, pages: [1], reason: 'unsupported-font' },
          { char: '', codePoint: 'U+0007', count: 2, pages: [1], reason: 'control-character' },
        ]);
        return new Uint8Array([4, 5, 6]);
      },
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    // 成功トースト (isError でない呼び出し) を集める
    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    const lastMsg = String(successCalls[successCalls.length - 1][0]);
    // 合計除外数 (3 + 2 = 5)
    expect(lastMsg).toContain('計5個');
    // 印字可能文字 A は実体 + コードポイント + 回数
    expect(lastMsg).toContain('「A」(U+0041)×3');
    // 不可視文字 (U+0007) はコードポイントのみ + 回数
    expect(lastMsg).toContain('U+0007×2');
  });

  it('#115: スキップ文字が 9 種以上なら「ほかN種」サフィックスが付く', async () => {
    setupDirtyDoc('/skip/b.pdf');

    const manyChars = Array.from({ length: 10 }, (_, i) => ({
      char: String.fromCharCode(0x41 + i),
      codePoint: `U+00${(0x41 + i).toString(16).toUpperCase()}`,
      count: 1,
      pages: [1],
      reason: 'unsupported-font' as const,
    }));
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_src, _doc, _font, _fallback, onSkipped) => {
        (onSkipped as (c: unknown[]) => void)(manyChars);
        return new Uint8Array([4, 5, 6]);
      },
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    const lastMsg = String(successCalls[successCalls.length - 1][0]);
    // 10 種中 8 種を表示、残り 2 種は「ほか2種」
    expect(lastMsg).toContain('ほか2種');
    expect(lastMsg).toContain('計10個');
  });

  it('#115: スキップ文字が無ければ警告メッセージは付かない', async () => {
    setupDirtyDoc('/skip/c.pdf');
    // savePDF は onSkipped を呼ばない (skippedChars 空のまま)
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Uint8Array([4, 5, 6]));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    const lastMsg = String(successCalls[successCalls.length - 1][0]);
    expect(lastMsg).toContain('保存しました');
    expect(lastMsg).not.toContain('除外しました');
  });
});

// ────────────────────────────────────────────────────────────────────────
// issue #118: 保存後に pdfjs proxy / キャッシュを破棄し、ページ画像の再 render を
// トリガーする (保存→ズームで画像が固着する不具合の修正)。
// ────────────────────────────────────────────────────────────────────────
describe('useFileOperations 保存後の pdfjs 再 render トリガー (issue #118)', () => {
  /**
   * dirty ページ 1 件を持つ doc を store に投入する共通セットアップ。
   * 他テストの残留 undo/redo 履歴が混ざらないよう履歴も明示クリアして
   * テストを自己完結させる。
   */
  function setupSavableDoc(filePath: string): PecoDocument {
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [{ id: 'blk', text: 'HELLO', isDirty: true }],
      isDirty: true,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      isDirty: true,
      undoStack: [],
      redoStack: [],
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  function setupPageOrderDoc(
    filePath: string,
    pageOrder: number[],
    pageTexts: string[],
    currentPageIndex = 0,
  ): PecoDocument {
    const pages = new Map<number, PageData>(
      pageTexts.map((text, pageIndex) => [
        pageIndex,
        {
          pageIndex,
          width: 595,
          height: 842,
          textBlocks: [{ id: `blk-${pageIndex}`, text, isDirty: true }],
          isDirty: true,
          thumbnail: null,
        } as unknown as PageData,
      ]),
    );
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: pageTexts.length,
      metadata: {},
      pages,
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      pageOrder,
      currentPageIndex,
      isDirty: true,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  it('OCR実行中の手動保存はPDF生成に入らずブロックされる', async () => {
    setupSavableDoc('/ocr/save-blocked.pdf');

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true };
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef as any)
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(clearTemporaryChanges).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'OCR実行中は保存できません。OCRを中止または完了してから保存してください。',
      true,
    );
  });

  it('フォルダOCR用のbypass指定ではOCR実行中でも保存できる', async () => {
    setupSavableDoc('/ocr/folder-save.pdf');

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true };
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef as any)
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave({ bypassOcrGuard: true });
    });

    expect(ok).toBe(true);
    expect(savePDF).toHaveBeenCalled();
  });

  it('フォルダOCR用のbypass指定ではsidecar保存もOCR実行中に実行できる', async () => {
    setupSavableDoc('/ocr/folder-sidecar.pdf');

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true };
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef as any)
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSaveTo('/ocr/folder-sidecar.peco.pdf', { bypassOcrGuard: true });
    });

    expect(ok).toBe(true);
    expect(savePDF).toHaveBeenCalled();
  });

  it('PCT-034: 非identity pageOrder 保存後は新しい物理PDFに合わせて identity へ正規化する', async () => {
    const pages = new Map<number, PageData>([
      [0, { pageIndex: 0, width: 595, height: 842, textBlocks: [{ id: 'p2', text: 'page-2', isDirty: false }], isDirty: false, thumbnail: null } as unknown as PageData],
      [1, { pageIndex: 1, width: 595, height: 842, textBlocks: [{ id: 'p0', text: 'page-0', isDirty: false }], isDirty: false, thumbnail: null } as unknown as PageData],
      [2, { pageIndex: 2, width: 595, height: 842, textBlocks: [{ id: 'p1', text: 'page-1', isDirty: false }], isDirty: false, thumbnail: null } as unknown as PageData],
    ]);
    const doc: PecoDocument = {
      filePath: '/reload/reordered.pdf',
      fileName: 'reordered.pdf',
      totalPages: 3,
      metadata: {},
      pages,
    };
    usePecoStore.setState({
      document: doc,
      pageOrder: [2, 0, 1],
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [
        { type: 'reorder_pages', beforeOrder: [0, 1, 2], afterOrder: [2, 0, 1] },
      ],
      redoStack: [],
    });
    __originalBytesCacheForTest.set('/reload/reordered.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    let after = usePecoStore.getState();
    expect((savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls[0][5]).toEqual([2, 0, 1]);
    expect(after.pageOrder).toEqual([0, 1, 2]);
    expect(after.document!.pages.get(0)!.textBlocks[0].text).toBe('page-2');
    expect(after.undoStack.some((action) => action.type === 'reorder_pages')).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });

    after = usePecoStore.getState();
    expect((savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[5]).toEqual([0, 1, 2]);
    expect(after.pageOrder).toEqual([0, 1, 2]);
  });

  it('PCT-037: savePDF 前に pageOrder が変わっても保存開始時の pageOrder を使い、live pageOrder を正規化で潰さない', async () => {
    const snapshotDoc = setupPageOrderDoc('/pct037/page-order-race.pdf', [2, 0, 1], ['snapshot-2', 'snapshot-0', 'snapshot-1']);
    const cleanPages = new Map<number, PageData>(
      [...snapshotDoc.pages.entries()].map(([idx, page]) => [
        idx,
        {
          ...page,
          textBlocks: page.textBlocks.map((block: any) => ({ ...block, isDirty: false })),
          isDirty: false,
        } as unknown as PageData,
      ]),
    );
    usePecoStore.setState({
      document: { ...snapshotDoc, pages: cleanPages },
      isDirty: true,
    });

    (getAllTemporaryPageData as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      usePecoStore.setState({
        document: {
          ...usePecoStore.getState().document!,
          pages: cleanPages,
        },
        pageOrder: [1, 0, 2],
        undoStack: [
          { type: 'reorder_pages', beforeOrder: [2, 0, 1], afterOrder: [1, 0, 2] },
        ],
      });
      return new Map();
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    const savePdfMock = savePDF as unknown as ReturnType<typeof vi.fn>;
    const [, savedDoc] = savePdfMock.mock.calls[0] as [unknown, PecoDocument];
    expect(savePdfMock.mock.calls[0][5]).toEqual([2, 0, 1]);
    expect(savedDoc.pages.size).toBe(0);
    expect(usePecoStore.getState().pageOrder).toEqual([1, 0, 2]);
    expect(usePecoStore.getState().undoStack.some((action) => action.type === 'reorder_pages')).toBe(true);
    expect([...usePecoStore.getState().document!.pages.values()].every((page) => !page.isDirty)).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
    expect(usePecoStore.getState().lastSavedActionIndex).toBe(0);
  });

  it('#118: 上書き保存が成功すると destroySharedPdfProxy が呼ばれ documentEpoch が +1 される', async () => {
    setupSavableDoc('/reload/save.pdf');
    // documentEpoch を既知値にしておき、保存後に +1 されたことを確認する。
    useInfraStore.setState({ documentEpoch: 7 });
    const { destroySharedPdfProxy } = await import('../../utils/pdfLoader');
    (destroySharedPdfProxy as unknown as ReturnType<typeof vi.fn>).mockClear();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    // 保存後、ディスク上の PDF を開いていた stale な pdfjs proxy / bitmap /
    // page-proxy キャッシュが破棄されている。
    expect(destroySharedPdfProxy).toHaveBeenCalled();
    // documentEpoch が +1 され、usePageNavigation / usePdfRendering が
    // proxy を取り直して現在ページ画像を再 render するトリガーになる。
    expect(useInfraStore.getState().documentEpoch).toBe(8);
  });

  it('#118: 保存が成功しても textBlocks / currentPageIndex / zoom は変化しない (画像のみ再 render)', async () => {
    const doc = setupSavableDoc('/reload/preserve.pdf');
    // ユーザーが page index / zoom を変えている状態を再現。
    useInfraStore.setState({ documentEpoch: 3 });
    usePecoStore.setState({ currentPageIndex: 0 } as any);
    const originalBlocks = doc.pages.get(0)!.textBlocks;

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.handleSave();
    });

    const after = usePecoStore.getState();
    const afterInfra = useInfraStore.getState();
    // epoch だけ進む。
    expect(afterInfra.documentEpoch).toBe(4);
    // 編集の source-of-truth (textBlocks) は同一参照のまま保持される。
    expect(after.document!.pages.get(0)!.textBlocks).toBe(originalBlocks);
    expect(after.document!.pages.get(0)!.textBlocks[0].text).toBe('HELLO');
    // ページ index は保存で巻き戻らない。
    expect(after.currentPageIndex).toBe(0);
    // undo/redo 履歴も保存では消えない。
    expect(after.undoStack).toEqual([]);
    expect(after.redoStack).toEqual([]);
  });

  it('PCT-034: reordered save normalizes current-session pageOrder and second save uses identity', async () => {
    setupPageOrderDoc('/pct034/reorder.pdf', [2, 0, 1], ['page-2', 'page-0', 'page-1'], 1);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    const savePdfMock = savePDF as unknown as ReturnType<typeof vi.fn>;
    expect(savePdfMock.mock.calls[0][5]).toEqual([2, 0, 1]);
    expect(usePecoStore.getState().pageOrder).toEqual([0, 1, 2]);
    expect(usePecoStore.getState().currentPageIndex).toBe(1);
    expect(usePecoStore.getState().document!.pages.get(0)!.textBlocks[0].text).toBe('page-2');
    expect(usePecoStore.getState().document!.pages.get(1)!.textBlocks[0].text).toBe('page-0');
    expect(usePecoStore.getState().document!.pages.get(2)!.textBlocks[0].text).toBe('page-1');

    await act(async () => {
      await result.current.handleSave();
    });

    expect(savePdfMock.mock.calls[1][5]).toEqual([0, 1, 2]);
  });

  it('PCT-034: deleted save normalizes remaining source mapping before a second save', async () => {
    setupPageOrderDoc('/pct034/delete.pdf', [0, 2], ['page-0', 'page-2'], 1);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    const savePdfMock = savePDF as unknown as ReturnType<typeof vi.fn>;
    expect(savePdfMock.mock.calls[0][5]).toEqual([0, 2]);
    expect(usePecoStore.getState().pageOrder).toEqual([0, 1]);
    expect(usePecoStore.getState().currentPageIndex).toBe(1);
    expect(usePecoStore.getState().document!.totalPages).toBe(2);
    expect(usePecoStore.getState().document!.pages.get(1)!.textBlocks[0].text).toBe('page-2');

    await act(async () => {
      await result.current.handleSave();
    });

    expect(savePdfMock.mock.calls[1][5]).toEqual([0, 1]);
  });

  it('#118: 保存が失敗 (writeFileAtomically が reject) した場合は documentEpoch を進めない', async () => {
    setupSavableDoc('/reload/fail.pdf');
    useInfraStore.setState({ documentEpoch: 5 });

    // replace_pdf_file が reject されて保存が失敗する。
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error('disk full: ENOSPC'));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    let ok = true;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(false);
    // 書き込みに失敗したので再 render トリガーは出さない。
    expect(useInfraStore.getState().documentEpoch).toBe(5);
  });

  it('#118: 別名保存 (Save As) が成功すると documentEpoch が +1 される', async () => {
    setupSavableDoc('/reload/src.pdf');
    useInfraStore.setState({ documentEpoch: 2 });

    // save ダイアログが新しいパスを返す。
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/reload/dst.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    await act(async () => {
      await result.current.executeSaveAs();
    });

    // 別名保存も _executeSave 経由なので epoch bump が走る。
    // (filePath 変更でも reload は走るが、epoch bump が抜けていないことを担保する)
    expect(useInfraStore.getState().documentEpoch).toBe(3);
  });

  it('#118: bumpDocumentEpoch ストアアクションは documentEpoch だけを進め他の状態を変えない', () => {
    const doc = setupSavableDoc('/reload/action.pdf');
    useInfraStore.setState({ documentEpoch: 10 });
    usePecoStore.setState({
      currentPageIndex: 0,
      isDirty: true,
    });
    const blocksBefore = doc.pages.get(0)!.textBlocks;

    usePecoStore.getState().bumpDocumentEpoch();

    const s = usePecoStore.getState();
    const sInfra = useInfraStore.getState();
    expect(sInfra.documentEpoch).toBe(11);
    // document 本体・pages・textBlocks 参照は不変。
    expect(s.document).toBe(doc);
    expect(s.document!.pages.get(0)!.textBlocks).toBe(blocksBefore);
    // currentPageIndex / isDirty も不変。
    expect(s.currentPageIndex).toBe(0);
    expect(s.isDirty).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// executeSaveAs — cancel / reject パス (test gap fill wave 2)
// ────────────────────────────────────────────────────────────────────────

describe('useFileOperations executeSaveAs — cancel / error paths (wave 2)', () => {
  function setupSavableDoc(filePath: string): PecoDocument {
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [{ id: 'blk', text: 'HELLO', isDirty: true }],
      isDirty: true,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: true, undoStack: [], redoStack: [] });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  // ── U-FOp-01: ユーザー cancel (savePath=null) → no-op ────────────────

  it('U-FOp-01: user cancels save dialog (path=null) → executeSaveAs is a no-op', async () => {
    setupSavableDoc('/saveas/cancel.pdf');

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    // save ダイアログが null を返したら toast も呼ばれず、savePDF も呼ばれない
    expect(savePDF).not.toHaveBeenCalled();
    // store の filePath は変わっていない
    expect(usePecoStore.getState().document!.filePath).toBe('/saveas/cancel.pdf');
    // isDirty も変わらない
    expect(usePecoStore.getState().isDirty).toBe(true);
  });

  // ── U-FOp-02: document が null → executeSaveAs は何もしない ──────────

  it('U-FOp-02: document=null → executeSaveAs returns without calling savePDF', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  // ── U-FOp-03: isSaving=true → executeSaveAs は toast を出して no-op ──

  it('U-FOp-03: isSavingRef.current=true → executeSaveAs shows toast and returns early', async () => {
    setupSavableDoc('/saveas/locked.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    // handleSave を先に開始して isSavingRef=true を作る
    let resolveSavePdf!: (bytes: Uint8Array) => void;
    const hangSave = new Promise<Uint8Array>((resolve) => { resolveSavePdf = resolve; });
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(hangSave);

    // handleSave を非同期に開始しておく
    const saveTask = result.current.handleSave();

    // savePDF が呼ばれるまで待機 → isSavingRef=true になっている
    await vi.waitFor(() => {
      expect(savePDF).toHaveBeenCalled();
    });

    // isSaving 中に executeSaveAs を呼ぶ
    await act(async () => {
      await result.current.executeSaveAs();
    });

    // isSaving 中のトーストが出ている
    const toastCalls = showToast.mock.calls.map(([msg]: [string]) => msg);
    expect(toastCalls.some((m) => m.includes('保存処理が進行中'))).toBe(true);

    // 後片付け: hang を解放する
    resolveSavePdf(new Uint8Array([9, 9, 9]));
    await saveTask;
  });

  // ── U-FOp-04: writeFile reject (EACCES) → error toast が出る ─────────

  it('U-FOp-04: writeFile (replace_pdf_file) throws on SaveAs → error toast shown', async () => {
    setupSavableDoc('/saveas/eacces-src.pdf');

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/saveas/eacces-dst.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error('rename failed: EACCES: permission denied'));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    // エラートーストが出ている
    const errorCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] === true);
    expect(errorCalls.length).toBeGreaterThan(0);
    // 「名前を付けて保存に失敗」メッセージ
    const lastErrorMsg = String(errorCalls[errorCalls.length - 1][0]);
    expect(lastErrorMsg).toMatch(/名前を付けて保存に失敗/);
  });

  // ── U-FOp-05: 正常 SaveAs → success toast + filePath 更新 ──────────

  it('U-FOp-05: successful SaveAs → success toast and filePath updated in store', async () => {
    setupSavableDoc('/saveas/src.pdf');

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/saveas/dst.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation(() => Promise.resolve(undefined));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    // 成功トーストが出ている
    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    expect(successCalls.length).toBeGreaterThan(0);
    const lastSuccessMsg = String(successCalls[successCalls.length - 1][0]);
    expect(lastSuccessMsg).toMatch(/名前を付けて保存/);

    // filePath が新しいパスに更新されている
    expect(usePecoStore.getState().document!.filePath).toBe('/saveas/dst.pdf');
  });

  // ── U-FOp-06: onRequestSaveDialog 指定時の EACCES フォールバック ────────

  it('U-FOp-06: onRequestSaveDialog callback is invoked when EACCES error occurs during handleSave', async () => {
    setupSavableDoc('/saveas/dialog-cb.pdf');

    const onRequestSaveDialog = vi.fn();
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        return Promise.reject(new Error('Access is denied. (os error 5)'));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestSaveDialog,
      ),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    // エラートーストが出ている
    const errorCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] === true);
    expect(errorCalls.length).toBeGreaterThan(0);

    // EACCES 系エラーのとき action.onClick で onRequestSaveDialog が呼ばれる
    const lastErrorCall = errorCalls[errorCalls.length - 1] as unknown[];
    const actionObj = lastErrorCall[2] as { label: string; onClick: () => void } | undefined;
    expect(actionObj).toBeDefined();
    expect(actionObj!.label).toBe('別名で保存');

    // onClick を呼ぶと onRequestSaveDialog が起動される
    actionObj!.onClick();
    expect(onRequestSaveDialog).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-074 (HUNT-C3): handleOpen の loadPDF await 後に isSavingRef を再チェックする。
// loadPDF は大型 PDF で数秒〜数十秒かかり、その間に開始された保存処理と
// clearTemporaryChanges / setDocument が交差すると退避 dirty ページが欠落した
// まま上書き保存される。
// ────────────────────────────────────────────────────────────────────────

describe('PCT-074: loadPDF await 中に保存が開始された場合の競合ガード', () => {
  it('loadPDF 解決時に保存中なら clearTemporaryChanges を呼ばず document も差し替えない', async () => {
    const dirtyPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as PageData;
    const currentDoc = {
      filePath: '/pct074/current.pdf',
      fileName: 'current.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as PecoDocument;
    usePecoStore.setState({ document: currentDoc, isDirty: true });
    (ask as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    // loadPDF を deferred 化して「ロード中」を再現する
    let resolveLoad!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openPromise = result.current.handleOpen('/pct074/next.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct074/next.pdf'));

    // loadPDF の await 中に別経路 (executeSaveAs 等) で保存が開始された状況を再現
    result.current.isSavingRef.current = true;

    resolveLoad({
      filePath: '/pct074/next.pdf',
      fileName: 'next.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map(),
    });

    // 修正前: clearTemporaryChanges('/pct074/current.pdf') → setDocument が走り true を返す。
    // 修正後: 再チェックで中断して false。
    await expect(openPromise).resolves.toBe(false);
    expect(clearTemporaryChanges).not.toHaveBeenCalled();
    expect(usePecoStore.getState().document).toBe(currentDoc);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存中のため読み込みを中止/),
    );

    result.current.isSavingRef.current = false;
  });

  it('ファイル読込中 (loadPDF await 中) の handleSave は拒否されて savePDF を呼ばない', async () => {
    const cleanPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
    } as PageData;
    const currentDoc = {
      filePath: '/pct074/loaded.pdf',
      fileName: 'loaded.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, cleanPage]]),
    } as PecoDocument;
    usePecoStore.setState({ document: currentDoc, isDirty: false });
    __originalBytesCacheForTest.set('/pct074/loaded.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    let resolveLoad!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openPromise = result.current.handleOpen('/pct074/incoming.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct074/incoming.pdf'));

    // ロード中の Ctrl+S 相当 (読込中オーバーレイはビューア区画のみでキーは素通りする)
    let saved = true;
    await act(async () => {
      saved = await result.current.handleSave();
    });

    // 修正前: 保存が開始されて savePDF が呼ばれる。修正後: ガードで拒否。
    expect(saved).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/読み込み中は保存できません/),
    );

    // 後片付け: ロードを完走させる
    await act(async () => {
      resolveLoad({
        filePath: '/pct074/incoming.pdf',
        fileName: 'incoming.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openPromise;
    });
  });

  it('読込完了後の handleSave は通常通り保存できる (ガードが解除される)', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/pct074/after-load.pdf');
    });

    // 開いた doc を dirty にして保存可能な状態を作る
    const loadedDoc = usePecoStore.getState().document!;
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as PageData;
    usePecoStore.setState({
      document: { ...loadedDoc, pages: new Map([[0, dirtyPage]]) } as PecoDocument,
      isDirty: true,
    });
    __originalBytesCacheForTest.set(loadedDoc.filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    let saved = false;
    await act(async () => {
      saved = await result.current.handleSave();
    });

    expect(saved).toBe(true);
    expect(savePDF).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-207 (#443): handleOpen の並行呼び出しに世代管理を導入する。
// 先発の loadPDF が後発より遅れて解決しても、後発の setDocument を
// 追い越して上書きしてはいけない。
// ────────────────────────────────────────────────────────────────────────

describe('PCT-207: handleOpen 並行呼び出しの世代管理', () => {
  it('A→B の順で呼び出し、B→A の順で完了しても最終文書は B (先発Aは静かに中断する)', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    let resolveA!: (doc: unknown) => void;
    let resolveB!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    // A を呼び出す (loadPDF 未解決のまま止まる)
    const openA = result.current.handleOpen('/pct207/a.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct207/a.pdf'));

    // A が loadPDF を await している間に B を呼び出す (世代が進む)
    const openB = result.current.handleOpen('/pct207/b.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct207/b.pdf'));

    const docB = {
      filePath: '/pct207/b.pdf',
      fileName: 'b.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map(),
    };
    const docA = {
      filePath: '/pct207/a.pdf',
      fileName: 'a.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map(),
    };

    // 完了順を呼び出し順と逆にする: B (後発) を先に完了させる
    let resultB = false;
    await act(async () => {
      resolveB(docB);
      resultB = await openB;
    });
    expect(resultB).toBe(true);
    expect(usePecoStore.getState().document?.filePath).toBe('/pct207/b.pdf');

    // A (先発) が遅れて完了 → 世代が既に進んでいるので中断し false を返す
    let resultA = true;
    await act(async () => {
      resolveA(docA);
      resultA = await openA;
    });

    expect(resultA).toBe(false);
    // A の遅延完了によって B の document が上書きされていないこと (最終文書は B)
    expect(usePecoStore.getState().document?.filePath).toBe('/pct207/b.pdf');
  });

  it('先発Aが後発Bより後に完了しても、Aの完了で読込中フラグを誤って倒さない', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    let resolveA!: (doc: unknown) => void;
    let resolveB!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openA = result.current.handleOpen('/pct207/a2.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct207/a2.pdf'));
    const openB = result.current.handleOpen('/pct207/b2.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct207/b2.pdf'));

    // B (最新世代) をまだ解決させない。A だけ先に解決させて中断させる。
    await act(async () => {
      resolveA({
        filePath: '/pct207/a2.pdf',
        fileName: 'a2.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openA;
    });

    // A の finally が isLoadingFileRef を倒していないこと (B がまだロード中) を
    // handleSave 経由で確認する: 読込中は保存拒否されるはず。
    let saved = true;
    await act(async () => {
      saved = await result.current.handleSave();
    });
    expect(saved).toBe(false);

    // B を完了させて後片付け。
    await act(async () => {
      resolveB({
        filePath: '/pct207/b2.pdf',
        fileName: 'b2.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openB;
    });
    expect(usePecoStore.getState().document?.filePath).toBe('/pct207/b2.pdf');
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-076 (HUNT-C5): suppressOcrZeroPrompt オプション。
// バッチジョブの機械的なオープンでは onOpenComplete (App 側で
// checkAndPromptOcrZero に配線) を発火させない。
// ────────────────────────────────────────────────────────────────────────

describe('PCT-076: handleOpen suppressOcrZeroPrompt オプション', () => {
  it('suppressOcrZeroPrompt 指定時は onOpenComplete が呼ばれない', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const onOpenComplete = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, onOpenComplete),
    );

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/pct076/batch.pdf', {
        bypassOcrGuard: true,
        suppressOcrZeroPrompt: true,
      });
    });

    // 読み込み自体は成功するが、OCR ゼロ検出プロンプトへの配線は発火しない
    expect(opened).toBe(true);
    expect(onOpenComplete).not.toHaveBeenCalled();
  });

  it('オプション未指定時は従来通り onOpenComplete が doc 付きで呼ばれる (後方互換)', async () => {
    usePecoStore.setState({ document: null, isDirty: false });

    const showToast = vi.fn();
    const onOpenComplete = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, onOpenComplete),
    );

    let opened = false;
    await act(async () => {
      opened = await result.current.handleOpen('/pct076/manual.pdf');
    });

    expect(opened).toBe(true);
    expect(onOpenComplete).toHaveBeenCalledTimes(1);
    expect(onOpenComplete.mock.calls[0][0]).toMatchObject({ filePath: '/fixed/path.pdf' });
  });
});

// ── PCT-101/C1: 保存成功パスが invalidateBBoxMetaCache() を呼ぶ配線テスト ────
describe('PCT-101/C1: 保存成功パスが invalidateBBoxMetaCache を呼ぶ', () => {
  function setupSavableDoc(filePath: string): void {
    const dirtyPage = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [{ id: 'blk', text: 'HELLO', isDirty: true }],
      isDirty: true,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      isDirty: true,
      undoStack: [],
      redoStack: [],
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  }

  beforeEach(() => {
    (invalidateBBoxMetaCache as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('上書き保存が成功すると invalidateBBoxMetaCache が呼ばれる', async () => {
    setupSavableDoc('/pct101/save.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    // 保存成功パスで stale キャッシュが破棄されること
    expect(invalidateBBoxMetaCache).toHaveBeenCalled();
  });

  it('保存が失敗 (savePDF が reject) した場合は invalidateBBoxMetaCache が呼ばれない', async () => {
    setupSavableDoc('/pct101/fail.pdf');
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save failed'),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));
    let ok = true;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(false);
    // 失敗パスではキャッシュ破棄しない（ディスクが書き換わっていないため）
    expect(invalidateBBoxMetaCache).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-104 差し戻し R1: remap ターゲット順序ゲーティング
// normalize が成立しない経路（handleSaveTo）では remap の normalizedPageOrder 引数が
// savePageOrder と同一になり、全エントリ newKey==oldKey で不動点退化することを検証する。
// ────────────────────────────────────────────────────────────────────────
describe('PCT-104 R1: remap ターゲット順序ゲーティング', () => {
  function setupSavableDocWithPageOrder(
    filePath: string,
    pageOrder: number[],
  ): PecoDocument {
    const pages = new Map<number, PageData>(
      pageOrder.map((sourceIndex, displayIndex) => [
        displayIndex,
        {
          pageIndex: displayIndex,
          width: 595,
          height: 842,
          textBlocks: [{ id: `blk-${sourceIndex}`, text: `text-${sourceIndex}`, isDirty: true }],
          isDirty: true,
          thumbnail: null,
        } as unknown as PageData,
      ]),
    );
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: pageOrder.length,
      metadata: {},
      pages,
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      pageOrder,
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  it('R1: normalizePageOrderForCurrentDocument=false (handleSaveTo 経路) のとき remap の normalizedPageOrder が savePageOrder になる', async () => {
    // savePageOrder = [1, 0, 2]（move 後）
    // normalizePageOrderForCurrentDocument=false なので normalize は呼ばれない
    // → remap 第3引数（normalizedPageOrder）は savePageOrder=[1,0,2] でなければならない
    const savePageOrder = [1, 0, 2];
    setupSavableDocWithPageOrder('/pct104r1/saveto.pdf', savePageOrder);

    const remapMock = remapTemporaryPageEntries as unknown as ReturnType<typeof vi.fn>;
    remapMock.mockClear();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSaveTo('/pct104r1/saveto.pdf');
    });

    expect(ok).toBe(true);
    expect(remapMock).toHaveBeenCalled();
    const [, remapOldOrder, remapNormalizedOrder] = remapMock.mock.calls[0] as [string, number[], number[], string[]];
    // 第2引数 (oldPageOrder) は savePageOrder
    expect(remapOldOrder).toEqual(savePageOrder);
    // 第3引数 (normalizedPageOrder) も savePageOrder（ゲーティングにより不動点退化）
    expect(remapNormalizedOrder).toEqual(savePageOrder);
  });

  it('R1: 通常保存（normalizePageOrderForCurrentDocument=true 且つ pageOrderMatchesSnapshot）のとき remap の normalizedPageOrder は store の identity order になる', async () => {
    // savePageOrder = [0, 1, 2]（identity）
    // 保存中の move なし（pageOrderMatchesSnapshot=true）
    // normalize 後の pageOrder も [0,1,2]
    const savePageOrder = [0, 1, 2];
    setupSavableDocWithPageOrder('/pct104r1/normal.pdf', savePageOrder);

    const remapMock = remapTemporaryPageEntries as unknown as ReturnType<typeof vi.fn>;
    remapMock.mockClear();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    expect(remapMock).toHaveBeenCalled();
    const [, , remapNormalizedOrder] = remapMock.mock.calls[0] as [string, number[], number[], string[]];
    // 通常経路では normalizedPageOrder は post-normalize 順（この場合 identity）
    expect(remapNormalizedOrder).toEqual([0, 1, 2]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PCT-106 / PCT-109: 全ページ位置補正適用（applyOffsetAllPages）の
// 可用性・進捗通知の回帰テスト。
//   PCT-106: ループ内 loadPage の 1 ページ失敗で保存全体が中断しないこと。
//   PCT-109: ページ進捗が showToast で通知されること。
// previewOcrOffset 経路（applyOffsetAllPages=true）を入口に検証する。
// ────────────────────────────────────────────────────────────────────────
describe('useFileOperations 全ページ位置補正適用 (PCT-106 / PCT-109)', () => {
  /**
   * 全ページ位置補正の入口（previewOcrOffset）を駆動できる multi-page doc を投入する。
   * 全ページ未抽出 (isTextExtracted=false) にして loadAllPagesWithTextBlocks の
   * loadPage ループに入るようにする。
   */
  function setupMultiPageDoc(filePath: string, totalPages: number): PecoDocument {
    const pages = new Map<number, PageData>();
    for (let i = 0; i < totalPages; i += 1) {
      pages.set(i, {
        pageIndex: i,
        width: 595,
        height: 842,
        textBlocks: [],
        imageBlocks: [],
        isDirty: false,
        isTextExtracted: false,
        thumbnail: null,
      } as unknown as PageData);
    }
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages,
      metadata: {},
      pages,
    } as unknown as PecoDocument;
    usePecoStore.setState({
      document: doc,
      pageOrder: Array.from({ length: totalPages }, (_, i) => i),
      currentPageIndex: 0,
      isDirty: false,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  beforeEach(() => {
    (getSharedPdfProxy as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    // open_pdf_preview を含む全 invoke を成功させる
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => Promise.resolve(undefined),
    );
  });

  it('PCT-106: 1 ページの抽出が失敗しても保存（PDF生成）まで完走し、他ページは反映される', async () => {
    setupMultiPageDoc('/offset/partial-fail.pdf', 3);

    const loadPageMock = loadPage as unknown as ReturnType<typeof vi.fn>;
    // displayIdx 1（source 1）のロードだけ失敗させ、残り 2 ページは成功させる。
    loadPageMock.mockImplementation(
      (_pdf: unknown, sourceIndex: number) => {
        if (sourceIndex === 1) {
          return Promise.reject(new Error('pdfjs extraction failed'));
        }
        return Promise.resolve({
          pageIndex: sourceIndex,
          textBlocks: [],
          imageBlocks: [],
          isDirty: false,
          isTextExtracted: true,
        });
      },
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    // 1 ページ失敗でも全体は reject せず、PDF 生成（savePDF）まで到達する。
    expect(savePDF).toHaveBeenCalled();
    expect(ok).toBe(true);
    // 3 ページ分の loadPage が試行された（失敗ページも try 内で呼ばれる）。
    expect(loadPageMock).toHaveBeenCalledTimes(3);
    // 失敗ページ数がエラートーストで可視化される。
    const failToastCalls = showToast.mock.calls.filter(
      ([msg, isError]) => isError === true && typeof msg === 'string' && msg.includes('位置補正適用に失敗'),
    );
    expect(failToastCalls.length).toBe(1);
    expect(failToastCalls[0][0]).toContain('1ページ');
  });

  it('PCT-109: ページ進捗が showToast で通知される（最終ページは必ず通知）', async () => {
    setupMultiPageDoc('/offset/progress.pdf', 3);

    (loadPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      textBlocks: [],
      imageBlocks: [],
      isDirty: false,
      isTextExtracted: true,
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.previewOcrOffset();
    });

    // 進捗トーストは間引かれるが、最終ページ (3/3) は必ず出る。
    const progressToasts = showToast.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('全ページ位置補正を適用中'),
    );
    expect(progressToasts.length).toBeGreaterThanOrEqual(1);
    const lastProgress = progressToasts[progressToasts.length - 1][0] as string;
    expect(lastProgress).toContain('(3/3ページ)');
  });

  it('PCT-106: 全ページ成功時は失敗トーストを出さず保存完走する', async () => {
    setupMultiPageDoc('/offset/all-ok.pdf', 2);

    (loadPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      textBlocks: [],
      imageBlocks: [],
      isDirty: false,
      isTextExtracted: true,
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok = false;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    expect(ok).toBe(true);
    expect(savePDF).toHaveBeenCalled();
    const failToastCalls = showToast.mock.calls.filter(
      ([, isError]) => isError === true,
    );
    // 位置補正失敗トーストは出ない（他のエラートーストも基本出ない経路）。
    const offsetFail = failToastCalls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('位置補正適用に失敗'),
    );
    expect(offsetFail.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// coverage gap-fill wave 5: 保存失敗時のサイレント失敗ガード、監査ログ書き込み
// 失敗時の保存継続性 (#413隣接)、上書き/別名保存の未カバー分岐、
// handleSaveTo / previewOcrOffset / saveAllPagesWithOffset のガード・失敗系、
// PCT-118 (temp 書込先は fs scope 検証しない設計) の回帰ガードを追加する。
// ────────────────────────────────────────────────────────────────────────

/**
 * 保存対象になる単一 dirty ページを持つ doc を store にセットする共通ヘルパ。
 * withCache=false のときは originalBytes module-level cache を投入しない
 * (readFile 経由の再取得パスを検証したいテスト向け)。
 */
function makeSingleDirtyPageDoc(
  filePath: string,
  opts: { withCache?: boolean } = {},
): PecoDocument {
  const { withCache = true } = opts;
  const dirtyPage = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [{ id: 'blk', text: 'T', isDirty: true }],
    isDirty: true,
    thumbnail: null,
  } as unknown as PageData;
  const doc: PecoDocument = {
    filePath,
    fileName: filePath.split('/').pop()!,
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, dirtyPage]]),
  } as unknown as PecoDocument;
  usePecoStore.setState({
    document: doc,
    isDirty: true,
    undoStack: [],
    redoStack: [],
    lastSavedActionIndex: 0,
  });
  if (withCache) {
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  }
  return doc;
}

describe('useFileOperations _executeSave サイレント失敗ガード (coverage gap-fill wave5)', () => {
  it('原本PDF (originalBytes) の再取得に失敗した場合、savePDFを呼ばずユーザーへ通知して失敗する', async () => {
    // cache 未投入 + readFile が失敗するケース。ensurePrefetchOriginalBytes は
    // 例外を内部で握りつぶし null を返す (console.warn のみ)。この null を
    // _executeSave が確実にユーザー通知へ変換していることを検証する。
    makeSingleDirtyPageDoc('/silent/original-bytes.pdf', { withCache: false });
    (readFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOENT: no such file or directory'),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/元のPDFファイルが移動または削除された可能性があります/),
      true,
    );
  });

  it('日本語フォントの読み込みに失敗した場合、savePDFを呼ばずユーザーへ通知して失敗する', async () => {
    makeSingleDirtyPageDoc('/silent/font.pdf');
    (loadFontLazy as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/日本語フォントの読み込みに失敗しました/),
      true,
    );
  });

  it('記号フォールバックフォントの読み込みに失敗した場合、savePDFを呼ばずユーザーへ通知して失敗する', async () => {
    makeSingleDirtyPageDoc('/silent/fallback-font.pdf');
    (loadFallbackFontsLazy as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/記号フォントの読み込みに失敗しました/),
      true,
    );
  });

  it('Meiryoフォントで保存に失敗した場合、内蔵IPAmjMinchoへ自動リトライして保存を完走する', async () => {
    makeSingleDirtyPageDoc('/silent/meiryo-retry-ok.pdf');
    (getPrimaryFontKind as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('meiryo');
    (savePDF as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('meiryo embed failed'))
      .mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(true);
    expect(disableSystemFontForSession).toHaveBeenCalledTimes(1);
    expect(loadBundledIpAmjFontLazy).toHaveBeenCalledTimes(1);
    expect(savePDF).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/保存しました/));
  });

  it('Meiryoリトライでも内蔵フォント読込に失敗した場合は元のエラーで保存失敗になる', async () => {
    makeSingleDirtyPageDoc('/silent/meiryo-retry-fail.pdf');
    (getPrimaryFontKind as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('meiryo');
    const originalErr = new Error('meiryo embed failed hard');
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(originalErr);
    (loadBundledIpAmjFontLazy as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(savePDF).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存に失敗しました.*meiryo embed failed hard/),
      true,
    );
  });

  it('Meiryo以外のフォント種別でsavePDFが失敗した場合はリトライせず即座に失敗する', async () => {
    makeSingleDirtyPageDoc('/silent/non-meiryo-fail.pdf');
    // getPrimaryFontKind はデフォルト 'bundled' のまま (meiryo ではない)
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('bundled font embed failed'),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(savePDF).toHaveBeenCalledTimes(1);
    expect(loadBundledIpAmjFontLazy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存に失敗しました.*bundled font embed failed/),
      true,
    );
  });

  it('保存中 (writeFile完了直後) に別のPDFへ切り替わっていた場合、状態反映を中止してエラー通知する', async () => {
    makeSingleDirtyPageDoc('/silent/race-switch.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        // replace_pdf_file (atomic rename) が完了した直後に別PDFが開かれた状況を再現する。
        usePecoStore.setState({
          document: {
            filePath: '/other/switched-during-save.pdf',
            fileName: 'switched-during-save.pdf',
            totalPages: 1,
            metadata: {},
            pages: new Map(),
          } as unknown as PecoDocument,
        });
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/別のPDFへ切り替わったため、状態反映を中止しました/),
      true,
    );
  });
});

describe('useFileOperations 監査ログ書き込み失敗時の保存継続性 (issue #413隣接)', () => {
  function setupAuditableDirtyDoc(filePath: string): void {
    makeSingleDirtyPageDoc(filePath);
    // computeSaveDiff が entries>0 を返すよう undoStack に更新エントリを積む
    usePecoStore.setState({
      undoStack: [
        {
          type: 'update_page',
          pageIndex: 0,
          before: { textBlocks: [{ id: 'blk', text: 'OLD', isDirty: false }] },
          after: { textBlocks: [{ id: 'blk', text: 'T', isDirty: true }] },
        },
      ] as unknown as ReturnType<typeof usePecoStore.getState>['undoStack'],
      lastSavedActionIndex: 0,
    });
  }

  it('write_audit_log が失敗しても handleSave は成功として扱われ、成功トーストが出る', async () => {
    setupAuditableDirtyDoc('/audit/handle-save-fail.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'write_audit_log') return Promise.reject(new Error('disk full'));
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(true);
    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    expect(successCalls.some((args) => String(args[0]).includes('保存しました'))).toBe(true);
  });

  it('write_audit_log が失敗しても executeSaveAs (別名保存) は成功として扱われる', async () => {
    setupAuditableDirtyDoc('/audit/save-as-fail.pdf');

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/audit/save-as-target.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'write_audit_log') return Promise.reject(new Error('disk full'));
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    const successCalls = showToast.mock.calls.filter((args: unknown[]) => args[1] !== true);
    expect(successCalls.some((args) => String(args[0]).includes('名前を付けて保存しました'))).toBe(true);
  });
});

describe('useFileOperations executeSaveAs 未カバー分岐 (coverage gap-fill wave5)', () => {
  it('compression=rasterized を指定すると警告トーストを出して none にフォールバックする', async () => {
    makeSingleDirtyPageDoc('/saveas/rasterized.pdf');
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/saveas/rasterized-out.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs({ compression: 'rasterized' });
    });

    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/高圧縮.*未実装/),
      true,
    );
    const lastCall = (savePDF as unknown as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0] as unknown[];
    const effectiveOptions = lastCall[6] as { compression: string };
    expect(effectiveOptions.compression).toBe('none');
  });

  it('OCR実行中は executeSaveAs が保存ダイアログを開かず通知して終了する', async () => {
    makeSingleDirtyPageDoc('/saveas/ocr-guard.pdf');
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockClear();

    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    await act(async () => {
      await result.current.executeSaveAs();
    });

    expect(save).not.toHaveBeenCalled();
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/OCR実行中は保存できません/),
      true,
    );
  });

  it('保存ダイアログの選択待ち中に別の保存が開始していたら executeSaveAs は中断する', async () => {
    makeSingleDirtyPageDoc('/saveas/race-dialog.pdf');

    let resolveDialog!: (path: string) => void;
    const dialogPromise = new Promise<string>((resolve) => { resolveDialog = resolve; });
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(dialogPromise);

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const saveAsPromise = result.current.executeSaveAs();
    await waitFor(() => expect(save).toHaveBeenCalled());

    // ダイアログ表示中に別経路の保存が開始した状況を isSavingRef 直接操作で再現する
    result.current.isSavingRef.current = true;
    resolveDialog('/saveas/race-dialog-target.pdf');
    await saveAsPromise;

    expect(showToast).toHaveBeenCalledWith('別の保存処理が進行中です。完了してから再度お試しください。');
    expect(savePDF).not.toHaveBeenCalled();

    result.current.isSavingRef.current = false;
  });

  it('別名保存中に別のPDFへ切り替わっていた場合、名前を付けて保存に失敗した旨を通知する', async () => {
    makeSingleDirtyPageDoc('/saveas/race-switch.pdf');
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/saveas/race-switch-target.pdf');

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'replace_pdf_file') {
        usePecoStore.setState({
          document: {
            filePath: '/other/switched.pdf',
            fileName: 'switched.pdf',
            totalPages: 1,
            metadata: {},
            pages: new Map(),
          } as unknown as PecoDocument,
        });
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.executeSaveAs();
    });

    expect(showToast).toHaveBeenCalledWith('名前を付けて保存に失敗しました。', true);
  });
});

describe('useFileOperations handleSaveTo ガード・失敗系 (coverage gap-fill wave5)', () => {
  it('保存処理が進行中のとき handleSaveTo は即座に false を返しsavePDFを呼ばない', async () => {
    makeSingleDirtyPageDoc('/saveto/busy.pdf');
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    result.current.isSavingRef.current = true;
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSaveTo('/saveto/busy-target.pdf');
    });

    expect(ok).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('保存処理が進行中です。');
    result.current.isSavingRef.current = false;
  });

  it('OCR実行中かつ bypassOcrGuard 未指定なら handleSaveTo は false を返す', async () => {
    makeSingleDirtyPageDoc('/saveto/ocr-guard.pdf');
    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSaveTo('/saveto/ocr-target.pdf');
    });

    expect(ok).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/OCR実行中は保存できません/),
      true,
    );
  });

  it('savePDFが失敗した場合 handleSaveTo は false を返しエラートーストを出す', async () => {
    makeSingleDirtyPageDoc('/saveto/save-fail.pdf');
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSaveTo('/saveto/save-fail-target.pdf');
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/保存に失敗しました.*boom/), true);
    expect(result.current.isSavingRef.current).toBe(false);
  });

  it('開いているドキュメントが無い状態で handleSaveTo を呼ぶと savePDF を呼ばず false を返す', async () => {
    usePecoStore.setState({ document: null, isDirty: false });
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSaveTo('/saveto/no-doc-target.pdf');
    });

    expect(ok).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
  });
});

describe('useFileOperations previewOcrOffset ガード・失敗系 (coverage gap-fill wave5)', () => {
  it('開いているPDFが無い場合 previewOcrOffset はユーザーへ通知して false を返す', async () => {
    usePecoStore.setState({ document: null, isDirty: false });
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/プレビューするPDFが開かれていません/),
      true,
    );
  });

  it('保存処理が進行中のとき previewOcrOffset は false を返す', async () => {
    makeSingleDirtyPageDoc('/preview/busy.pdf');
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    result.current.isSavingRef.current = true;
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存処理が進行中です.*プレビュー/),
    );
    result.current.isSavingRef.current = false;
  });

  it('OCR実行中は previewOcrOffset がユーザーへ通知して false を返す', async () => {
    makeSingleDirtyPageDoc('/preview/ocr-guard.pdf');
    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/OCR実行中はプレビューできません/),
      true,
    );
  });

  it('open_pdf_preview の起動に失敗した場合、失敗を通知して false を返す', async () => {
    makeSingleDirtyPageDoc('/preview/open-fail.pdf');
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'open_pdf_preview') return Promise.reject(new Error('viewer launch failed'));
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.previewOcrOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/プレビューに失敗しました.*viewer launch failed/),
      true,
    );
    expect(result.current.isSavingRef.current).toBe(false);
  });
});

describe('useFileOperations saveAllPagesWithOffset ガード・成功・失敗系 (coverage gap-fill wave5)', () => {
  it('開いているPDFが無い場合はユーザーへ通知して false を返す', async () => {
    usePecoStore.setState({ document: null, isDirty: false });
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAllPagesWithOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存するPDFが開かれていません/),
      true,
    );
    expect(savePDF).not.toHaveBeenCalled();
  });

  it('保存処理が進行中のときは false を返しsavePDFを呼ばない', async () => {
    makeSingleDirtyPageDoc('/offset-save/busy.pdf');
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    result.current.isSavingRef.current = true;
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAllPagesWithOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('保存処理が進行中です。');
    expect(savePDF).not.toHaveBeenCalled();
    result.current.isSavingRef.current = false;
  });

  it('OCR実行中はユーザーへ通知して false を返す', async () => {
    makeSingleDirtyPageDoc('/offset-save/ocr-guard.pdf');
    const showToast = vi.fn();
    const isOcrRunningRef = { current: true } as React.MutableRefObject<boolean>;
    const { result } = renderHook(() =>
      useFileOperations(showToast, undefined, undefined, undefined, isOcrRunningRef),
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAllPagesWithOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/OCR実行中は保存できません/),
      true,
    );
    expect(savePDF).not.toHaveBeenCalled();
  });

  it('成功時は dirty を解除し、位置補正保存の成功トーストとバックアップ削除を行う', async () => {
    const doc = makeSingleDirtyPageDoc('/offset-save/success.pdf');
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAllPagesWithOffset();
    });

    expect(ok).toBe(true);
    expect(usePecoStore.getState().document!.pages.get(0)!.isDirty).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/全ページに位置補正を適用して保存しました/),
    );
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    const clearBackupCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'clear_backup');
    expect(clearBackupCalls.length).toBeGreaterThan(0);
    expect(clearBackupCalls[0][1]).toEqual({ filePath: doc.filePath });
  });

  it('savePDFが失敗した場合 false を返しエラートーストを出し isSavingRef をリセットする', async () => {
    makeSingleDirtyPageDoc('/offset-save/save-fail.pdf');
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offset save boom'));

    const showToast = vi.fn();
    const setIsSaving = vi.fn();
    const setSaveStep = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(showToast, setIsSaving, undefined, undefined, undefined, setSaveStep),
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAllPagesWithOffset();
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存に失敗しました.*offset save boom/),
      true,
    );
    expect(result.current.isSavingRef.current).toBe(false);
    expect(setIsSaving).toHaveBeenLastCalledWith(false);
    expect(setSaveStep).toHaveBeenLastCalledWith(null);
  });
});

describe('useFileOperations handleOpen 未保存変更の破棄失敗 (coverage gap-fill wave5)', () => {
  it('別PDFを開く際に旧ファイルの temporary changes 破棄が失敗した場合、ユーザーへ通知して document を差し替えない', async () => {
    const dirtyPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: true,
      thumbnail: null,
    } as unknown as PageData;
    const currentDoc: PecoDocument = {
      filePath: '/discard-fail/current.pdf',
      fileName: 'current.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, dirtyPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: currentDoc, isDirty: true });
    (ask as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (clearTemporaryChanges as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('idb transaction aborted'),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let opened: boolean | undefined;
    await act(async () => {
      opened = await result.current.handleOpen('/discard-fail/next.pdf');
    });

    expect(opened).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/未保存の変更を破棄できませんでした/),
      true,
    );
    // 破棄失敗時は setDocument されず、旧ドキュメントのまま維持される
    expect(usePecoStore.getState().document).toBe(currentDoc);
  });
});

describe('useFileOperations handleSave 保存前diffプレビューのキャンセル経路 (coverage gap-fill wave5)', () => {
  it('diffプレビューでユーザーがキャンセルすると savePDF を呼ばず false を返す', async () => {
    makeSingleDirtyPageDoc('/diff-preview/cancel.pdf');
    usePecoStore.setState({
      undoStack: [
        {
          type: 'update_page',
          pageIndex: 0,
          before: { textBlocks: [{ id: 'blk', text: 'OLD', isDirty: false }] },
          after: { textBlocks: [{ id: 'blk', text: 'T', isDirty: true }] },
        },
      ] as unknown as ReturnType<typeof usePecoStore.getState>['undoStack'],
      lastSavedActionIndex: 0,
    });

    const onRequestDiffPreview = vi.fn().mockResolvedValueOnce(false);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileOperations(
        showToast,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onRequestDiffPreview,
      ),
    );

    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await result.current.handleSave();
    });

    expect(saveResult).toBe(false);
    expect(onRequestDiffPreview).toHaveBeenCalledTimes(1);
    expect(savePDF).not.toHaveBeenCalled();
    // キャンセルは isSavingRef が true になる前の分岐なので、保存中フラグは立たない
    expect(result.current.isSavingRef.current).toBe(false);
  });
});

describe('useFileOperations temp書込先 fs scope 非検証契約の回帰ガード (PCT-118)', () => {
  it('保存は必ず "<元パス>.pecotool-*.tmp" 命名の一時ファイル経由で atomic replace される', async () => {
    // PCT-118: temp(.pecotool-*.tmp) への書込は fs scope 検証しない設計。
    // この契約はフック層が writeFileAtomically へ渡す writePath を勝手に
    // 書き換えていないこと (= 常に document.filePath そのもの) に依存している。
    // フック層が writePath を別物に差し替えると、Rust 側の temp 生成規約や
    // scope 前提が崩れて保存全滅 (PCT-118 の再発) につながるため、ここで固定する。
    const doc = makeSingleDirtyPageDoc('/pct118/target file with space.pdf');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    const chunkCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pdf_chunk');
    expect(chunkCalls.length).toBeGreaterThan(0);
    const [, , chunkOpts] = chunkCalls[0] as [string, ArrayBuffer, { headers: Record<string, string> }];
    const tempPathUsed = decodeURIComponent(chunkOpts.headers['x-path']);
    // 一時ファイルは元パスを prefix に持ち、.pecotool-<timestamp>-<uuid>.tmp で終わる
    expect(tempPathUsed.startsWith(doc.filePath)).toBe(true);
    expect(tempPathUsed).toMatch(/\.pecotool-\d+-[0-9a-f-]+\.tmp$/);

    const replaceCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'replace_pdf_file');
    expect(replaceCalls.length).toBe(1);
    const [, replaceArgs] = replaceCalls[0] as [string, { tempPath: string; targetPath: string }];
    // 最終書き込み先 (targetPath) はユーザーが開いた実パスそのまま (改変されない)
    expect(replaceArgs.targetPath).toBe(doc.filePath);
    expect(replaceArgs.tempPath).toBe(tempPathUsed);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #361 (PCT-138): 読込中保存ガードの非対称 — executeSaveAs / handleSaveTo にも
// handleSave (:944 相当) と対称の isLoadingFileRef ガードを追加した回帰テスト。
// ────────────────────────────────────────────────────────────────────────

describe('useFileOperations 読込中保存ガードの対称性 (PCT-138 #361)', () => {
  function setupCleanLoadedDoc(filePath: string): PecoDocument {
    const cleanPage = {
      pageIndex: 0,
      width: 100,
      height: 100,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath,
      fileName: filePath.split('/').pop()!,
      totalPages: 1,
      metadata: {},
      pages: new Map([[0, cleanPage]]),
    } as unknown as PecoDocument;
    usePecoStore.setState({ document: doc, isDirty: false, undoStack: [], redoStack: [] });
    __originalBytesCacheForTest.set(filePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    return doc;
  }

  it('ファイル読込中 (loadPDF await 中) の executeSaveAs は save ダイアログを開かず通知して no-op', async () => {
    setupCleanLoadedDoc('/pct138/loaded.pdf');

    let resolveLoad!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openPromise = result.current.handleOpen('/pct138/incoming.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct138/incoming.pdf'));

    // 読込中に Ctrl+Shift+S 相当 (別名保存) を実行
    const { save } = await import('@tauri-apps/plugin-dialog');
    await act(async () => {
      await result.current.executeSaveAs();
    });

    // 修正前: save ダイアログが開き savePDF まで進みうる。修正後: ガードで即拒否。
    expect(save).not.toHaveBeenCalled();
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/読み込み中は保存できません/),
    );

    // 後片付け: ロードを完走させる
    await act(async () => {
      resolveLoad({
        filePath: '/pct138/incoming.pdf',
        fileName: 'incoming.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openPromise;
    });
  });

  it('save ダイアログ await 中に読込が開始した場合も executeSaveAs は保存を中断する', async () => {
    setupCleanLoadedDoc('/pct138/dialog-race.pdf');

    const { save } = await import('@tauri-apps/plugin-dialog');
    let resolveSaveDialog!: (path: string | null) => void;
    (save as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveSaveDialog = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const saveAsPromise = result.current.executeSaveAs();
    await waitFor(() => expect(save).toHaveBeenCalled());

    // ダイアログでユーザーがパスを選ぶ前に、別経路 (loadPDF) の読込が始まった状況を再現
    let resolveLoad!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );
    const openPromise = result.current.handleOpen('/pct138/incoming-race.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct138/incoming-race.pdf'));

    // ダイアログがパスを返す (読込は依然進行中)
    resolveSaveDialog('/pct138/dialog-race-target.pdf');
    await saveAsPromise;

    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/読み込み中は保存できません/),
    );

    // 後片付け
    await act(async () => {
      resolveLoad({
        filePath: '/pct138/incoming-race.pdf',
        fileName: 'incoming-race.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openPromise;
    });
  });

  it('ファイル読込中 (loadPDF await 中) の handleSaveTo は false を返し savePDF を呼ばない', async () => {
    setupCleanLoadedDoc('/pct138/saveto-loaded.pdf');

    let resolveLoad!: (doc: unknown) => void;
    (loadPDF as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    const openPromise = result.current.handleOpen('/pct138/saveto-incoming.pdf');
    await waitFor(() => expect(loadPDF).toHaveBeenCalledWith('/pct138/saveto-incoming.pdf'));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSaveTo('/pct138/saveto-target.pdf');
    });

    // 修正前: sidecar 保存が素通りして savePDF が呼ばれる。修正後: ガードで拒否。
    expect(ok).toBe(false);
    expect(savePDF).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/読み込み中は保存できません/),
    );

    // 後片付け
    await act(async () => {
      resolveLoad({
        filePath: '/pct138/saveto-incoming.pdf',
        fileName: 'saveto-incoming.pdf',
        totalPages: 1,
        metadata: {},
        pages: new Map(),
      });
      await openPromise;
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// #364 (PCT-141): clear_backup fire-and-forget が失敗を握りつぶしていた点の
// 回帰テスト。失敗を console.warn で可視化し 1 回リトライすること、かつ
// 保存自体の成否 (戻り値・成功トースト) には影響させないことを確認する。
// ────────────────────────────────────────────────────────────────────────

describe('useFileOperations clear_backup 失敗時の warn + リトライ (PCT-141 #364)', () => {
  it('clear_backup が1回目失敗しても console.warn の上でリトライされ、保存自体は成功扱いのまま', async () => {
    const doc = makeSingleDirtyPageDoc('/pct141/retry.pdf');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    let clearBackupCallCount = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'clear_backup') {
        clearBackupCallCount += 1;
        if (clearBackupCallCount === 1) {
          return Promise.reject(new Error('EBUSY: backup file locked'));
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    // clear_backup の失敗は保存の成否に影響しない (保存自体は成功扱い)
    expect(ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存しました/),
    );

    // clear_backup は fire-and-forget の外側からは待てないため、リトライが
    // 完走するまで待機してから呼び出し回数と warn ログを確認する。
    await waitFor(() => expect(clearBackupCallCount).toBe(2));
    const clearBackupCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'clear_backup');
    expect(clearBackupCalls.length).toBe(2);
    expect(clearBackupCalls[0][1]).toEqual({ filePath: doc.filePath });
    expect(clearBackupCalls[1][1]).toEqual({ filePath: doc.filePath });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/clear_backup failed, retrying once/),
        expect.anything(),
      );
    });
    // リトライが成功したので「リトライも失敗した」警告は出ない
    expect(
      warnSpy.mock.calls.some(([msg]) => String(msg).includes('clear_backup retry failed')),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it('clear_backup が2回とも失敗した場合も保存自体は成功扱いのまま、両方の警告が出る', async () => {
    const doc = makeSingleDirtyPageDoc('/pct141/retry-fail-both.pdf');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    let clearBackupCallCount = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'clear_backup') {
        clearBackupCallCount += 1;
        return Promise.reject(new Error('EBUSY: backup file locked'));
      }
      return Promise.resolve(undefined);
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleSave();
    });

    expect(ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/保存しました/),
    );

    await waitFor(() => expect(clearBackupCallCount).toBe(2));

    await waitFor(() => {
      expect(
        warnSpy.mock.calls.some(([msg]) => String(msg).includes('clear_backup retry failed')),
      ).toBe(true);
    });

    warnSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────
// bug-hunt round2 Wave1 H-1: pageOrderMatchesSnapshot の TOCTOU 窓
//
// _executeSave は writeFileAtomically 完了直後に pageOrderMatchesSnapshot を
// 一度だけ判定するが、その後の await (fingerprint 読み取り / IDB 書き込み待機)
// をまたいで同じ値を使い回していた。その await 中に pageOrder が変化すると、
// 判定時点 (真) と適用時点 (偽になっているべき) が食い違い、無関係なページへ
// #437 と同型の rotation/bbox 誤リベースが再侵入する。
// ────────────────────────────────────────────────────────────────────────
describe('useFileOperations H-1 (bug-hunt round2): pageOrderMatchesSnapshot 判定の TOCTOU 窓', () => {
  it('判定直後の await 中に pageOrder が入れ替わると、無関係なページへ rotation/bbox が誤って焼き込まれない', async () => {
    const pageABlock = {
      id: 'blockA',
      text: 'A',
      originalText: 'A',
      bbox: { x: 10, y: 10, width: 50, height: 20 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: true,
    };
    const pageA = {
      pageIndex: 0,
      width: 595,
      height: 842,
      textBlocks: [pageABlock],
      isDirty: true,
      thumbnail: null,
      rotation: 90,
    } as unknown as PageData;

    const pageBBlock = {
      id: 'blockB',
      text: 'B',
      originalText: 'B',
      bbox: { x: 200, y: 300, width: 80, height: 30 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: false,
    };
    const pageB = {
      pageIndex: 1,
      width: 595,
      height: 842,
      textBlocks: [pageBBlock],
      isDirty: false,
      thumbnail: null,
      rotation: undefined,
    } as unknown as PageData;

    const doc: PecoDocument = {
      filePath: '/toctou/race.pdf',
      fileName: 'race.pdf',
      totalPages: 2,
      metadata: {},
      pages: new Map([[0, pageA], [1, pageB]]),
    } as unknown as PecoDocument;

    usePecoStore.setState({
      document: doc,
      pageOrder: [0, 1],
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set('/toctou/race.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    // _executeSave は writePath の fingerprint を stat() 経由で読む。
    // 1 回目 (保存開始時の getFreshOriginalBytesCache) は無害な値を返し、
    // 2 回目 (writeFileAtomically 完了後、pageOrderMatchesSnapshot 判定直後の
    // fingerprint 読み取り) で「保存の await 中にユーザーがページを並べ替えた」
    // 状況を注入する。
    let statCallCount = 0;
    (stat as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      statCallCount += 1;
      if (statCallCount === 2) {
        const state = usePecoStore.getState();
        const movedPageB = { ...pageB, pageIndex: 0 };
        const movedPageA = { ...pageA, pageIndex: 1 };
        usePecoStore.setState({
          document: {
            ...state.document!,
            pages: new Map([[0, movedPageB], [1, movedPageA]]),
          },
          pageOrder: [1, 0],
          undoStack: [
            ...state.undoStack,
            { type: 'reorder_pages' as const, beforeOrder: [0, 1], afterOrder: [1, 0] },
          ],
          isDirty: true,
        });
      }
      return { mtime: new Date('2024-01-01'), size: 4 };
    });

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // H-1 の核心: 割り込みにより idx0 は「保存スナップショットとは無関係な pageB」に
    // 差し替わっている。stale な pageOrderMatchesSnapshot=true を resetDirty に渡すと、
    // savedPageSnapshots (idx0=pageA, rotation=90) を根拠に無関係な pageB へ rotation を
    // 誤注入する。修正後は判定を await 後に再取得するため orderMatched=false になり、
    // pageB は一切変更されない。
    const afterIdx0 = usePecoStore.getState().document!.pages.get(0)!;
    expect(afterIdx0.rotation).toBeUndefined();
    expect(afterIdx0.textBlocks[0].bbox).toEqual(pageBBlock.bbox);
    expect(afterIdx0.width).toBe(595);
    expect(afterIdx0.height).toBe(842);
  });
});

// ────────────────────────────────────────────────────────────────────────
// bug-hunt round2 Wave1 H-2: bytePreserved=true 時の後処理素通り
//
// byte-preserve 短絡 (undecodable メタ検出で原本バイトをそのまま書く保存) では
// 何も焼き込まれていない。にもかかわらず normalizePageOrderAfterSave / IDB dirty
// remap / setLastSavedActionIndex が無条件に実行され、並べ替えの黙示的な巻き戻し・
// undo/redo 全消去・クラッシュ復元層 (IDB temp) の喪失・未保存編集の「保存済み」
// 誤記録が起きていた。
// ────────────────────────────────────────────────────────────────────────
describe('useFileOperations H-2 (bug-hunt round2): bytePreserved=true 時の後処理スキップ', () => {
  function mockBytePreservedSavePdfOnce(): void {
    (savePDF as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (
        _src: unknown,
        _doc: unknown,
        _font: unknown,
        _fallback: unknown,
        _onSkipped: unknown,
        _savePageOrder: unknown,
        _opts: unknown,
        onBytePreserved: (bp: boolean) => void,
      ) => {
        onBytePreserved(true);
        return new Uint8Array([9, 9, 9, 9]);
      },
    );
  }

  it('byte-preserve 保存では並べ替え (非identity pageOrder) が normalize で巻き戻されず、undoStack/redoStack も消えない', async () => {
    const page0 = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'p0', text: 'P0', isDirty: true }],
      isDirty: true, thumbnail: null,
    } as unknown as PageData;
    const page1 = {
      pageIndex: 1, width: 595, height: 842,
      textBlocks: [{ id: 'p1', text: 'P1', isDirty: false }],
      isDirty: false, thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/bytepreserve/reorder.pdf', fileName: 'reorder.pdf', totalPages: 2, metadata: {},
      pages: new Map([[0, page0], [1, page1]]),
    } as unknown as PecoDocument;

    // 非 identity な pageOrder ([1,0]) = 保存前にユーザーが並べ替え済み。
    usePecoStore.setState({
      document: doc,
      pageOrder: [1, 0],
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [
        { type: 'reorder_pages' as const, beforeOrder: [0, 1], afterOrder: [1, 0] },
      ],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set('/bytepreserve/reorder.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    mockBytePreservedSavePdfOnce();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // H-2 の核心: byte-preserve では実際には何も焼き込まれていないため、
    // normalize によるページ順の巻き戻し・undo/redo の消去は起きてはならない。
    expect(usePecoStore.getState().pageOrder).toEqual([1, 0]);
    expect(usePecoStore.getState().undoStack.length).toBe(1);
    expect(usePecoStore.getState().redoStack).toEqual([]);
    // IDB dirty remap (保存済みとして一時データを破棄する処理) も走ってはならない。
    expect(remapTemporaryPageEntries).not.toHaveBeenCalled();
  });

  it('byte-preserve 保存では lastSavedActionIndex が未保存の編集位置まで進まない', async () => {
    const page0 = {
      pageIndex: 0, width: 595, height: 842,
      textBlocks: [{ id: 'p0', text: 'EDITED', isDirty: true }],
      isDirty: true, thumbnail: null,
    } as unknown as PageData;
    const doc: PecoDocument = {
      filePath: '/bytepreserve/lastsaved.pdf', fileName: 'lastsaved.pdf', totalPages: 1, metadata: {},
      pages: new Map([[0, page0]]),
    } as unknown as PecoDocument;

    // pageOrder は identity のまま (並べ替えは絡まない)。undoStack に未保存の編集が
    // 2件積まれている状態で byte-preserve 保存が走るシナリオ。
    usePecoStore.setState({
      document: doc,
      pageOrder: [0],
      currentPageIndex: 0,
      isDirty: true,
      undoStack: [
        { type: 'update_page' as const, pageIndex: 0, before: { ...page0, isDirty: false }, after: page0 },
        { type: 'update_page' as const, pageIndex: 0, before: { ...page0, isDirty: false }, after: page0 },
      ],
      redoStack: [],
      lastSavedActionIndex: 0,
    });
    __originalBytesCacheForTest.set('/bytepreserve/lastsaved.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    mockBytePreservedSavePdfOnce();

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleSave();
    });

    // H-2 の核心: 何も焼き込まれていないのに lastSavedActionIndex を進めると、
    // 未保存の編集を「保存済み」と誤記録してしまう。
    expect(usePecoStore.getState().lastSavedActionIndex).toBe(0);
  });
});
