/**
 * Issue #38 regression: F5 (再読み込み) must go through handleReload so the
 * isSaving guard from handleReload applies. Previously the inline F5 useEffect
 * in App.tsx called handleOpen(doc.filePath) directly, bypassing isSaving.
 *
 * This test mirrors the exact useEffect contract in App.tsx and verifies that:
 *  - F5 invokes the passed handleReload callback
 *  - F5 default behavior is prevented
 *  - The listener is cleaned up on unmount
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useEffect } from 'react';

afterEach(() => cleanup());

// 検証対象: App.tsx の F5 useEffect と同一仕様の hook。
// App.tsx 内に inline 定義されているため、契約 (handleReload を呼ぶ) のみを
// ここで担保する。仕様逸脱した場合、本 hook と App.tsx を同時に修正する。
function useF5ReloadShortcut(handleReload: () => void) {
  useEffect(() => {
    const handleF5 = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        handleReload();
      }
    };
    window.addEventListener('keydown', handleF5);
    return () => window.removeEventListener('keydown', handleF5);
  }, [handleReload]);
}

function pressF5() {
  const event = new KeyboardEvent('keydown', {
    key: 'F5',
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe('Issue #38: F5 routes through handleReload (isSaving guard)', () => {
  it('F5 押下で handleReload が呼ばれる (handleOpen 直叩き禁止)', () => {
    const handleReload = vi.fn();
    renderHook(() => useF5ReloadShortcut(handleReload));

    const event = pressF5();

    expect(handleReload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('F5 は常に handleReload に委譲する (旧実装は handleOpen 直叩きで isSaving を無視していた)', () => {
    // 本 issue の core: F5 は handleReload を呼ぶこと。
    // handleReload 内部の isSaving ガードは useFileOperations 側の責務であり、
    // F5 hook は handleReload に丸投げするのが正しい契約。
    const handleReload = vi.fn();
    renderHook(() => useF5ReloadShortcut(handleReload));

    pressF5();
    pressF5();
    expect(handleReload).toHaveBeenCalledTimes(2);
  });

  it('unmount で keydown リスナーが解除される', () => {
    const handleReload = vi.fn();
    const { unmount } = renderHook(() => useF5ReloadShortcut(handleReload));

    unmount();
    pressF5();

    expect(handleReload).not.toHaveBeenCalled();
  });
});

/**
 * Issue #102: handleReload は OCR 実行中の場合、handleOpen を呼ばずに早期 return する。
 * App.tsx の handleReload 仕様を JS 関数として複製して isOcrRunning ガードの契約を担保する。
 * 仕様変更時はここと App.tsx を同時に修正する。
 */
function makeHandleReload({
  isSaving,
  isOcrRunning,
  filePath,
  showToast,
  handleOpen,
}: {
  isSaving: boolean;
  isOcrRunning: boolean;
  filePath: string | undefined;
  showToast: (msg: string) => void;
  handleOpen: (path: string) => Promise<boolean>;
}) {
  return async () => {
    if (isSaving) {
      showToast('保存中は再読み込みできません。');
      return;
    }
    if (isOcrRunning) {
      showToast('OCR実行中は再読み込みできません。OCRを中止してから再度お試しください。');
      return;
    }
    if (!filePath) return;
    await handleOpen(filePath);
  };
}

describe('Issue #102: handleReload は OCR 実行中なら handleOpen を呼ばない', () => {
  it('#102: isOcrRunning=true なら handleOpen は呼ばれず Toast が出る', async () => {
    const showToast = vi.fn();
    const handleOpen = vi.fn().mockResolvedValue(true);
    const reload = makeHandleReload({
      isSaving: false,
      isOcrRunning: true,
      filePath: '/path.pdf',
      showToast,
      handleOpen,
    });

    await reload();

    expect(handleOpen).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toMatch(/OCR.*再読み込み/);
  });

  it('#102: isOcrRunning=false なら handleOpen は呼ばれる', async () => {
    const showToast = vi.fn();
    const handleOpen = vi.fn().mockResolvedValue(true);
    const reload = makeHandleReload({
      isSaving: false,
      isOcrRunning: false,
      filePath: '/path.pdf',
      showToast,
      handleOpen,
    });

    await reload();

    expect(handleOpen).toHaveBeenCalledWith('/path.pdf');
  });

  it('#102: isSaving が優先される (両方 true でも保存中メッセージが先に出る)', async () => {
    const showToast = vi.fn();
    const handleOpen = vi.fn().mockResolvedValue(true);
    const reload = makeHandleReload({
      isSaving: true,
      isOcrRunning: true,
      filePath: '/path.pdf',
      showToast,
      handleOpen,
    });

    await reload();

    expect(handleOpen).not.toHaveBeenCalled();
    // isSaving チェックが先に走るので保存中メッセージが出る
    expect(showToast.mock.calls[0][0]).toMatch(/保存中/);
  });
});
