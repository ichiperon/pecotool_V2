/**
 * useOcrEngine: EMA 計算 + estimatedRemainingMs ロジックのユニットテスト (#200)
 *
 * useOcrEngine 本体は Tauri/pdfjs への依存が重いためフックごとテストしない。
 * 代わりに「EMA 更新式」「estimatedRemainingMs 計算式」「formatMmSs」を
 * 純粋関数として抽出し、仕様どおりに動くことを確認する。
 */
import { describe, it, expect } from 'vitest';

// ---- EMA ヘルパー (useOcrEngine.ts の実装と同一ロジック) ----

const EMA_ALPHA = 0.3;

function updateAvgMsPerPage(prev: number, pageDurationMs: number): number {
  if (prev === 0) return pageDurationMs;
  return EMA_ALPHA * pageDurationMs + (1 - EMA_ALPHA) * prev;
}

function calcEstimatedRemainingMs(avgMsPerPage: number, remainingPages: number): number {
  return avgMsPerPage * remainingPages;
}

// ---- mm:ss フォーマット (App.tsx の formatMmSs と同一ロジック) ----

function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- テスト ----

describe('OCR EMA: updateAvgMsPerPage', () => {
  it('初回ページ(prev=0)はそのまま pageDurationMs を返す', () => {
    expect(updateAvgMsPerPage(0, 500)).toBe(500);
  });

  it('2ページ目以降は EMA (α=0.3) で更新される', () => {
    const prev = 500;
    const next = 1000;
    // 0.3 * 1000 + 0.7 * 500 = 650
    expect(updateAvgMsPerPage(prev, next)).toBeCloseTo(650, 5);
  });

  it('ページ時間が前回と同じなら変化しない', () => {
    expect(updateAvgMsPerPage(400, 400)).toBeCloseTo(400, 5);
  });

  it('連続10ページで平均が入力値に収束していく方向に動く', () => {
    let avg = 0;
    const target = 800;
    for (let i = 0; i < 10; i++) {
      avg = updateAvgMsPerPage(avg, target);
    }
    // 初回は target のまま, 2回目以降 EMA なので最終は target に近いはず
    expect(avg).toBeCloseTo(target, 0);
  });
});

describe('OCR EMA: calcEstimatedRemainingMs', () => {
  it('avgMsPerPage * remainingPages を返す', () => {
    expect(calcEstimatedRemainingMs(1000, 10)).toBe(10000);
  });

  it('残りページ 0 なら 0 を返す', () => {
    expect(calcEstimatedRemainingMs(1000, 0)).toBe(0);
  });

  it('avgMsPerPage が 0 なら 0 を返す', () => {
    expect(calcEstimatedRemainingMs(0, 50)).toBe(0);
  });
});

describe('formatMmSs', () => {
  it('0ms → 00:00', () => {
    expect(formatMmSs(0)).toBe('00:00');
  });

  it('60000ms → 01:00', () => {
    expect(formatMmSs(60000)).toBe('01:00');
  });

  it('90500ms → 01:31 (丸め: 90.5秒 → 91秒)', () => {
    expect(formatMmSs(90500)).toBe('01:31');
  });

  it('3661000ms → 61:01', () => {
    expect(formatMmSs(3661000)).toBe('61:01');
  });

  it('負の値は 00:00 にクランプ', () => {
    expect(formatMmSs(-5000)).toBe('00:00');
  });
});

describe('OCR 3ページ以下は計算中扱い', () => {
  it('current <= 3 のとき avgMsPerPage を表示しない判定', () => {
    // App.tsx の表示ロジック: ocrProgress.current <= 3 で「計算中...」
    const shouldShowAvg = (current: number) => current > 3;
    expect(shouldShowAvg(0)).toBe(false);
    expect(shouldShowAvg(1)).toBe(false);
    expect(shouldShowAvg(3)).toBe(false);
    expect(shouldShowAvg(4)).toBe(true);
    expect(shouldShowAvg(100)).toBe(true);
  });
});
