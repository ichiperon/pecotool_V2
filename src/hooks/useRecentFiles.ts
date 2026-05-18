import { useEffect, useState } from 'react';

// localStorage ベースの最近開いたファイル一覧。
// issue #37: 以前は sessionStorage を使っていたためアプリ再起動で常に空になり、
// 「最近開いたファイル」機能が実質的に動作していなかった。永続化のため
// localStorage に切替。useFileOperations.ts 側の add/remove も同じ key を見る。
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  useEffect(() => {
    const load = () => {
      // 旧版で sessionStorage 側に残っているエントリは、起動初回に
      // localStorage 側へ移行 (空の場合のみ) して破棄する。常にどちらかが
      // 真実とみなされる状態を作らないように、localStorage が空のときだけ移行。
      const session = sessionStorage.getItem('peco-recent-files');
      const local = localStorage.getItem('peco-recent-files');
      if (session && !local) {
        localStorage.setItem('peco-recent-files', session);
      }
      if (session) {
        sessionStorage.removeItem('peco-recent-files');
      }
      const saved = localStorage.getItem('peco-recent-files');
      if (!saved) {
        setRecentFiles([]);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(saved);
        setRecentFiles(Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : []);
      } catch {
        setRecentFiles([]);
      }
    };

    load();
    window.addEventListener('peco-recent-files-updated', load);
    return () => window.removeEventListener('peco-recent-files-updated', load);
  }, []);

  return { recentFiles, setRecentFiles };
}
