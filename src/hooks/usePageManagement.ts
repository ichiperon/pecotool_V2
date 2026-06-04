import { useCallback, useRef } from 'react';
import { usePecoStore, waitForPendingIdbSaves, trackPendingIdbWork } from '../store/pecoStore';
import { useInfraStore } from '../store/infraStore';
import {
  deleteTemporaryPageKeys,
  renameTemporaryPageKeys,
} from '../utils/pdfTemporaryStorage';

/**
 * #254: ページ削除・並べ替えの IDB I/O を hook 層で担うカスタムフック。
 * pecoStore の deletePages / movePage action は pure state 変換のみを行い、
 * IDB 側副作用はこの hook が責任を持つ。
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

      await deletePages(displayIndices, (filePath, deletedOrigIndices, renamedEntries) => {
        const work = deleteTemporaryPageKeys(filePath, deletedOrigIndices)
          .then(() => renameTemporaryPageKeys(filePath, renamedEntries))
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

      await movePage(fromDisplayIndex, toDisplayIndex, (filePath, renamedEntries) => {
        const work = renameTemporaryPageKeys(filePath, renamedEntries)
          .then(() => {
            useInfraStore.getState().clearLastIdbErrorIfSet();
          })
          .catch((e: unknown) => {
            const err = e instanceof Error ? e : new Error(String(e));
            console.error('[usePageManagement] movePage IDB 同期失敗:', err);
            useInfraStore.getState().setLastIdbError(err);
          });
        trackPendingIdbWork(work);
      });
    }),
    [movePage, enqueuePageOperation],
  );

  return { handleDeletePages, handleMovePage };
}
