import { useCallback, useRef } from 'react';
import { usePecoStore, waitForPendingIdbSaves, trackPendingIdbWork } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import {
  deleteTemporaryPageKeys,
} from '../utils/pdfTemporaryStorage';
import { resolvePageId, resolveDisplayIndex } from '../utils/pageOrder';

/**
 * #254: ページ削除・並べ替えの IDB I/O を hook 層で担うカスタムフック。
 * pecoStore の deletePages / movePage action は pure state 変換のみを行い、
 * IDB 側副作用はこの hook が責任を持つ。
 * PCT-104 (A-lite 段階3): pageId が不変なため movePage の IDB rename は完全に不要。
 */
export function usePageManagement() {
  const deletePages = usePecoStore((s) => s.deletePages);
  const movePage = usePecoStore((s) => s.movePage);
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueuePageOperation = useCallback((operation: () => Promise<void>) => {
    const queued = operationQueueRef.current.then(operation, operation);
    operationQueueRef.current = queued.catch(() => {});
    return queued;
  }, []);

  const handleDeletePages = useCallback(
    (displayIndices: number[]) => {
      // PCT-208: displayIndices は「呼び出された時点」のドキュメントの pageOrder を
      // 基準に決めた値。この直列キューは Promise 連結のみで、先行 operation が
      // まだキュー内で待機中の間に本呼び出しが行われることがある (同一ファイル内の
      // 連続削除・並べ替え等)。以前は entryEpoch/entryFilePath の検証を operation
      // 実行時 (先行 operation 適用後) にキャプチャしていたため、ファイル自体は
      // 変わっていない同一ファイル内の連続操作では常に検証を通過してしまい、
      // pageOrder が先行 operation で既にずれていても displayIndices を無検証で
      // 適用していた。呼び出し時点で対象ページを pageId として固定し、実行直前に
      // 最新 pageOrder で displayIndex へ再解決することで、対象ページの取り違えを防ぐ。
      const entryPageOrder = usePecoStore.getState().pageOrder;
      const targetPageIds = displayIndices.map((displayIndex) => resolvePageId(entryPageOrder, displayIndex));

      return enqueuePageOperation(async () => {
        // H-3 (bug-hunt round2): onIdbWork を渡すこの経路では pecoStore.deletePages
        // 内の F-6 ガードは実質的な待機を検出できない (待機自体をこの hook が担うため)。
        // 待機前の epoch/filePath をここでキャプチャし、待機後に再検証する。待機中に
        // ファイル切替/開き直しが完了していたら、旧ドキュメント基準の対象を
        // 新ドキュメントへ誤適用しないよう中止する。
        const entryEpoch = useInfraStore.getState().documentEpoch;
        const entryFilePath = usePecoStore.getState().document?.filePath ?? null;
        await waitForPendingIdbSaves();
        if (
          useInfraStore.getState().documentEpoch !== entryEpoch ||
          (usePecoStore.getState().document?.filePath ?? null) !== entryFilePath
        ) {
          return;
        }

        // PCT-208: 実行直前の最新 pageOrder で pageId → displayIndex を再解決する。
        // 直列キュー内の先行 operation 適用で pageOrder が呼び出し時から動いていても、
        // 「同じ物理ページ」を指し続ける。既に削除済み等で見つからない対象は無視する。
        const currentPageOrder = usePecoStore.getState().pageOrder;
        const resolvedDisplayIndices = targetPageIds
          .map((pageId) => resolveDisplayIndex(currentPageOrder, pageId))
          .filter((idx) => idx !== -1);
        if (resolvedDisplayIndices.length === 0) return;

        // PCT-104 (A-lite 段階3): deletedPageIds は pageId 文字列配列。rename は不要。
        await deletePages(resolvedDisplayIndices, (filePath, deletedPageIds) => {
          const work = deleteTemporaryPageKeys(filePath, deletedPageIds)
            .then(() => {
              useInfraStore.getState().clearLastIdbErrorIfSet();
            })
            .catch((e: unknown) => {
              const err = e instanceof Error ? e : new Error(String(e));
              console.error('[usePageManagement] deletePages IDB 同期失敗:', err);
              useInfraStore.getState().setLastIdbError(err);
            });
          trackPendingIdbWork(work);
        });
      });
    },
    [deletePages, enqueuePageOperation],
  );

  const handleMovePage = useCallback(
    (fromDisplayIndex: number, toDisplayIndex: number) => {
      // PCT-208: handleDeletePages と同型の対策。移動元ページを呼び出し時点の
      // pageOrder で pageId として固定し、実行直前に最新 pageOrder で再解決する。
      // 移動先 (toDisplayIndex) は「現在の並びの何番目に挿入するか」という
      // 位置そのものの指定であり、対応する固定ページ identity が無いため
      // pageId化はできない。pecoStore.movePage 側の範囲外チェック (state.pageOrder.length
      // 超過で no-op) にフォールバックを委ねる。
      const entryPageOrder = usePecoStore.getState().pageOrder;
      const fromPageId = resolvePageId(entryPageOrder, fromDisplayIndex);

      return enqueuePageOperation(async () => {
        // H-3 (bug-hunt round2): handleDeletePages と同型のガード。待機中にファイル
        // 切替が完了していたら新ドキュメントへ誤適用しないよう中止する。
        const entryEpoch = useInfraStore.getState().documentEpoch;
        const entryFilePath = usePecoStore.getState().document?.filePath ?? null;
        await waitForPendingIdbSaves();
        if (
          useInfraStore.getState().documentEpoch !== entryEpoch ||
          (usePecoStore.getState().document?.filePath ?? null) !== entryFilePath
        ) {
          return;
        }

        // PCT-208: 実行直前の最新 pageOrder で移動元ページを再解決する。
        const currentPageOrder = usePecoStore.getState().pageOrder;
        const resolvedFromIndex = resolveDisplayIndex(currentPageOrder, fromPageId);
        if (resolvedFromIndex === -1) return;

        // PCT-104 (A-lite 段階3): movePage は IDB キー操作不要（pageId 不変）。
        // onIdbWork コールバックは no-op として渡す。
        await movePage(resolvedFromIndex, toDisplayIndex, (_filePath) => {
          // pageId ベースのため rename 不要
        });
      });
    },
    [movePage, enqueuePageOperation],
  );

  return { handleDeletePages, handleMovePage };
}
