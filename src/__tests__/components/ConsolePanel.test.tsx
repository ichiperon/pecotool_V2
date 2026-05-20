/**
 * Issue #57 regression: ConsolePanel のフィルタ/コピー/長文対応。
 *
 * - level (error/warn/log) フィルタチェックボックスで表示が絞られる
 * - 「全ログコピー」ボタンで navigator.clipboard.writeText が呼ばれる
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConsolePanel } from '../../components/Console/ConsolePanel';

afterEach(() => cleanup());

const SAMPLE_LOGS = [
  { level: 'error' as const, message: 'boom', time: '12:00:00' },
  { level: 'warn' as const, message: 'careful', time: '12:00:01' },
  { level: 'log' as const, message: 'hello', time: '12:00:02' },
];

function renderPanel(props?: Partial<React.ComponentProps<typeof ConsolePanel>>) {
  const endRef = React.createRef<HTMLDivElement>();
  return render(
    <ConsolePanel
      logs={props?.logs ?? SAMPLE_LOGS}
      onClear={props?.onClear ?? (() => {})}
      onClose={props?.onClose ?? (() => {})}
      endRef={endRef}
    />,
  );
}

describe('ConsolePanel (Issue #57): フィルタチェックボックス', () => {
  it('初期状態では error / warn / log すべて表示される', () => {
    renderPanel();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('careful')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('error チェックを外すと error 行が非表示になる', () => {
    renderPanel();
    const errorCheckbox = screen.getByRole('checkbox', { name: /error/i });
    fireEvent.click(errorCheckbox);
    expect(screen.queryByText('boom')).toBeNull();
    // 他レベルは残る
    expect(screen.getByText('careful')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('warn / log も同様に外すと該当行のみ表示される', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /warn/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^log/i }));
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByText('careful')).toBeNull();
    expect(screen.queryByText('hello')).toBeNull();
  });

  it('すべてのフィルタを外すと「ログなし」が出る', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /error/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /warn/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^log/i }));
    expect(screen.getByText('ログなし')).toBeTruthy();
  });
});

describe('ConsolePanel (Issue #57): 全ログコピー', () => {
  let mockWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  it('ボタンクリックで navigator.clipboard.writeText が全ログ文字列で呼ばれる', async () => {
    renderPanel();
    const copyBtn = screen.getByRole('button', { name: '全ログコピー' });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    const arg = mockWriteText.mock.calls[0][0] as string;
    // 全ログ (フィルタの外し有無に関わらず全件) が含まれている
    expect(arg).toContain('boom');
    expect(arg).toContain('careful');
    expect(arg).toContain('hello');
    // 改行で区切られている
    expect(arg.split('\n').length).toBe(3);
    // level/time が含まれる
    expect(arg).toContain('ERROR');
    expect(arg).toContain('12:00:00');
  });

  it('ログが空の時はコピーボタンが disabled', () => {
    renderPanel({ logs: [] });
    const copyBtn = screen.getByRole('button', { name: '全ログコピー' }) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
  });

  it('フィルタ表示中でも全ログ (非表示分含む) がコピーされる', async () => {
    renderPanel();
    // error を非表示にする
    fireEvent.click(screen.getByRole('checkbox', { name: /error/i }));
    const copyBtn = screen.getByRole('button', { name: '全ログコピー' });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    const arg = mockWriteText.mock.calls[0][0] as string;
    expect(arg).toContain('boom'); // フィルタで隠してもコピーには含まれる
  });
});
