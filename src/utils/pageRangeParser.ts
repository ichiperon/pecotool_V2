/**
 * #199: ページ範囲指定パーサ
 *
 * 入力形式 (1-indexed):
 *   "1-5"      → [0, 1, 2, 3, 4]
 *   "1, 3, 5"  → [0, 2, 4]
 *   "1-3, 7, 10-12" → [0, 1, 2, 6, 9, 10, 11]
 *   "100-"     → [99, 100, ..., totalPages-1]
 *   "-50"      → [0, 1, ..., 49]
 *   ""         → { error: "範囲が空です" }
 *   "abc"      → { error: "不正な形式" }
 *
 * 戻り値:
 *   成功: number[] (0-indexed, ソート済み, 重複なし)
 *   失敗: { error: string }
 */
export type PageRangeResult = number[] | { error: string };

export function parsePageRange(input: string, totalPages: number): PageRangeResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { error: '範囲が空です' };
  }

  const indices = new Set<number>();
  const tokens = trimmed.split(',');

  for (const token of tokens) {
    const part = token.trim();
    if (part === '') continue;

    // "N-M" or "N-" or "-M" or "N"
    const rangeMatch = part.match(/^(\d*)-(\d*)$/);
    if (rangeMatch) {
      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];

      // "-" のみは不正
      if (startStr === '' && endStr === '') {
        return { error: `不正な形式: "${part}"` };
      }

      const start = startStr !== '' ? parseInt(startStr, 10) : 1;
      const end = endStr !== '' ? parseInt(endStr, 10) : totalPages;

      if (startStr !== '' && start < 1) {
        return { error: `ページ番号は1以上を指定してください: "${part}"` };
      }
      if (endStr !== '' && end < 1) {
        return { error: `ページ番号は1以上を指定してください: "${part}"` };
      }
      if (start > end) {
        return { error: `開始ページが終了ページより大きいです: "${part}"` };
      }

      // 0-indexed に変換し、totalPages でクリップ
      const clampedStart = Math.max(0, start - 1);
      const clampedEnd = Math.min(totalPages - 1, end - 1);
      for (let i = clampedStart; i <= clampedEnd; i++) {
        indices.add(i);
      }
      continue;
    }

    // 単一ページ番号
    const singleMatch = part.match(/^(\d+)$/);
    if (singleMatch) {
      const pageNum = parseInt(singleMatch[1], 10);
      if (pageNum < 1) {
        return { error: `ページ番号は1以上を指定してください: "${part}"` };
      }
      // 範囲外でも clip (totalPages を超える場合は無視)
      if (pageNum <= totalPages) {
        indices.add(pageNum - 1);
      }
      continue;
    }

    // それ以外は不正
    return { error: `不正な形式: "${part}"` };
  }

  if (indices.size === 0) {
    return { error: '有効なページが範囲内に存在しません' };
  }

  return Array.from(indices).sort((a, b) => a - b);
}
