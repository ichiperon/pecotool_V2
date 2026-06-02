import { useCallback } from 'react';
import { usePecoStore, waitForPendingIdbSaves } from '../store/pecoStore';
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
  const setLastIdbError = useCallback(
    (err: Error | null) => usePecoStore.setState({ lastIdbError: err }),
    [],
  );

  const handleDeletePages = useCallback(
    async (displayIndices: number[]) => {
      await waitForPendingIdbSaves();

      await deletePages(displayIndices, (filePath, deletedOrigIndices, renamedEntries) => {
        void deleteTemporaryPageKeys(filePath, deletedOrigIndices)
          .then(() => renameTemporaryPageKeys(filePath, renamedEntries))
          .then(() => {
            if (usePecoStore.getState().lastIdbError) setLastIdbError(null);
          })
          .catch((e: unknown) => {
            const err = e instanceof Error ? e : new Error(String(e));
            console.error('[usePageManagement] deletePages IDB 同期失敗:', err);
            setLastIdbError(err);
          });
      });
    },
    [deletePages, setLastIdbError],
  );

  const handleMovePage = useCallback(
    async (fromDisplayIndex: number, toDisplayIndex: number) => {
      await waitForPendingIdbSaves();

      await movePage(fromDisplayIndex, toDisplayIndex, (filePath, renamedEntries) => {
        void renameTemporaryPageKeys(filePath, renamedEntries)
          .then(() => {
            if (usePecoStore.getState().lastIdbError) setLastIdbError(null);
          })
          .catch((e: unknown) => {
            const err = e instanceof Error ? e : new Error(String(e));
            console.error('[usePageManagement] movePage IDB 同期失敗:', err);
            setLastIdbError(err);
          });
      });
    },
    [movePage, setLastIdbError],
  );

  return { handleDeletePages, handleMovePage };
}
