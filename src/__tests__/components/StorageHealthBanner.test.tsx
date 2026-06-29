/**
 * StorageHealthBanner のコンポーネントテスト。
 *
 * - lastIdbError 非 null → 失敗文言の表示・閉じるボタンで clearLastIdbError 呼出
 * - storageWarning warn → 警告文言・role="status"
 * - storageWarning critical → 強い警告文言・role="alert"
 * - 両方なし → 何も表示されない
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useInfraStore } from '../../store/infraStore';
import { StorageHealthBanner } from '../../components/StorageHealthBanner';

afterEach(() => {
  cleanup();
  useInfraStore.setState({
    documentEpoch: 0,
    pageAccessOrder: [],
    pendingRestoration: null,
    lastIdbError: null,
    storageWarning: null,
    bboxMetaUnreadable: false,
    currentPageProxy: null,
    currentPageProxyKey: null,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('C-SHB-01: lastIdbError 非 null → IDB 失敗通知が表示される', () => {
  it('失敗文言が画面に表示される', () => {
    useInfraStore.setState({ lastIdbError: new Error('IDB write failed') });
    render(<StorageHealthBanner />);
    expect(
      screen.getByText(/一時データの保存に失敗しました/),
    ).toBeTruthy();
  });

  it('バナーが role="alert" を持つ', () => {
    useInfraStore.setState({ lastIdbError: new Error('test') });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('alert');
    expect(banner).toBeTruthy();
  });

  it('aria-live="assertive" が設定されている', () => {
    useInfraStore.setState({ lastIdbError: new Error('test') });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
  });

  it('閉じるボタンが aria-label="閉じる" を持つ', () => {
    useInfraStore.setState({ lastIdbError: new Error('test') });
    render(<StorageHealthBanner />);
    const closeBtn = screen.getByRole('button', { name: '閉じる' });
    expect(closeBtn).toBeTruthy();
  });

  it('閉じるボタンをクリックすると clearLastIdbError が呼ばれる（lastIdbError が null になる）', () => {
    const clearLastIdbError = vi.fn();
    // clearLastIdbError を spy してストアにセット
    useInfraStore.setState({
      lastIdbError: new Error('test'),
      clearLastIdbError,
    });

    render(<StorageHealthBanner />);
    const closeBtn = screen.getByRole('button', { name: '閉じる' });
    fireEvent.click(closeBtn);

    expect(clearLastIdbError).toHaveBeenCalledTimes(1);
  });
});

describe('C-SHB-02: storageWarning warn → 逼迫警告（軽）が表示される', () => {
  it('warn 文言が画面に表示される', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.82, level: 'warn' } });
    render(<StorageHealthBanner />);
    expect(
      screen.getByText(/ストレージの空き容量が少なくなっています/),
    ).toBeTruthy();
  });

  it('使用率パーセントが文言に含まれる', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.82, level: 'warn' } });
    render(<StorageHealthBanner />);
    expect(screen.getByText(/82%/)).toBeTruthy();
  });

  it('バナーが role="status" を持つ', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.82, level: 'warn' } });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toBeTruthy();
  });

  it('aria-live="polite" が設定されている', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.82, level: 'warn' } });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });
});

describe('C-SHB-03: storageWarning critical → 逼迫警告（強）が表示される', () => {
  it('critical 文言が画面に表示される', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.97, level: 'critical' } });
    render(<StorageHealthBanner />);
    expect(
      screen.getByText(/ストレージ残量がわずかです/),
    ).toBeTruthy();
  });

  it('使用率パーセントが文言に含まれる', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.97, level: 'critical' } });
    render(<StorageHealthBanner />);
    expect(screen.getByText(/97%/)).toBeTruthy();
  });

  it('バナーが role="alert" を持つ', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.97, level: 'critical' } });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('alert');
    expect(banner).toBeTruthy();
  });

  it('aria-live="assertive" が設定されている', () => {
    useInfraStore.setState({ storageWarning: { ratio: 0.97, level: 'critical' } });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
  });
});

describe('C-SHB-04: lastIdbError と storageWarning 両方 null → 何も表示されない', () => {
  it('バナーが描画されない', () => {
    render(<StorageHealthBanner />);
    // role="alert" も role="status" も存在しない
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('C-SHB-05: lastIdbError と storageWarning が同時に非 null → IDB 失敗（critical）が優先される', () => {
  it('storageWarning があっても IDB 失敗文言が表示される', () => {
    useInfraStore.setState({
      lastIdbError: new Error('IDB write failed'),
      storageWarning: { ratio: 0.82, level: 'warn' },
    });
    render(<StorageHealthBanner />);
    expect(
      screen.getByText(/一時データの保存に失敗しました/),
    ).toBeTruthy();
    // warn 文言は表示されない
    expect(
      screen.queryByText(/ストレージの空き容量が少なくなっています/),
    ).toBeNull();
  });
});

describe('C-SHB-06: bboxMetaUnreadable → 編集が保存に反映されない旨が表示される (#392)', () => {
  it('警告文言が表示される', () => {
    useInfraStore.setState({ bboxMetaUnreadable: true });
    render(<StorageHealthBanner />);
    expect(screen.getByText(/読み込めないOCRデータ/)).toBeTruthy();
    expect(screen.getByText(/保存されません/)).toBeTruthy();
  });

  it('role="status" / aria-live="polite"', () => {
    useInfraStore.setState({ bboxMetaUnreadable: true });
    render(<StorageHealthBanner />);
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });

  it('恒久バナー: 閉じるボタンが無い（dismiss 不可・open/close で自動 reset）', () => {
    useInfraStore.setState({ bboxMetaUnreadable: true });
    render(<StorageHealthBanner />);
    // dismiss を許すと「閉じた後に編集→保存で silent 喪失」の導線が残るため閉じる不可。
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
  });
});

describe('C-SHB-07: 優先順位 lastIdbError > bboxMetaUnreadable > storageWarning', () => {
  it('lastIdbError があれば bboxMetaUnreadable より IDB 失敗が優先', () => {
    useInfraStore.setState({ lastIdbError: new Error('x'), bboxMetaUnreadable: true });
    render(<StorageHealthBanner />);
    expect(screen.getByText(/一時データの保存に失敗しました/)).toBeTruthy();
    expect(screen.queryByText(/読み込めないOCRデータ/)).toBeNull();
  });

  it('bboxMetaUnreadable があれば storageWarning より優先', () => {
    useInfraStore.setState({
      bboxMetaUnreadable: true,
      storageWarning: { ratio: 0.82, level: 'warn' },
    });
    render(<StorageHealthBanner />);
    expect(screen.getByText(/読み込めないOCRデータ/)).toBeTruthy();
    expect(screen.queryByText(/ストレージの空き容量が少なくなっています/)).toBeNull();
  });
});
