/**
 * Wave4 regression: 自動更新ダウンロード失敗が完全サイレントだった問題の配線テスト。
 *
 * 従来は downloadAndInstall の失敗が useAppUpdater 内部の state.error に
 * 入るだけで、App.tsx 側は updateState.available しか参照しておらず、
 * 失敗 (回線断・署名検証失敗) 時にユーザーへのフィードバックが一切なかった。
 *
 * App.tsx は Tauri 依存や巨大な state 群のため実レンダリングでの検証が難しく、
 * 本リポジトリでは同種の App.tsx 配線検証を「同一仕様のロジックを抽出して
 * 契約検証する」方針で行っている (appSavingEsc.test.tsx 等)。
 * ここでは (1) 抽出したロジックの振る舞い検証 と (2) 実 App.tsx のソースに
 * 対応する記述が実在することの確認、の2段構えで検証する。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { DownloadInstallResult } from '../../hooks/useAppUpdater';
import type { ToastAction } from '../../hooks/useDialogState';

const DOWNLOAD_FAILED_MESSAGE =
  'アップデートのダウンロードに失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。';
const DOWNLOAD_STARTED_MESSAGE = 'アップデートをダウンロードしています...';

// App.tsx の handleDownloadAndInstall と同一仕様。
function makeHandleDownloadAndInstall(
  downloadAndInstall: () => Promise<DownloadInstallResult>,
  showToast: (message: string, isError?: boolean, action?: ToastAction) => void,
) {
  const handle = async (): Promise<void> => {
    showToast(DOWNLOAD_STARTED_MESSAGE);
    const result = await downloadAndInstall();
    if (result === 'error') {
      showToast(
        DOWNLOAD_FAILED_MESSAGE,
        true,
        { label: '更新する', onClick: () => { void handle(); } },
      );
    }
  };
  return handle;
}

describe('Wave4: App.tsx の updater ダウンロード失敗フィードバック配線 (ロジック契約)', () => {
  it('downloadAndInstall が失敗すると showToast がエラー表示・再試行アクション付きで呼ばれる', async () => {
    const showToast = vi.fn();
    const downloadAndInstall = vi.fn().mockResolvedValue('error' satisfies DownloadInstallResult);
    const handle = makeHandleDownloadAndInstall(downloadAndInstall, showToast);

    await handle();

    expect(showToast).toHaveBeenNthCalledWith(1, DOWNLOAD_STARTED_MESSAGE);
    expect(showToast).toHaveBeenNthCalledWith(
      2,
      DOWNLOAD_FAILED_MESSAGE,
      true,
      expect.objectContaining({ label: '更新する' }),
    );
  });

  it('downloadAndInstall が成功した場合はエラートーストを出さない', async () => {
    const showToast = vi.fn();
    const downloadAndInstall = vi.fn().mockResolvedValue('success' satisfies DownloadInstallResult);
    const handle = makeHandleDownloadAndInstall(downloadAndInstall, showToast);

    await handle();

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(DOWNLOAD_STARTED_MESSAGE);
  });

  it('busy (多重起動ガードで弾かれたケース) はエラートーストを出さない (二重通知防止)', async () => {
    const showToast = vi.fn();
    const downloadAndInstall = vi.fn().mockResolvedValue('busy' satisfies DownloadInstallResult);
    const handle = makeHandleDownloadAndInstall(downloadAndInstall, showToast);

    await handle();

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('再試行アクションの onClick は再度 handle を呼び直す (再帰的リトライ導線)', async () => {
    const showToast = vi.fn();
    const downloadAndInstall = vi.fn()
      .mockResolvedValueOnce('error' satisfies DownloadInstallResult)
      .mockResolvedValueOnce('success' satisfies DownloadInstallResult);
    const handle = makeHandleDownloadAndInstall(downloadAndInstall, showToast);

    await handle();
    const retryAction = showToast.mock.calls[1][2] as ToastAction;
    await retryAction.onClick();

    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    // 2 回目は成功するのでエラートーストは 1 回のみ (最初の失敗分だけ)
    const errorCalls = showToast.mock.calls.filter(call => call[1] === true);
    expect(errorCalls).toHaveLength(1);
  });
});

describe('Wave4: 実 App.tsx ソースに対応する配線が存在すること (drift 防止)', () => {
  const appPath = resolve(process.cwd(), 'src/App.tsx');
  const sourceText = readFileSync(appPath, 'utf8');

  it('handleDownloadAndInstall が定義されている', () => {
    expect(sourceText).toContain('const handleDownloadAndInstall = useCallback(async () => {');
  });

  it('ダウンロード開始トーストを出している', () => {
    expect(sourceText).toContain(`showToast('${DOWNLOAD_STARTED_MESSAGE}');`);
  });

  it("結果が 'error' の場合にエラートースト (再試行アクション付き) を出している", () => {
    expect(sourceText).toContain("if (result === 'error') {");
    expect(sourceText).toContain(DOWNLOAD_FAILED_MESSAGE);
  });

  it('「更新する」トーストの onClick は handleDownloadAndInstall を呼ぶ (downloadAndInstall 直呼びに戻っていないこと)', () => {
    expect(sourceText).toContain("onClick: () => { void handleDownloadAndInstall(); },");
    // 旧配線 (再入ガード無し) への回帰を検知する
    expect(sourceText).not.toContain("onClick: () => { void downloadAndInstall(); },");
  });
});
