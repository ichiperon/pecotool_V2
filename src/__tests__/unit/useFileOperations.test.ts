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

// pecoStore は本物を使うが、必要最小限の状態だけ。
// loadPDF が返す doc を setDocument に流すので、副作用は無害。
import { useFileOperations, __originalBytesCacheForTest, isWriteAccessError } from '../../hooks/useFileOperations';
import { getAllTemporaryPageData, loadPDF, loadPage, clearTemporaryChanges } from '../../utils/pdfLoader';
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { useInfraStore } from '../../store/infraStore';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import type { PecoDocument, PageData } from '../../types';

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
