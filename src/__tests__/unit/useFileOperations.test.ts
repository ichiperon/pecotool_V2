/**
 * S-10 (追加): useFileOperations の sessionStorage JSON.parse narrow を検証する。
 * - handleOpen 内部の addToRecent が sessionStorage を読み書きする際、
 *   不正 JSON / 型違反値を安全に弾けることを確認する。
 *
 * #8: writeFileChunked が空 Uint8Array でも write_pdf_chunk を 1 回呼ぶこと
 * #34: explicitPath での読み込み失敗時に Recent から該当パスが除去されること
 *
 * 重い依存 (loadPDF / fs / dialog / fontLoader / store) は全て mock する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
import { useFileOperations } from '../../hooks/useFileOperations';
import { loadPDF } from '../../utils/pdfLoader';
import { savePDF } from '../../utils/pdfSaver';
import { usePecoStore } from '../../store/pecoStore';
import { invoke } from '@tauri-apps/api/core';
import type { PecoDocument, PageData } from '../../types';

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  // loadPDF mock を毎回リセット
  (loadPDF as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    filePath: '/fixed/path.pdf',
    fileName: 'path.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map(),
  });
});

function readRecent(): unknown {
  const raw = sessionStorage.getItem('peco-recent-files');
  return raw === null ? null : JSON.parse(raw);
}

describe('useFileOperations addToRecent (sessionStorage narrow)', () => {
  it('S-10-09a: 既存値が string[] でなく数値混在配列の場合、空配列扱いで上書きされる', async () => {
    // 改ざんされた sessionStorage を仕込む
    sessionStorage.setItem('peco-recent-files', '[123, "/path"]');

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
    sessionStorage.setItem('peco-recent-files', '{"foo":1}');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/new/file.pdf');
    });

    expect(readRecent()).toEqual(['/new/file.pdf']);
  });

  it('S-10-10: 既存値が JSON ではない (壊れた文字列) 場合、空配列にフォールバック', async () => {
    sessionStorage.setItem('peco-recent-files', 'not-json{{{');

    const showToast = vi.fn();
    const { result } = renderHook(() => useFileOperations(showToast));

    await act(async () => {
      await result.current.handleOpen('/new/file.pdf');
    });

    expect(readRecent()).toEqual(['/new/file.pdf']);
  });

  it('既存値が正常な string[] の場合、先頭に追加されて重複が除去される', async () => {
    sessionStorage.setItem(
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
      originalBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
      isDirty: true,
    });

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
    usePecoStore.setState({ document: null, originalBytes: null, isDirty: false });

    // 事前に Recent に '/missing.pdf' と '/keep.pdf' を入れておく
    sessionStorage.setItem(
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
    usePecoStore.setState({ document: null, originalBytes: null, isDirty: false });
    sessionStorage.setItem(
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
