import { useEffect, useState } from 'react';

// sessionStorage ベースの最近開いたファイル一覧（機密漏えい回避のため localStorage を使わない）
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  useEffect(() => {
    const load = () => {
      // 旧バージョンで localStorage に平文保存された Recent Files を削除（機密情報のため）
      if (localStorage.getItem('peco-recent-files')) {
        localStorage.removeItem('peco-recent-files');
      }
      const saved = sessionStorage.getItem('peco-recent-files');
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
