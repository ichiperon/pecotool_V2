import { useCallback, useRef } from 'react';
import { usePecoStore, waitForPendingIdbSaves, trackPendingIdbWork } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import {
  deleteTemporaryPageKeys,
} from '../utils/pdfTemporaryStorage';

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
    (displayIndices: number[]) => enqueuePageOperation(async () => {
      await waitForPendingIdbSaves();

      // PCT-104 (A-lite 段階3): deletedPageIds は pageId 文字列配列。rename は不要。
      await deletePages(displayIndices, (filePath, deletedPageIds) => {
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
    }),
    [deletePages, enqueuePageOperation],
  );

  const handleMovePage = useCallback(
    (fromDisplayIndex: number, toDisplayIndex: number) => enqueuePageOperation(async () => {
      await waitForPendingIdbSaves();

      // PCT-104 (A-lite 段階3): movePage は IDB キー操作不要（pageId 不変）。
      // onIdbWork コールバックは no-op として渡す。
      await movePage(fromDisplayIndex, toDisplayIndex, (_filePath) => {
        // pageId ベースのため rename 不要
      });
    }),
    [movePage, enqueuePageOperation],
  );

  return { handleDeletePages, handleMovePage };
}
