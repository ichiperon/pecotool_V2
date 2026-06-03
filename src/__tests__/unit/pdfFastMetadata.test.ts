/**
 * Unit tests for src/utils/pdfFastMetadata.ts
 *
 * U-PH-01: 正常な /Info メタデータ読み込み（invoke 成功）
 * U-PH-02: 不正バイト列での decode 失敗時に null を返す（invoke 例外）
 * Extra: 空配列返却、型マッピング検証
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { getPdfPageDimensions } from '../../utils/pdfFastMetadata';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
});

describe('getPdfPageDimensions', () => {
  it('U-PH-01: invoke 成功時に PageDimensions[] を返す', async () => {
    invokeMock.mockResolvedValue([
      [595, 842],
      [210, 297],
    ]);

    const result = await getPdfPageDimensions('/path/to/test.pdf');

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ width: 595, height: 842 });
    expect(result![1]).toEqual({ width: 210, height: 297 });
  });

  it('U-PH-01b: invoke に正しいコマンドとパラメータが渡される', async () => {
    invokeMock.mockResolvedValue([[100, 200]]);

    await getPdfPageDimensions('/some/file.pdf');

    expect(invokeMock).toHaveBeenCalledWith('get_pdf_page_dimensions', {
      filePath: '/some/file.pdf',
    });
  });

  it('U-PH-02: invoke が例外をスローした場合に null を返す', async () => {
    invokeMock.mockRejectedValue(new Error('invalid byte sequence'));

    const result = await getPdfPageDimensions('/bad/file.pdf');

    expect(result).toBeNull();
  });

  it('U-PH-02b: invoke が文字列エラーをスローしても null を返す（クラッシュしない）', async () => {
    invokeMock.mockRejectedValue('Tauri IPC failed');

    const result = await getPdfPageDimensions('/bad/file.pdf');

    expect(result).toBeNull();
  });

  it('空配列を返すと空の PageDimensions[] になる', async () => {
    invokeMock.mockResolvedValue([]);

    const result = await getPdfPageDimensions('/empty.pdf');

    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  it('1 ページの PDF でも正しくマッピングされる', async () => {
    invokeMock.mockResolvedValue([[841.89, 1190.55]]);

    const result = await getPdfPageDimensions('/a3.pdf');

    expect(result).toHaveLength(1);
    expect(result![0].width).toBeCloseTo(841.89);
    expect(result![0].height).toBeCloseTo(1190.55);
  });
});
