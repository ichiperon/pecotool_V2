/**
 * Issue #40 / #42 regression: 各実モーダルが Modal 抽象を通じて
 * Esc / role / aria-modal / 復元中ガード を実装していることを担保する。
 *
 * (Modal 抽象自体の細かい契約は Modal.test.tsx で別途検証する)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';

// グローバル setup の Proxy ベース lucide-react モックは BackupRestoreDialog のように
// 複数アイコンを使うコンポーネントで初期化に長時間掛かるケースがあるため、
// 本テストで使うアイコンだけを明示モックして高速化する (SaveDialog.test.tsx と同じパターン)。
vi.mock('lucide-react', () => ({
  X: () => null,
  Loader2: (props: { className?: string }) => <span className={props.className}>loading</span>,
  RotateCcw: () => null,
  Trash2: () => null,
}));

import { HelpModal } from '../../components/HelpModal';
import { OcrSettingsModal } from '../../components/OcrSettingsModal';
import { SaveDialog } from '../../components/SaveDialog';
import { BackupRestoreDialog } from '../../components/BackupRestoreDialog';
import type { PendingBackup } from '../../hooks/useAutoBackup';

afterEach(() => cleanup());

const sampleBackup: PendingBackup = {
  file_path: 'C:/work/sample.pdf',
  timestamp: '2024-01-02T03:04:05.000Z',
  backup_path: 'C:/work/.peco_backup/sample.pdf.bak',
};

// ── HelpModal ────────────────────────────────────────────────────────

describe('HelpModal (#40): A11y / Esc', () => {
  it('role="dialog" aria-modal="true" が付与される', () => {
    render(<HelpModal helpModal="shortcuts" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('aria-labelledby がタイトル要素 (shortcuts) を指す', () => {
    render(<HelpModal helpModal="shortcuts" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const titleEl = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(titleEl?.textContent).toBe('ショートカットキー一覧');
  });

  it('Esc で onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<HelpModal helpModal="usage" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('✕ ボタンで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<HelpModal helpModal="version" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── OcrSettingsModal ────────────────────────────────────────────────

describe('OcrSettingsModal (#40): A11y / Esc', () => {
  it('role="dialog" aria-modal aria-labelledby が揃う', () => {
    render(<OcrSettingsModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleEl = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(titleEl?.textContent).toBe('OCR 序列設定');
  });

  it('Esc で onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<OcrSettingsModal onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── SaveDialog ──────────────────────────────────────────────────────

describe('SaveDialog (#40): A11y / Esc', () => {
  const defaultProps = {
    isEstimating: false,
    estimatedSizes: { uncompressed: 1024, compressed: 512 },
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    defaultCompression: 'none' as const,
  };

  it('role="dialog" aria-modal aria-labelledby が揃う', () => {
    render(<SaveDialog {...defaultProps} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleEl = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(titleEl?.textContent).toBe('別名で保存');
  });

  it('Esc で onCancel が呼ばれる', () => {
    const onCancel = vi.fn();
    render(<SaveDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── BackupRestoreDialog (#40 + #42) ──────────────────────────────────

describe('BackupRestoreDialog (#40): A11y / Esc', () => {
  const base = {
    backups: [sampleBackup],
    onRestore: vi.fn(),
    onDiscard: vi.fn(),
  };

  it('role="dialog" aria-modal aria-labelledby が揃う', () => {
    render(<BackupRestoreDialog {...base} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleEl = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(titleEl?.textContent?.includes('未保存の内容があります')).toBe(true);
  });

  it('処理中でないとき Esc で onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<BackupRestoreDialog {...base} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('処理中でないとき ✕ クリックで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<BackupRestoreDialog {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BackupRestoreDialog (#42): 復元処理中の close ガード', () => {
  const base = {
    backups: [sampleBackup],
    onRestore: vi.fn(),
    onDiscard: vi.fn(),
  };

  it('processingFilePath 指定中は Esc で onClose を呼ばず、onCloseSuppressed を呼ぶ', () => {
    const onClose = vi.fn();
    const onCloseSuppressed = vi.fn();
    render(
      <BackupRestoreDialog
        {...base}
        onClose={onClose}
        processingFilePath={sampleBackup.file_path}
        onCloseSuppressed={onCloseSuppressed}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseSuppressed).toHaveBeenCalledTimes(1);
  });

  it('processingFilePath 指定中は ✕ ボタンが disabled になりクリック自体が無視される', () => {
    const onClose = vi.fn();
    const onCloseSuppressed = vi.fn();
    render(
      <BackupRestoreDialog
        {...base}
        onClose={onClose}
        processingFilePath={sampleBackup.file_path}
        onCloseSuppressed={onCloseSuppressed}
      />,
    );
    const closeBtn = screen.getByRole('button', { name: '閉じる' });
    // disabled なボタンへの click はブラウザ仕様で無視される (=onClose も走らない)
    expect((closeBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('processingFilePath 指定中は復元/破棄ボタンが disabled (回帰防止: 既存挙動)', () => {
    render(
      <BackupRestoreDialog
        {...base}
        onClose={vi.fn()}
        processingFilePath={sampleBackup.file_path}
      />,
    );
    const restore = screen.getByRole('button', { name: /復元中|復元する/ });
    const discard = screen.getByRole('button', { name: /破棄する/ });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
    expect((discard as HTMLButtonElement).disabled).toBe(true);
  });

  it('processingFilePath 指定中は backdrop クリックでも onClose を呼ばず、onCloseSuppressed を呼ぶ', () => {
    const onClose = vi.fn();
    const onCloseSuppressed = vi.fn();
    const { container } = render(
      <BackupRestoreDialog
        {...base}
        onClose={onClose}
        processingFilePath={sampleBackup.file_path}
        onCloseSuppressed={onCloseSuppressed}
      />,
    );
    const backdrop = container.querySelector('.backup-restore-backdrop') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseSuppressed).toHaveBeenCalled();
  });
});
