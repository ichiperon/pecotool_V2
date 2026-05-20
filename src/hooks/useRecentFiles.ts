import { useEffect, useState } from 'react';

// localStorage ベースの最近開いたファイル一覧。
// issue #37: 以前は sessionStorage を使っていたためアプリ再起動で常に空になり、
// 「最近開いたファイル」機能が実質的に動作していなかった。永続化のため
// localStorage に切替。useFileOperations.ts 側の add/remove も同じ key を見る。
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  useEffect(() => {
    // issue #81: メイン Window と Preview Window (#preview) は同じバンドルを共有し、
    // 同時起動時に先勝ちで sessionStorage.removeItem が走ると、後発の Window が
    // 移行前データへアクセスできなくなる。Preview/Thumbnails Window は本来
    // Recent Files を表示しないので、ここでは no-op として early return する。
    const hash = window.location.hash;
    if (hash === '#preview' || hash === '#thumbnails') return;

    const load = () => {
      // 旧版で sessionStorage 側に残っているエントリは、localStorage 側が
      // 空のときだけ移行 (どちらかが真実とみなされる状態を作らないため)。
      // 移行後は sessionStorage を破棄する。
      // issue #81: localStorage 書き込みが成功した場合のみ sessionStorage を削除する。
      // QuotaExceededError 等で失敗した場合に sessionStorage を消すと、データが
      // どこにも残らなくなるため。
      const session = sessionStorage.getItem('peco-recent-files');
      const local = localStorage.getItem('peco-recent-files');
      let migrated = false;
      if (session && !local) {
        try {
          localStorage.setItem('peco-recent-files', session);
          migrated = true;
        } catch (e) {
          console.warn('[useRecentFiles] migration to localStorage failed:', e);
        }
      }
      // 既に local 側に値があった場合は session を消してよい (どちらも真実候補
      // になる状態を避けるため)。migration が成功した場合も session は不要。
      if (session && (local || migrated)) {
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
