import { useEffect, useState } from 'react';

// sessionStorage ベースの最近開いたファイル一覧（機密漏えい回避のため localStorage を使わない）
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  useEffect(() => {
    // 旧バージョンで localStorage に平文保存された Recent Files を削除（機密情報のため）
    if (localStorage.getItem('peco-recent-files')) {
      localStorage.removeItem('peco-recent-files');
    }
    const saved = sessionStorage.getItem('peco-recent-files');
    if (saved) setRecentFiles(JSON.parse(saved));
  }, []);

  return { recentFiles, setRecentFiles };
}
