import type { Action } from '../types';

export interface SaveDiffEntry {
  pageIndex: number;
  blockId: string;
  before: string;
  after: string;
  changeType: 'modified' | 'added' | 'removed';
}

export interface SaveDiffSummary {
  entries: SaveDiffEntry[];
  totalPages: number;
  changedPages: number[];
  timestamp: number;
}

/**
 * undoStack のうち lastSavedActionIndex 以降のエントリを集約し、
 * 「最後の保存以降に変更されたテキストブロック」の before/after を返す。
 *
 * update_page / update_pages アクションのみを対象とする。
 * ページ削除・並べ替え・回転は diff 対象外（テキスト変更ではないため）。
 *
 * 同一ブロックが複数回変更された場合は最初の before と最後の after を使い、
 * 中間状態は捨てる（保存直前時点との差分が目的なので）。
 */
export function computeSaveDiff(
  undoStack: Action[],
  lastSavedActionIndex: number,
): SaveDiffSummary {
  const timestamp = Date.now();

  // lastSavedActionIndex 以降のアクションだけを対象にする
  const recentActions = undoStack.slice(lastSavedActionIndex);

  // ブロックごとに初回 before と最終 after を蓄積する
  // key: `${pageIndex}:${blockId}`
  type BlockKey = string;
  const beforeMap = new Map<BlockKey, { pageIndex: number; blockId: string; text: string }>();
  const afterMap = new Map<BlockKey, { pageIndex: number; blockId: string; text: string }>();

  for (const action of recentActions) {
    if (action.type === 'update_page') {
      const { pageIndex, before, after } = action;
      // before 側: まだ記録されていないブロックのみ初回 before を保存
      for (const block of before.textBlocks) {
        const key: BlockKey = `${pageIndex}:${block.id}`;
        if (!beforeMap.has(key)) {
          beforeMap.set(key, { pageIndex, blockId: block.id, text: block.text });
        }
      }
      // after 側: 常に最新で上書き
      for (const block of after.textBlocks) {
        const key: BlockKey = `${pageIndex}:${block.id}`;
        afterMap.set(key, { pageIndex, blockId: block.id, text: block.text });
      }
      // before にあって after にないブロック（削除）も after として空文字列で記録
      const afterIds = new Set(after.textBlocks.map((b) => b.id));
      for (const block of before.textBlocks) {
        const key: BlockKey = `${pageIndex}:${block.id}`;
        if (!afterIds.has(block.id)) {
          afterMap.set(key, { pageIndex, blockId: block.id, text: '' });
        }
      }
    } else if (action.type === 'update_pages') {
      for (const entry of action.entries) {
        const { pageIndex, before, after } = entry;
        for (const block of before.textBlocks) {
          const key: BlockKey = `${pageIndex}:${block.id}`;
          if (!beforeMap.has(key)) {
            beforeMap.set(key, { pageIndex, blockId: block.id, text: block.text });
          }
        }
        for (const block of after.textBlocks) {
          const key: BlockKey = `${pageIndex}:${block.id}`;
          afterMap.set(key, { pageIndex, blockId: block.id, text: block.text });
        }
        const afterIds = new Set(after.textBlocks.map((b) => b.id));
        for (const block of before.textBlocks) {
          const key: BlockKey = `${pageIndex}:${block.id}`;
          if (!afterIds.has(block.id)) {
            afterMap.set(key, { pageIndex, blockId: block.id, text: '' });
          }
        }
      }
    }
    // delete_pages / reorder_pages / rotate_pages は skip
  }

  // before と after を突合して diff エントリを生成
  const entries: SaveDiffEntry[] = [];
  const changedPageSet = new Set<number>();

  // after に存在するキーを全部チェック
  for (const [key, afterInfo] of afterMap) {
    const beforeInfo = beforeMap.get(key);
    const beforeText = beforeInfo?.text ?? '';
    const afterText = afterInfo.text;

    if (beforeText === afterText) continue; // 変化なし

    let changeType: SaveDiffEntry['changeType'];
    if (beforeInfo === undefined) {
      changeType = 'added';
    } else if (afterText === '') {
      changeType = 'removed';
    } else {
      changeType = 'modified';
    }

    entries.push({
      pageIndex: afterInfo.pageIndex,
      blockId: afterInfo.blockId,
      before: beforeText,
      after: afterText,
      changeType,
    });
    changedPageSet.add(afterInfo.pageIndex);
  }

  // before にはあったが after に記録されなかったキー（追記アクションで消えたブロック）
  for (const [key, beforeInfo] of beforeMap) {
    if (afterMap.has(key)) continue;
    // after に記録がない = このアクション以降でブロックが消えた
    entries.push({
      pageIndex: beforeInfo.pageIndex,
      blockId: beforeInfo.blockId,
      before: beforeInfo.text,
      after: '',
      changeType: 'removed',
    });
    changedPageSet.add(beforeInfo.pageIndex);
  }

  // ページインデックス昇順、同ページ内はブロックID昇順でソート
  entries.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return a.blockId.localeCompare(b.blockId);
  });

  const changedPages = Array.from(changedPageSet).sort((a, b) => a - b);

  return {
    entries,
    totalPages: changedPages.length,
    changedPages,
    timestamp,
  };
}
