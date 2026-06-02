/**
 * #190: OcrSettingsModal — OCR 言語選択 UI のユニットテスト
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

// Tauri invoke mock
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

// Modal は内部実装をスキップしてコンテンツのみレンダリング
vi.mock('../../components/ui/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useModalTitleId: () => 'mock-title-id',
}));

import { invoke } from '@tauri-apps/api/core';
import { OcrSettingsModal } from '../../components/OcrSettingsModal';
import { useOcrSettingsStore } from '../../store/ocrSettingsStore';

const MOCK_LANGUAGES = [
  { tag: 'ja', display_name: 'Japanese' },
  { tag: 'en-US', display_name: 'English (United States)' },
  { tag: 'zh-Hans-CN', display_name: 'Chinese Simplified (China)' },
];

beforeEach(() => {
  useOcrSettingsStore.setState({
    horizontal: { rowOrder: 'top-to-bottom', columnOrder: 'left-to-right' },
    vertical: { columnOrder: 'right-to-left', rowOrder: 'top-to-bottom' },
    groupTolerance: 20,
    mixedOrder: 'vertical-first',
    ocrLanguage: 'ja',
    availableLanguages: [],
  });
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('OcrSettingsModal — 言語 dropdown', () => {
  it('U-OM-01: モーダルがレンダリングされる', () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<OcrSettingsModal onClose={vi.fn()} />);
    // 序列設定セクションが表示される
    expect(screen.getByText('OCR 序列設定')).toBeTruthy();
  });

  it('U-OM-02: 言語リスト取得中は「取得中」テキストが表示される', () => {
    let resolve: (v: unknown) => void;
    (invoke as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((r) => { resolve = r; })
    );
    render(<OcrSettingsModal onClose={vi.fn()} />);
    expect(screen.getByText(/言語リスト取得中/)).toBeTruthy();
    resolve!(MOCK_LANGUAGES);
  });

  it('U-OM-03: 言語リスト取得後に dropdown が表示される', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_LANGUAGES);
    render(<OcrSettingsModal onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('OCR 言語')).toBeTruthy();
    });

    const select = screen.getByLabelText('OCR 言語') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.text);
    expect(options).toContain('Japanese');
    expect(options).toContain('English (United States)');
  });

  it('U-OM-04: 言語選択で setOcrLanguage が呼ばれ state が更新される', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_LANGUAGES);
    render(<OcrSettingsModal onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('OCR 言語')).toBeTruthy();
    });

    const select = screen.getByLabelText('OCR 言語') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'en-US' } });

    expect(useOcrSettingsStore.getState().ocrLanguage).toBe('en-US');
  });

  it('U-OM-05: 言語パック 0 件のとき「未導入」メッセージが表示される', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<OcrSettingsModal onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/言語パックが見つかりません/)).toBeTruthy();
    });
  });

  it('U-OM-06: availableLanguages が既にある場合は invoke を呼ばない', () => {
    useOcrSettingsStore.setState({ availableLanguages: MOCK_LANGUAGES });
    render(<OcrSettingsModal onClose={vi.fn()} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});
