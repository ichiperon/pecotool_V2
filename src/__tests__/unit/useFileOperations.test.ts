/**
 * S-10 (追加): useFileOperations の sessionStorage JSON.parse narrow を検証する。
 * - handleOpen 内部の addToRecent が sessionStorage を読み書きする際、
 *   不正 JSON / 型違反値を安全に弾けることを確認する。
 *
 * 重い依存 (loadPDF / fs / dialog / fontLoader / store) は全て mock する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---- 依存 mock ----
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ mtime: new Date('2024-01-01') }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
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
}));
vi.mock('../../utils/pdfSaver', () => ({
  savePDF: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));
vi.mock('../../hooks/useFontLoader', () => ({
  loadFontLazy: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
}));

// pecoStore は本物を使うが、必要最小限の状態だけ。
// loadPDF が返す doc を setDocument に流すので、副作用は無害。
import { useFileOperations } from '../../hooks/useFileOperations';
import { loadPDF } from '../../utils/pdfLoader';

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
