/**
 * PCT-056: BatchJobDialog — バックドロップクリックのガード動作を検証する。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { BatchJobDialog } from '../../components/BatchJobDialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock('lucide-react', () => ({
  FolderOpen: () => null,
  Play: () => null,
  X: () => null,
  RefreshCw: () => null,
}));

afterEach(() => cleanup());

const defaultProps = {
  onClose: vi.fn(),
  currentJob: null,
  isRunning: false,
  onStart: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn(),
  onResume: vi.fn().mockResolvedValue(undefined),
  onClear: vi.fn(),
};

describe('BatchJobDialog backdrop click guard (PCT-056)', () => {
  it('isRunning=false のときバックドロップクリックで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    const { container } = render(
      <BatchJobDialog {...defaultProps} onClose={onClose} isRunning={false} />,
    );
    const backdrop = container.firstElementChild as HTMLElement;
    // backdrop に直接 click を発火 (target === currentTarget = backdrop)
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('isRunning=true のときバックドロップクリックで onClose が呼ばれない (PCT-056)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <BatchJobDialog {...defaultProps} onClose={onClose} isRunning={true} />,
    );
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    // isRunning=true のため onClose は呼ばれない
    expect(onClose).not.toHaveBeenCalled();
  });
});

// #442 (R23狩り Wave4): ヘッダの✕ボタンは backdrop クリックガード(PCT-056)と非対称に
// isRunning を見ず無条件で onClose を呼んでいた。backdrop 側と同じガードを適用する。
describe('BatchJobDialog header close (X) button guard (#442)', () => {
  it('isRunning=true のときヘッダの✕ボタンをクリックしても onClose が呼ばれない', () => {
    const onClose = vi.fn();
    const { getByTitle } = render(
      <BatchJobDialog {...defaultProps} onClose={onClose} isRunning={true} />,
    );
    const closeButton = getByTitle('実行中は閉じられません');
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('isRunning=false のときヘッダの✕ボタンをクリックすると onClose が呼ばれる', () => {
    const onClose = vi.fn();
    const { getByTitle } = render(
      <BatchJobDialog {...defaultProps} onClose={onClose} isRunning={false} />,
    );
    const closeButton = getByTitle('閉じる');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });
});
